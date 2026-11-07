"""MCP servers, approvals, agents, models, memory, evaluation and analytics endpoints."""
from __future__ import annotations

import asyncio
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select

from app.agents.base import registry
from app.agents.cloud import MCPToolAgent
from app.evaluation.runner import run_eval
from app.mcp.manager import ServerConfig, mcp_manager
from app.memory.db import EvalRun, QueryMetric, SessionLocal, ToolLog
from app.memory.service import memory
from app.models.manager import get_models
from app.tools.duckduckgo_search import asearch_web

router = APIRouter(prefix="/api", tags=["system"])

# ---------------- MCP ----------------


@router.get("/mcp/servers")
async def servers():
    return mcp_manager.servers()


@router.post("/mcp/servers")
async def upsert_server(cfg: ServerConfig):
    await mcp_manager.upsert_server(cfg)
    return next(s for s in mcp_manager.servers() if s["name"] == cfg.name)


@router.delete("/mcp/servers/{name}")
async def remove_server(name: str):
    await mcp_manager.remove_server(name)
    return {"removed": name}


@router.post("/mcp/servers/{name}/{action}")
async def server_action(name: str, action: Literal["connect", "disconnect", "health"]):
    if name not in mcp_manager.configs:
        raise HTTPException(404, "Unknown server")
    if action == "connect":
        await mcp_manager.connect(name)
    elif action == "disconnect":
        await mcp_manager.disconnect(name)
    else:
        return await mcp_manager.health(name)
    return next(s for s in mcp_manager.servers() if s["name"] == name)


@router.get("/mcp/logs")
async def mcp_logs(limit: int = 200):
    async with SessionLocal() as db:
        rows = (await db.execute(select(ToolLog).order_by(ToolLog.ts.desc()).limit(limit))).scalars().all()
    return [{c.name: getattr(r, c.name) for c in ToolLog.__table__.columns} for r in rows]


@router.get("/approvals")
async def approvals(status: str | None = "pending"):
    return [a for a in mcp_manager.approvals.values() if status is None or a["status"] == status]


@router.post("/approvals/{approval_id}/{decision}")
async def decide(approval_id: str, decision: Literal["approve", "reject"]):
    try:
        return await mcp_manager.resolve_approval(approval_id, decision == "approve")
    except KeyError as e:
        raise HTTPException(404, str(e)) from e

# ---------------- Agents ----------------


@router.get("/agents")
async def agents():
    return [{"name": "aggregator", "display_name": "Aggregator", "color": "#D4A72C", "available": True,
             "description": "Plans, routes, aggregates evidence and writes the grounded answer.",
             "status_detail": "ready", "arguments": {}}] + [a.describe() for a in registry.all()]


class AgentRegistration(BaseModel):
    name: str
    display_name: str
    description: str
    category: str | None = None
    server: str | None = None
    color: str = "#9C8CF0"


@router.post("/agents")
async def register_agent(body: AgentRegistration):
    if body.name in {"aggregator", "local_rag", "web_research", "cloud"}:
        raise HTTPException(409, "That name is reserved")
    registry.register(MCPToolAgent(**body.model_dump()))
    return registry.get(body.name).describe()


@router.delete("/agents/{name}")
async def unregister_agent(name: str):
    if name in {"local_rag", "web_research", "cloud"}:
        raise HTTPException(409, "Built-in agents cannot be removed")
    registry.unregister(name)
    return {"removed": name}

# ---------------- Web search ----------------

_SEARCH_STATUS = {"invalid_input": 422, "rate_limited": 429, "unavailable": 503, "timeout": 504, "error": 502}


@router.get("/tools/web-search")
async def web_search(q: str, max_results: int = 5, region: str | None = None,
                     safesearch: Literal["on", "moderate", "off"] | None = None,
                     timelimit: Literal["d", "w", "m", "y"] | None = None):
    """Run a DuckDuckGo search directly (the web_research agent uses the same function)."""
    out = await asearch_web(q, max_results, region, safesearch, timelimit)
    if out.error_type:
        raise HTTPException(_SEARCH_STATUS[out.error_type], out.error)
    return out.model_dump()

# ---------------- Models ----------------


