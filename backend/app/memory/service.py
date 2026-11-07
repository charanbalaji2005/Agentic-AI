"""Short-term (conversation window + summary, Redis-cached) and long-term (user-approved) memory."""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

import numpy as np
from sqlalchemy import delete, select

from app.core.config import get_settings
from app.core.logging import log
from app.core.schemas import new_id
from app.memory.db import Conversation, MemoryItem, Message, SessionLocal, ToolLog
from app.models.manager import get_models

SENSITIVE = re.compile(
    r"(\b\d{3}-\d{2}-\d{4}\b|\b(?:\d[ -]?){13,16}\b|password|passwd|api[_ -]?key|secret|token|"
    r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|AKIA[0-9A-Z]{16}|-----BEGIN)", re.I)
REMEMBER = re.compile(r"\b(remember that|please remember|note that i|i prefer|my preference is|always use)\b", re.I)


def is_sensitive(text: str) -> bool:
    return bool(SENSITIVE.search(text))


class Cache:
    """Optional Redis cache for the short-term window; transparently no-op without REDIS_URL."""

    def __init__(self):
        self.r = None
        url = get_settings().redis_url
        if url:
            try:
                import redis.asyncio as redis
                self.r = redis.from_url(url, decode_responses=True)
            except Exception as e:  # noqa: BLE001
                log.warning("redis.unavailable", error=str(e))

    async def get(self, key: str):
        if not self.r:
            return None
        try:
            v = await self.r.get(key)
            return json.loads(v) if v else None
        except Exception:  # noqa: BLE001
            return None

    async def set(self, key: str, value, ttl: int = 3600):
        if self.r:
            try:
                await self.r.set(key, json.dumps(value), ex=ttl)
            except Exception:  # noqa: BLE001
                pass

    async def delete(self, key: str):
        if self.r:
            try:
                await self.r.delete(key)
            except Exception:  # noqa: BLE001
                pass


cache = Cache()


