"""Upload / folder → parse → clean → structure-aware parent-child chunking → contextual headers → index."""
from __future__ import annotations

import asyncio
import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.core.logging import log
from app.core.schemas import Chunk, new_id
from app.ingestion.chunking import parent_child
from app.ingestion.parsers import SUPPORTED, parse_file
from app.models.manager import get_models
from app.retrieval.knowledge_base import kb_registry


def clean(text: str) -> str:
    text = text.replace("\x00", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)  # de-hyphenate PDF line breaks
    return text.strip()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


class IngestionJobs:
    def __init__(self):
        self.jobs: dict[str, dict[str, Any]] = {}

    def create(self, file_name: str, kb_id: str) -> str:
        jid = new_id("job_")
        self.jobs[jid] = {"job_id": jid, "file_name": file_name, "kb_id": kb_id, "status": "queued",
                          "error": None, "doc_id": None, "chunks": 0,
                          "created_at": datetime.now(timezone.utc).isoformat()}
        return jid

    def update(self, jid: str, **kw):
        self.jobs[jid].update(kw)

    def list(self) -> list[dict]:
        return sorted(self.jobs.values(), key=lambda j: j["created_at"], reverse=True)[:200]


jobs = IngestionJobs()


def build_chunks(path: Path, kb_id: str, doc_id: str) -> tuple[str, list[Chunk]]:
    s = get_settings()
    parsed = parse_file(path)
    stat = path.stat()
    created = datetime.fromtimestamp(stat.st_ctime, timezone.utc).isoformat()
    modified = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
    embed = get_models().embedder.embed_documents if s.chunk_strategy == "semantic" else None
    chunks: list[Chunk] = []
    pos = 0
    for section in parsed.sections:
        text = clean(section.text)
        if not text:
            continue
        for parent_text, children in parent_child(text, s.parent_chunk_size, s.chunk_size, s.chunk_overlap,
                                                  s.chunk_strategy, section.content_type, embed):
            parent_id = new_id("pa_")
            for child in children:
                header = " > ".join(x for x in (parsed.title, section.heading) if x)
                if section.page:
                    header += f" (page {section.page})"
                meta = {"doc_title": parsed.title, **parsed.metadata}
                if s.contextual_headers:  # contextual retrieval: situate each chunk in its document
                    meta["contextual_text"] = f"{header}\n{child}"
                chunks.append(Chunk(
                    doc_id=doc_id, kb_id=kb_id, text=child, parent_id=parent_id, parent_text=parent_text,
                    file_name=path.name, file_path=str(path), page=section.page, heading=section.heading,
                    content_type=section.content_type, position=pos, created_at=created,
                    modified_at=modified, metadata=meta))
                pos += 1
    return parsed.title, chunks


async def ingest_file(path: Path, kb_id: str, job_id: str | None = None, replace: bool = True) -> dict:
    job_id = job_id or jobs.create(path.name, kb_id)
    kb = kb_registry.get(kb_id)
    try:
        jobs.update(job_id, status="parsing")
        sha = await asyncio.to_thread(sha256_file, path)
        existing = kb.find_by_hash(sha)
        if existing:
            existing_chunks = len(kb.get_chunks_for_doc(existing))
            jobs.update(job_id, status="duplicate", doc_id=existing, chunks=existing_chunks)
            return jobs.jobs[job_id]
        # incremental update: same file name + new content → replace the old version
        if replace:
            for d, m in list(kb.docs.items()):
                if m.get("file_name") == path.name:
                    await asyncio.to_thread(kb.delete_document, d)
        doc_id = new_id("doc_")
        title, chunks = await asyncio.to_thread(build_chunks, path, kb_id, doc_id)
        jobs.update(job_id, status="embedding", chunks=len(chunks))
        meta = {"doc_id": doc_id, "title": title, "file_name": path.name, "file_path": str(path),
                "sha256": sha, "size": path.stat().st_size, "kb_id": kb_id}
        await asyncio.to_thread(kb.add_document, meta, chunks)
        jobs.update(job_id, status="indexed", doc_id=doc_id)
        log.info("ingest.indexed", file=path.name, kb=kb_id, chunks=len(chunks))
    except Exception as e:  # noqa: BLE001
        jobs.update(job_id, status="failed", error=str(e))
        log.error("ingest.failed", file=path.name, error=str(e))
    return jobs.jobs[job_id]


async def ingest_folder(folder: Path, kb_id: str, recursive: bool = True) -> list[str]:
    pattern = "**/*" if recursive else "*"
    ids = []
    for p in sorted(folder.glob(pattern)):
        if p.is_file() and p.suffix.lower() in SUPPORTED and not any(part.startswith(".") for part in p.parts):
            jid = jobs.create(p.name, kb_id)
            ids.append(jid)
            asyncio.create_task(ingest_file(p, kb_id, jid))
    return ids
