"""PostgreSQL persistence (SQLite works too for quick local runs: sqlite+aiosqlite:///./data/rag.db)."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.core.config import get_settings


def now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(200), default="New conversation")
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text)
    citations: Mapped[list | None] = mapped_column(JSON, nullable=True)
    trace: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # plan, tool calls, claim checks, timings
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class MemoryItem(Base):
    __tablename__ = "memories"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(24))      # preference | fact | task_summary | project
    content: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="active")  # proposed | active
    embedding: Mapped[list | None] = mapped_column(JSON, nullable=True)
    importance: Mapped[float] = mapped_column(Float, default=0.5)
    source_conversation: Mapped[str | None] = mapped_column(String(32), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ToolLog(Base):
    __tablename__ = "tool_logs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    ts: Mapped[str] = mapped_column(String(40), index=True)
    server: Mapped[str] = mapped_column(String(80))
    tool: Mapped[str] = mapped_column(String(120))
    arguments: Mapped[dict] = mapped_column(JSON)
    actor: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(24))
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)


class QueryMetric(Base):
    __tablename__ = "query_metrics"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    agents: Mapped[list] = mapped_column(JSON)
    iterations: Mapped[int] = mapped_column(Integer)
    evidence_count: Mapped[int] = mapped_column(Integer)
    top_score: Mapped[float] = mapped_column(Float)
    supported_ratio: Mapped[float] = mapped_column(Float)
    retrieval_ms: Mapped[int] = mapped_column(Integer)
    generation_ms: Mapped[int] = mapped_column(Integer)
    output_tokens: Mapped[int] = mapped_column(Integer)
    insufficient: Mapped[int] = mapped_column(Integer, default=0)


class EvalRun(Base):
    __tablename__ = "eval_runs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    config: Mapped[dict] = mapped_column(JSON)
    metrics: Mapped[dict] = mapped_column(JSON)
    per_item: Mapped[list] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


from pathlib import Path
from app.core.logging import log

_settings = get_settings()
_db_url = _settings.database_url
if _db_url.startswith("sqlite"):
    Path("./data").mkdir(parents=True, exist_ok=True)

engine = create_async_engine(_db_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def init_db() -> None:
    global engine, SessionLocal
    # 1. Try to initialize configured database
    try:
        if str(engine.url).startswith("sqlite"):
            Path("./data").mkdir(parents=True, exist_ok=True)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        log.info("db.initialized", url=str(engine.url))
        return
    except Exception as e:
        log.warning("db.initial_connect_failed", error=str(e), msg="Attempting fallback to local SQLite database...")

    # 2. Fallback to local SQLite if PostgreSQL or external host is unreachable
    try:
        Path("./data").mkdir(parents=True, exist_ok=True)
        fallback_url = "sqlite+aiosqlite:///./data/rag.db"
        fallback_engine = create_async_engine(fallback_url)
        async with fallback_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        engine = fallback_engine
        SessionLocal.configure(bind=engine)
        log.info("db.fallback_initialized", url=fallback_url)
    except Exception as e2:
        log.error("db.fallback_failed", error=str(e2))
