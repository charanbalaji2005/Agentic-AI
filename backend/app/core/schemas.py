"""Typed contracts shared by agents, retrieval, orchestration and the API."""
from __future__ import annotations

import uuid
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


def new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:12]}"


class Chunk(BaseModel):
    chunk_id: str = Field(default_factory=lambda: new_id("ch_"))
    doc_id: str
    kb_id: str
    text: str                      # child text (what is embedded / matched)
    parent_id: str | None = None   # parent chunk id for parent-child retrieval
    parent_text: str | None = None
    file_name: str
    file_path: str
    page: int | None = None
    heading: str | None = None
    content_type: str = "text"
    position: int = 0
    created_at: str | None = None
    modified_at: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SourceKind(str, Enum):
    local = "local"
    web = "web"
    cloud = "cloud"
    memory = "memory"
    tool = "tool"


class Evidence(BaseModel):
    """A normalized piece of evidence any agent can return. Always traceable to a source."""
    evidence_id: str = Field(default_factory=lambda: new_id("ev_"))
    kind: SourceKind
    content: str
    title: str
    source: str                     # file path, URL, or server/tool identifier
    locator: str | None = None      # "p. 4 · §Install", URL fragment, resource ARN …
    agent: str
    score: float = 0.0              # retrieval score (agent-local)
    rerank_score: float | None = None
    reliability: float = 0.7        # prior on source quality (0..1)
    published_at: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class StepStatus(str, Enum):
    pending = "pending"
    running = "running"
    awaiting_approval = "awaiting_approval"
    completed = "completed"
    failed = "failed"
    skipped = "skipped"


class PlanStep(BaseModel):
    task_id: str
    description: str
    agent: str
    query: str
    tools: list[str] = Field(default_factory=list)
    arguments: dict[str, Any] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list)
    status: StepStatus = StepStatus.pending
    result_summary: str | None = None
    error: str | None = None


class Plan(BaseModel):
    intent: Literal["question", "research", "cloud_ops", "chitchat", "document_task", "math", "direct", "code"] = "question"
    rationale: str = ""  # one-line, user-visible summary (not chain-of-thought)
    steps: list[PlanStep] = Field(default_factory=list)


class AgentResult(BaseModel):
    agent: str
    task_id: str
    evidence: list[Evidence] = Field(default_factory=list)
    summary: str = ""
    tool_calls: list[dict[str, Any]] = Field(default_factory=list)
    pending_approvals: list[str] = Field(default_factory=list)
    error: str | None = None


class Citation(BaseModel):
    index: int
    evidence_id: str
    title: str
    source: str
    locator: str | None = None
    kind: SourceKind
    snippet: str


class ClaimCheck(BaseModel):
    sentence: str
    cited: list[int]
    supported: bool
    support_score: float
    inherited: bool = False  # citations taken from the sentence's bullet/paragraph or section
    matched: bool = False    # the answer gave no citation; `cited` is the best-matching source
