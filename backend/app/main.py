from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.agents.base import registry
from app.agents.cloud import CloudAgent
from app.agents.local_rag import LocalRAGAgent
from app.agents.web_research import WebResearchAgent
from app.api.routes import chat, export, knowledge, system
from app.core.config import get_settings
from app.core.logging import log, setup_logging
from app.mcp.manager import mcp_manager
from app.memory.db import init_db
from app.memory.service import memory
from app.models.manager import get_models
from app.retrieval.knowledge_base import kb_registry
from app.security.guards import require_api_key


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    setup_logging(s.log_level)
    try:
        await init_db()
    except Exception as e:
        log.error("db.init_failed", error=str(e))

    m = get_models()
    try:
        # The embedder defines index dimensions, so it loads before knowledge bases open.
        await asyncio.to_thread(m.embedder.load)
    except Exception as e:
        log.error("embedder.init_failed", error=str(e))

    try:
        kb_registry.load_existing()
    except Exception as e:
        log.error("kb.init_failed", error=str(e))

    for agent in (LocalRAGAgent(), WebResearchAgent(), CloudAgent()):
        registry.register(agent)

    try:
        mcp_manager.log_sink = memory.persist_tool_log
        mcp_manager.load_config()
        asyncio.create_task(mcp_manager.connect_all())
    except Exception as e:
        log.error("mcp.init_failed", error=str(e))

    asyncio.create_task(asyncio.to_thread(_safe_load_reranker))
    asyncio.create_task(asyncio.to_thread(_safe_load_generator))  # large: load in background
    log.info("app.started", llm=s.llm_model, embedder=s.embedding_model, reranker=s.reranker_model)
    yield
    await mcp_manager.shutdown()


def _safe_load_reranker():
    try:
        s = get_settings()
        if s.reranker_model and s.reranker_model.lower() not in ("none", "false", "off", ""):
            get_models().reranker.load()
    except Exception as e:  # noqa: BLE001
        log.warning("reranker.safe_load_failed", error=str(e))


def _safe_load_generator():
    try:
        get_models().generator.load()
    except Exception:  # noqa: BLE001  status endpoint exposes the error
        pass


app = FastAPI(title="Agentic RAG", version="1.0.0", lifespan=lifespan)
s = get_settings()
app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

_buckets: dict[str, list[float]] = defaultdict(list)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    """Simple sliding-window limit: 120 requests/min per client on /api."""
    if request.url.path.startswith("/api"):
        ip = request.client.host if request.client else "?"
        nowt = time.time()
        b = [t for t in _buckets[ip] if nowt - t < 60]
        if len(b) >= 120:
            return JSONResponse({"detail": "Rate limit exceeded"}, status_code=429)
        b.append(nowt)
        _buckets[ip] = b
    return await call_next(request)


deps = [Depends(require_api_key)]
app.include_router(chat.router, dependencies=deps)
app.include_router(knowledge.router, dependencies=deps)
app.include_router(system.router, dependencies=deps)
app.include_router(export.router, dependencies=deps)


@app.get("/health")
async def health():
    try:
        m = get_models().status()
        return {
            "status": "ok",
            "generator": m["generator"]["state"],
            "embedder": m["embedder"]["state"],
            "reranker": m["reranker"]["state"],
            "mcp": {n: c.status for n, c in mcp_manager.conns.items()},
        }
    except Exception as e:
        return {"status": "ok", "warning": str(e)}
