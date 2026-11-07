from __future__ import annotations

import asyncio
import json
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.logging import log
from app.core.schemas import new_id
from app.memory.db import QueryMetric, SessionLocal
from app.memory.service import memory
from app.models.manager import get_models
from app.orchestration.graph import run_agentic_rag

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    conversation_id: str | None = None
    kb_ids: list[str] = ["default"]
    doc_ids: list[str] | None = None
    filters: dict | None = None
    user_id: str = "local"
    # Optional model id for writing the answer (Groq provider). Planning, rewrites and
    # validation keep their configured models.
    model: str | None = Field(default=None, max_length=200)


def sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.post("/chat")
async def chat(req: ChatRequest):
    if get_models().generator.status.state != "ready":
        raise HTTPException(503, f"Generator model is {get_models().generator.status.state}. "
                                 "Load it on the Models page.")
    conv_id = await memory.ensure_conversation(req.conversation_id, req.user_id, req.message)
    history = await memory.window(conv_id)
    await memory.add_message(conv_id, "user", req.message)
    queue: asyncio.Queue = asyncio.Queue()
    trace: dict = {"plan": None, "steps": {}, "tool_calls": [], "evidence": [], "iterations": [], "approvals": []}

    async def emit(event: str, data: dict):
        if event == "plan":
            trace["plan"] = data
        elif event == "step":
            trace["steps"][data["task_id"]] = data
        elif event in ("tool_call", "tool_result"):
            trace["tool_calls"].append({"event": event, **data})
        elif event == "evidence":
            trace["evidence"].extend(data["items"])
        elif event == "iteration":
            trace["iterations"].append(data)
        elif event == "approval":
            trace["approvals"].append(data["approval_id"])
        await queue.put((event, data))

    async def worker():
        t0 = time.time()
        try:
            final = await run_agentic_rag(req.message, user_id=req.user_id, kb_ids=req.kb_ids,
                                          history=history, filters=req.filters, doc_ids=req.doc_ids, emit=emit,
                                          model=req.model)
            answer = final.get("answer", "")
            trace.update({"validation": final.get("validation"), "claims": final.get("claims"),
                          "conflicts": final.get("conflicts"), "timings": final.get("timings"),
                          "selected": [e.evidence_id for e in final.get("selected", [])]})
            mid = await memory.add_message(conv_id, "assistant", answer, final.get("citations"), trace)
            proposed = await memory.propose_from_message(req.user_id, req.message, conv_id)
            if proposed:
                await queue.put(("memory_proposal", proposed))
            t = final.get("timings", {})
            async with SessionLocal() as db:
                db.add(QueryMetric(
                    id=new_id("q_"), agents=sorted({s.agent for s in final["plan"].steps}),
                    iterations=final.get("iteration", 0) + 1, evidence_count=len(final.get("evidence", [])),
                    top_score=float(final.get("best_score", 0.0)),
                    supported_ratio=float((final.get("validation") or {}).get("supported_ratio", 1.0)),
                    retrieval_ms=t.get("retrieval_ms", 0), generation_ms=t.get("generation_ms", 0),
                    output_tokens=t.get("output_tokens", 0), insufficient=int(final.get("insufficient", False))))
                await db.commit()
            await queue.put(("done", {"conversation_id": conv_id, "message_id": mid,
                                      "elapsed_ms": int((time.time() - t0) * 1000)}))
            asyncio.create_task(memory.maybe_summarize(conv_id))
        except Exception as e:  # noqa: BLE001
            log.exception("chat.failed")
            await queue.put(("error", {"message": f"{type(e).__name__}: {e}"}))
        finally:
            await queue.put(None)

    async def stream():
        yield sse("conversation", {"conversation_id": conv_id})
        task = asyncio.create_task(worker())
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield sse(*item)
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/conversations")
async def conversations(user_id: str = "local"):
    return await memory.list_conversations(user_id)


@router.get("/conversations/{conv_id}")
async def conversation(conv_id: str):
    return await memory.messages(conv_id)


@router.delete("/conversations/{conv_id}")
async def delete_conversation(conv_id: str):
    await memory.delete_conversation(conv_id)
    return {"deleted": conv_id}
