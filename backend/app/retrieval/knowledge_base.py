"""Knowledge base = chunk store (JSONL, source of truth) + vector index + BM25 index."""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.core.schemas import Chunk
from app.models.manager import get_models
from app.retrieval.bm25 import BM25Index
from app.retrieval.vector_store import FaissStore, QdrantStore, VectorStore


class KnowledgeBase:
    def __init__(self, kb_id: str, name: str, description: str = ""):
        s = get_settings()
        self.kb_id, self.name, self.description = kb_id, name, description
        self.dir: Path = s.index_dir / kb_id
        self.dir.mkdir(parents=True, exist_ok=True)
        self.chunks: dict[str, Chunk] = {}
        self.docs: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._load()
        dim = get_models().embedder.dim
        self.vectors: VectorStore = (
            QdrantStore(f"kb_{kb_id}", dim, s.qdrant_url, s.qdrant_api_key)
            if s.vector_backend == "qdrant" else FaissStore(self.dir, dim))
        self.bm25 = BM25Index()
        self._rebuild_bm25()

    # ---- persistence ----------------------------------------------------------
    def _load(self):
        cf, df = self.dir / "chunks.jsonl", self.dir / "docs.json"
        if cf.exists():
            for line in cf.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    c = Chunk.model_validate_json(line)
                    self.chunks[c.chunk_id] = c
        if df.exists():
            self.docs = json.loads(df.read_text(encoding="utf-8"))

    def _save(self):
        with (self.dir / "chunks.jsonl").open("w", encoding="utf-8") as f:
            for c in self.chunks.values():
                f.write(c.model_dump_json() + "\n")
        (self.dir / "docs.json").write_text(json.dumps(self.docs, indent=2), encoding="utf-8")
        (self.dir / "kb.json").write_text(json.dumps(
            {"kb_id": self.kb_id, "name": self.name, "description": self.description}), encoding="utf-8")
        self.vectors.persist()

    def _rebuild_bm25(self):
        ids = list(self.chunks)
        self.bm25.build(ids, [self._index_text(self.chunks[i]) for i in ids])

    @staticmethod
    def _index_text(c: Chunk) -> str:
        return c.metadata.get("contextual_text") or c.text

    # ---- mutations ------------------------------------------------------------
    def add_document(self, doc_meta: dict, chunks: list[Chunk]) -> None:
        if not chunks:
            raise ValueError("Document produced no chunks")
        emb = get_models().embedder.embed_documents([self._index_text(c) for c in chunks])
        with self._lock:
            self.vectors.add([c.chunk_id for c in chunks], emb,
                             [{"doc_id": c.doc_id, "kb_id": c.kb_id} for c in chunks])
            for c in chunks:
                self.chunks[c.chunk_id] = c
            self.docs[doc_meta["doc_id"]] = {**doc_meta, "chunks": len(chunks),
                                             "indexed_at": datetime.now(timezone.utc).isoformat()}
            self._rebuild_bm25()
            self._save()

    def delete_document(self, doc_id: str) -> int:
        with self._lock:
            ids = [cid for cid, c in self.chunks.items() if c.doc_id == doc_id]
            self.vectors.delete(ids)
            for cid in ids:
                self.chunks.pop(cid)
            self.docs.pop(doc_id, None)
            self._rebuild_bm25()
            self._save()
            return len(ids)

    def find_by_hash(self, sha: str) -> str | None:
        return next((d for d, m in self.docs.items() if m.get("sha256") == sha), None)

    # ---- filtering ------------------------------------------------------------
    def filter_ids(self, filters: dict[str, Any] | None) -> set[str] | None:
        """Metadata + temporal filtering. Returns None when no filter applies."""
        if not filters:
            return None
        out = set()
        for cid, c in self.chunks.items():
            ok = True
            for key, val in filters.items():
                if key == "modified_after":
                    ok = bool(c.modified_at and c.modified_at >= val)
                elif key == "modified_before":
                    ok = bool(c.modified_at and c.modified_at <= val)
                else:
                    have = getattr(c, key, None) if hasattr(c, key) else c.metadata.get(key)
                    ok = have in val if isinstance(val, list) else (
                        val.lower() in str(have).lower() if key in ("file_name", "heading") and have else have == val)
                if not ok:
                    break
            if ok:
                out.add(cid)
        return out

    def stats(self) -> dict:
        return {"kb_id": self.kb_id, "name": self.name, "description": self.description,
                "documents": len(self.docs), "chunks": len(self.chunks), "vectors": self.vectors.count()}

    def get_document_preview(self, doc_id: str) -> dict | None:
        meta = self.docs.get(doc_id)
        if not meta:
            return None
        doc_chunks = [c for c in self.chunks.values() if c.doc_id == doc_id]
        doc_chunks.sort(key=lambda c: c.position)
        full_text = "\n\n".join(c.text for c in doc_chunks)
        sections = [
            {"chunk_id": c.chunk_id, "position": c.position, "page": c.page,
             "heading": c.heading, "content_type": c.content_type, "text": c.text}
            for c in doc_chunks
        ]
        return {
            **meta,
            "full_text": full_text,
            "sections": sections,
            "chunk_count": len(doc_chunks),
        }

    def get_chunks_for_doc(self, doc_id: str) -> list[Chunk]:
        chunks = [c for c in self.chunks.values() if c.doc_id == doc_id]
        chunks.sort(key=lambda c: c.position)
        return chunks


class KnowledgeBaseRegistry:
    def __init__(self):
        self.kbs: dict[str, KnowledgeBase] = {}

    def load_existing(self):
        for p in get_settings().index_dir.glob("*/kb.json"):
            meta = json.loads(p.read_text(encoding="utf-8"))
            self.kbs[meta["kb_id"]] = KnowledgeBase(meta["kb_id"], meta["name"], meta.get("description", ""))
        if "default" not in self.kbs:
            self.create("default", "Default", "General documents")

    def create(self, kb_id: str, name: str, description: str = "") -> KnowledgeBase:
        if kb_id in self.kbs:
            raise ValueError(f"Knowledge base '{kb_id}' exists")
        kb = KnowledgeBase(kb_id, name, description)
        kb._save()
        self.kbs[kb_id] = kb
        return kb

    def get(self, kb_id: str) -> KnowledgeBase:
        if kb_id not in self.kbs:
            raise KeyError(f"Unknown knowledge base '{kb_id}'")
        return self.kbs[kb_id]


kb_registry = KnowledgeBaseRegistry()