@router.get("/models")
async def model_status():
    return get_models().status()


_options_cache: dict = {"at": 0.0, "items": None}
_NON_CHAT = ("whisper", "tts", "guard", "embed", "playai", "distil-whisper", "orpheus")


@router.get("/models/options")
async def model_options():
    """Models the composer can pick for writing answers.

    With Groq, the list comes live from Groq's /models (cached 10 min) and always includes the
    configured models. With local Hugging Face models only the loaded generator is offered,
    since switching means loading weights (use the Models page for that).
    """
    import time

    import httpx

    s = get_models().s
    gen = get_models().generator
    if s.llm_provider != "groq" or not s.groq_api_key:
        name = gen.status.name or "local model"
        return {"provider": "hf", "default": name, "switchable": False,
                "items": [{"id": name, "label": name.split("/")[-1], "owner": "local"}]}

    # Highest-priority role wins when one model serves several roles.
    configured: dict[str, str] = {}
    for mid, note in ((s.groq_model_generator, "Default answer model"), (s.groq_model_code, "Code & DSA model"),
                      (s.groq_model_planner, "Planner model"),
                      (s.groq_model_validator, "Validator model"), (s.groq_model_fast, "Fast model")):
        if mid:  # GROQ_MODEL_CODE may be empty
            configured.setdefault(mid, note)
    if _options_cache["items"] is None or time.time() - _options_cache["at"] > 600:
        live: list[dict] = []
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.get(f"{s.groq_base_url.rstrip('/')}/models",
                                     headers={"Authorization": f"Bearer {s.groq_api_key}"})
                r.raise_for_status()
                for m in r.json().get("data", []):
                    mid = m.get("id", "")
                    if not mid or any(x in mid.lower() for x in _NON_CHAT) or m.get("active") is False:
                        continue
                    live.append({"id": mid, "owner": m.get("owned_by") or "", "context": m.get("context_window")})
        except Exception:  # noqa: BLE001  fall back to configured models
            live = []
        _options_cache.update(at=time.time(), items=live)

    items = {m["id"]: m for m in _options_cache["items"] or []}
    for mid in configured:
        items.setdefault(mid, {"id": mid, "owner": mid.split("/")[0] if "/" in mid else ""})
    out = []
    for mid, m in items.items():
        out.append({**m, "label": mid.split("/")[-1], "note": configured.get(mid)})
    # Default first, then other configured models, then the rest alphabetically.
    out.sort(key=lambda m: (m["id"] != s.groq_model_generator, m["id"] not in configured, m["id"]))
    return {"provider": "groq", "default": s.groq_model_generator, "switchable": True, "items": out}


class ModelLoad(BaseModel):
    role: Literal["generator", "embedder", "reranker"]
    name: str
    quantization: Literal["none", "4bit", "8bit"] | None = None


@router.post("/models/load")
async def load_model(body: ModelLoad):
    m = get_models()
    if body.role == "embedder":
        raise HTTPException(409, "Changing the embedding model requires re-indexing: set EMBEDDING_MODEL, "
                                 "clear data/indexes and restart, then re-upload documents.")
    target = m.generator if body.role == "generator" else m.reranker

    async def _load():
        try:
            if body.role == "generator":
                await asyncio.to_thread(target.load, body.name, body.quantization)
            else:
                await asyncio.to_thread(target.load, body.name)
        except Exception:  # noqa: BLE001  status already records the error
            pass

    asyncio.create_task(_load())
    return {"accepted": True, "role": body.role, "name": body.name}


class GenParams(BaseModel):
    temperature: float | None = None
    top_p: float | None = None
    max_new_tokens: int | None = None
    context_token_budget: int | None = None
    rerank_top_k: int | None = None
    max_iterations: int | None = None
    sufficiency_threshold: float | None = None
    use_hyde: bool | None = None
    multi_query_count: int | None = None


@router.get("/settings")
async def get_runtime_settings():
    s = get_models().s
    return {k: getattr(s, k) for k in ("llm_temperature", "llm_top_p", "llm_max_new_tokens", "context_token_budget",
                                       "rerank_top_k", "max_iterations", "sufficiency_threshold", "use_hyde",
                                       "multi_query_count", "chunk_strategy", "chunk_size", "vector_backend")}


