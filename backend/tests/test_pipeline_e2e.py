"""End-to-end: ingest a document, run the full LangGraph workflow, check grounded, validated output.
Models are replaced by small deterministic test doubles so CI needs no GPU or model downloads."""
import hashlib
import re

import numpy as np
import pytest

from app.models.manager import get_models

DIM = 64


def _vec(text: str) -> np.ndarray:
    v = np.zeros(DIM, dtype="float32")
    for w in re.findall(r"\w+", text.lower()):
        v[int(hashlib.md5(w.encode()).hexdigest(), 16) % DIM] += 1
    n = np.linalg.norm(v)
    return v / n if n else v


class FakeEmbedder:
    model = object()
    dim = DIM
    def embed_documents(self, texts, batch_size=32): return np.stack([_vec(t) for t in texts])
    def embed_query(self, t): return _vec(t)


class FakeReranker:
    model = object()
    def score(self, q, passages, batch_size=16):
        qs = set(re.findall(r"\w+", q.lower()))
        return [len(qs & set(re.findall(r"\w+", p.lower()))) / max(1, len(qs)) for p in passages]


class FakeGenerator:
    model = object()
    tokenizer = None
    is_ready = False  # no LLM in tests: skip query rewriting / HyDE paths
    def count_tokens(self, t): return max(1, len(t) // 4)
    async def generate(self, messages, **kw): raise RuntimeError("no LLM in tests")
    async def generate_json(self, messages, **kw): raise RuntimeError("no LLM in tests")
    async def stream(self, messages, **kw):
        for piece in ["The ingestion service retries failed uploads three times ",
                      "with exponential backoff [1]. ", "It also writes to a citation that does not exist [9]."]:
            yield piece


@pytest.mark.asyncio
async def test_full_agentic_pipeline(tmp_path, monkeypatch):
    from app.core.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "data_dir", tmp_path)
    (tmp_path / "indexes").mkdir()
    (tmp_path / "uploads").mkdir()
    m = get_models()
    monkeypatch.setattr(m, "embedder", FakeEmbedder())
    monkeypatch.setattr(m, "reranker", FakeReranker())
    monkeypatch.setattr(m, "generator", FakeGenerator())

    from app.agents.base import registry
    from app.agents.local_rag import LocalRAGAgent
    from app.ingestion.pipeline import ingest_file
    from app.memory.db import init_db
    from app.orchestration.graph import run_agentic_rag
    from app.retrieval.knowledge_base import kb_registry

    await init_db()
    kb_registry.kbs.clear()
    kb_registry.load_existing()
    registry.register(LocalRAGAgent())
    doc = tmp_path / "uploads" / "ops.md"
    doc.write_text("# Operations\n## Retries\nThe ingestion service retries failed uploads three times "
                   "with exponential backoff.\n## Billing\nInvoices are generated monthly.")
    job = await ingest_file(doc, "default")
    assert job["status"] == "indexed", job
    assert (await ingest_file(doc, "default"))["status"] == "duplicate"

    events = []
    async def emit(e, d): events.append(e)
    final = await run_agentic_rag("How many times does ingestion retry failed uploads?", user_id="t",
                                  kb_ids=["default"], history=[], filters=None, emit=emit)

    assert [st.agent for st in final["plan"].steps][0] == "local_rag"
    assert final["selected"] and final["selected"][0].source == "ops.md"
    assert final["selected"][0].locator == "Retries"
    assert final["citations"][0]["source"] == "ops.md"
    v = final["validation"]
    assert v["invalid_citations"] == [9]          # hallucinated citation is caught
    assert v["supported"] >= 1                     # the real claim is supported
    for e in ("plan", "step", "evidence", "context", "token", "validation", "citations"):
        assert e in events