class MemoryService:
    WINDOW = 12

    # ---- conversations / short-term ---------------------------------------------
    async def ensure_conversation(self, conv_id: str | None, user_id: str, first_message: str) -> str:
        async with SessionLocal() as db:
            if conv_id and await db.get(Conversation, conv_id):
                return conv_id
            cid = conv_id or new_id("c_")
            db.add(Conversation(id=cid, user_id=user_id, title=first_message[:80]))
            await db.commit()
            return cid

    async def add_message(self, conv_id: str, role: str, content: str, citations=None, trace=None) -> str:
        mid = new_id("m_")
        async with SessionLocal() as db:
            db.add(Message(id=mid, conversation_id=conv_id, role=role, content=content,
                           citations=citations, trace=trace))
            conv = await db.get(Conversation, conv_id)
            if conv:
                conv.updated_at = datetime.now(timezone.utc)
            await db.commit()
        await cache.delete(f"win:{conv_id}")
        return mid

    async def window(self, conv_id: str) -> list[dict]:
        cached = await cache.get(f"win:{conv_id}")
        if cached is not None:
            return cached
        async with SessionLocal() as db:
            rows = (await db.execute(select(Message).where(Message.conversation_id == conv_id)
                                     .order_by(Message.created_at.desc()).limit(self.WINDOW))).scalars().all()
            conv = await db.get(Conversation, conv_id)
        msgs = [{"role": m.role, "content": m.content} for m in reversed(rows)]
        if conv and conv.summary:
            msgs.insert(0, {"role": "system", "content": f"Earlier conversation summary: {conv.summary}"})
        await cache.set(f"win:{conv_id}", msgs)
        return msgs

    async def maybe_summarize(self, conv_id: str):
        """Rolling summary once the conversation outgrows the window."""
        gen = get_models().generator
        async with SessionLocal() as db:
            rows = (await db.execute(select(Message).where(Message.conversation_id == conv_id)
                                     .order_by(Message.created_at))).scalars().all()
            if len(rows) <= self.WINDOW or gen.model is None:
                return
            older = rows[:-self.WINDOW]
            text = "\n".join(f"{m.role}: {m.content[:600]}" for m in older[-20:])
            summary = await gen.generate([{"role": "system", "content": "Summarize the conversation in <=120 words, "
                                           "keeping decisions, facts and open questions. Omit personal data."},
                                          {"role": "user", "content": text}], max_new_tokens=200, temperature=0)
            conv = await db.get(Conversation, conv_id)
            conv.summary = summary
            await db.commit()
        await cache.delete(f"win:{conv_id}")

    async def list_conversations(self, user_id: str):
        async with SessionLocal() as db:
            rows = (await db.execute(select(Conversation).where(Conversation.user_id == user_id)
                                     .order_by(Conversation.updated_at.desc()).limit(100))).scalars().all()
        return [{"id": c.id, "title": c.title, "updated_at": c.updated_at.isoformat()} for c in rows]

    async def messages(self, conv_id: str):
        async with SessionLocal() as db:
            rows = (await db.execute(select(Message).where(Message.conversation_id == conv_id)
                                     .order_by(Message.created_at))).scalars().all()
        return [{"id": m.id, "role": m.role, "content": m.content, "citations": m.citations, "trace": m.trace,
                 "created_at": m.created_at.isoformat()} for m in rows]

    async def delete_conversation(self, conv_id: str):
        async with SessionLocal() as db:
            await db.execute(delete(Message).where(Message.conversation_id == conv_id))
            await db.execute(delete(Conversation).where(Conversation.id == conv_id))
            await db.commit()
        await cache.delete(f"win:{conv_id}")

    # ---- long-term ---------------------------------------------------------------
    async def add_memory(self, user_id: str, content: str, kind: str = "fact", status: str = "active",
                         importance: float = 0.5, ttl_days: int | None = None, conv_id: str | None = None,
                         allow_sensitive: bool = False) -> dict:
        if is_sensitive(content) and not allow_sensitive:
            raise ValueError("This looks like sensitive data (credentials, email, card or ID number) and was not saved")
        emb = get_models().embedder.embed_documents([content])[0].tolist() if get_models().embedder.model else None
        item = MemoryItem(id=new_id("mem_"), user_id=user_id, kind=kind, content=content, status=status,
                          embedding=emb, importance=importance, source_conversation=conv_id,
                          expires_at=datetime.now(timezone.utc) + timedelta(days=ttl_days) if ttl_days else None)
        async with SessionLocal() as db:
            db.add(item)
            await db.commit()
        return self._out(item)

    async def propose_from_message(self, user_id: str, text: str, conv_id: str) -> dict | None:
        """Explicit 'remember…/I prefer…' statements become *proposed* memories the user must approve."""
        if not REMEMBER.search(text) or is_sensitive(text):
            return None
        return await self.add_memory(user_id, text.strip()[:500], kind="preference", status="proposed",
                                     conv_id=conv_id)

    async def recall(self, user_id: str, query: str, k: int = 4, min_sim: float = 0.45) -> list[dict]:
        emb = get_models().embedder
        if emb.model is None:
            return []
        q = emb.embed_query(query)
        nowt = datetime.now(timezone.utc)
        async with SessionLocal() as db:
            rows = (await db.execute(select(MemoryItem).where(MemoryItem.user_id == user_id,
                                                              MemoryItem.status == "active"))).scalars().all()
            scored = []
            for m in rows:
                if m.expires_at and m.expires_at.replace(tzinfo=m.expires_at.tzinfo or timezone.utc) < nowt:
                    continue
                if not m.embedding:
                    continue
                sim = float(np.dot(q, np.asarray(m.embedding, dtype="float32")))
                score = sim * (0.8 + 0.4 * m.importance)
                if sim >= min_sim:
                    scored.append((score, m))
            scored.sort(key=lambda x: x[0], reverse=True)
            for _, m in scored[:k]:
                m.last_used_at = nowt
            await db.commit()
        return [{**self._out(m), "score": round(s, 3)} for s, m in scored[:k]]

    async def list_memories(self, user_id: str):
        async with SessionLocal() as db:
            rows = (await db.execute(select(MemoryItem).where(MemoryItem.user_id == user_id)
                                     .order_by(MemoryItem.created_at.desc()))).scalars().all()
        return [self._out(m) for m in rows]

    async def update_memory(self, mem_id: str, user_id: str, content: str | None = None, status: str | None = None,
                            importance: float | None = None):
        async with SessionLocal() as db:
            m = await db.get(MemoryItem, mem_id)
            if not m or m.user_id != user_id:
                raise KeyError("Memory not found")
            if content is not None:
                if is_sensitive(content):
                    raise ValueError("This looks like sensitive data and was not saved")
                m.content = content
                if get_models().embedder.model:
                    m.embedding = get_models().embedder.embed_documents([content])[0].tolist()
            if status:
                m.status = status
            if importance is not None:
                m.importance = importance
            await db.commit()
            return self._out(m)

    async def delete_memory(self, mem_id: str, user_id: str):
        async with SessionLocal() as db:
            await db.execute(delete(MemoryItem).where(MemoryItem.id == mem_id, MemoryItem.user_id == user_id))
            await db.commit()

    async def wipe(self, user_id: str):
        async with SessionLocal() as db:
            await db.execute(delete(MemoryItem).where(MemoryItem.user_id == user_id))
            await db.commit()

    @staticmethod
    def _out(m: MemoryItem) -> dict:
        return {"id": m.id, "kind": m.kind, "content": m.content, "status": m.status, "importance": m.importance,
                "created_at": m.created_at.isoformat() if m.created_at else None,
                "expires_at": m.expires_at.isoformat() if m.expires_at else None}

    async def persist_tool_log(self, entry: dict):
        async with SessionLocal() as db:
            db.add(ToolLog(**entry))
            await db.commit()


memory = MemoryService()