@router.patch("/settings")
async def patch_settings(body: GenParams):
    s = get_models().s
    mapping = {"temperature": "llm_temperature", "top_p": "llm_top_p", "max_new_tokens": "llm_max_new_tokens"}
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(s, mapping.get(k, k), v)
    return await get_runtime_settings()

# ---------------- Memory ----------------


class MemoryIn(BaseModel):
    content: str
    kind: Literal["preference", "fact", "task_summary", "project"] = "fact"
    importance: float = 0.5
    ttl_days: int | None = None


class MemoryPatch(BaseModel):
    content: str | None = None
    status: Literal["active", "proposed"] | None = None
    importance: float | None = None


@router.get("/memory")
async def list_memory(user_id: str = "local"):
    return await memory.list_memories(user_id)


@router.post("/memory")
async def add_memory(body: MemoryIn, user_id: str = "local"):
    try:
        return await memory.add_memory(user_id, body.content, body.kind, importance=body.importance,
                                       ttl_days=body.ttl_days)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.patch("/memory/{mem_id}")
async def patch_memory(mem_id: str, body: MemoryPatch, user_id: str = "local"):
    try:
        return await memory.update_memory(mem_id, user_id, body.content, body.status, body.importance)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.delete("/memory/{mem_id}")
async def delete_memory(mem_id: str, user_id: str = "local"):
    await memory.delete_memory(mem_id, user_id)
    return {"deleted": mem_id}


@router.delete("/memory")
async def wipe_memory(user_id: str = "local"):
    await memory.wipe(user_id)
    return {"wiped": True}

# ---------------- Evaluation & analytics ----------------


class EvalRequest(BaseModel):
    name: str = "Evaluation"
    k: int = 5
    generate: bool = True
    items: list[dict]


@router.post("/eval/run")
async def eval_run(body: EvalRequest):
    if not body.items:
        raise HTTPException(400, "Dataset is empty")
    return await run_eval(body.name, body.items, body.k, body.generate)


@router.get("/eval/runs")
async def eval_runs():
    async with SessionLocal() as db:
        rows = (await db.execute(select(EvalRun).order_by(EvalRun.created_at.desc()).limit(50))).scalars().all()
    return [{"id": r.id, "name": r.name, "config": r.config, "metrics": r.metrics,
             "created_at": r.created_at.isoformat(), "items": len(r.per_item)} for r in rows]


@router.get("/analytics")
async def analytics():
    async with SessionLocal() as db:
        q = await db.execute(select(func.count(QueryMetric.id), func.avg(QueryMetric.retrieval_ms),
                                    func.avg(QueryMetric.generation_ms), func.avg(QueryMetric.supported_ratio),
                                    func.avg(QueryMetric.top_score), func.sum(QueryMetric.insufficient),
                                    func.sum(QueryMetric.output_tokens)))
        n, r_ms, g_ms, sup, top, insuf, toks = q.one()
        recent = (await db.execute(select(QueryMetric).order_by(QueryMetric.ts.desc()).limit(50))).scalars().all()
        tools = (await db.execute(select(ToolLog.server, ToolLog.tool, ToolLog.status, func.count())
                                  .group_by(ToolLog.server, ToolLog.tool, ToolLog.status))).all()
    agent_counts: dict[str, int] = {}
    for r in recent:
        for a in r.agents:
            agent_counts[a] = agent_counts.get(a, 0) + 1
    return {"queries": n or 0, "avg_retrieval_ms": int(r_ms or 0), "avg_generation_ms": int(g_ms or 0),
            "avg_supported_ratio": round(sup or 0, 3), "avg_top_score": round(top or 0, 3),
            "insufficient": int(insuf or 0), "output_tokens": int(toks or 0), "agent_usage": agent_counts,
            "tool_usage": [{"server": s, "tool": t, "status": st, "count": c} for s, t, st, c in tools],
            "recent": [{"ts": r.ts.isoformat(), "retrieval_ms": r.retrieval_ms, "generation_ms": r.generation_ms,
                        "supported_ratio": r.supported_ratio, "top_score": r.top_score} for r in reversed(recent)]}
