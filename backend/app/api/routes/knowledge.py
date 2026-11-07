from __future__ import annotations

import re
import shutil
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.core.config import get_settings
from app.ingestion.pipeline import ingest_file, ingest_folder, jobs
from app.retrieval.hybrid import HybridRetriever, RetrievalOptions
from app.retrieval.knowledge_base import kb_registry
from app.security.guards import safe_join, validate_upload

router = APIRouter(prefix="/api/kb", tags=["knowledge"])


class KBCreate(BaseModel):
    kb_id: str
    name: str
    description: str = ""


@router.get("")
async def list_kbs():
    return [kb.stats() for kb in kb_registry.kbs.values()]


@router.post("")
async def create_kb(body: KBCreate):
    if not re.fullmatch(r"[a-z0-9_-]{2,40}", body.kb_id):
        raise HTTPException(400, "kb_id must be 2-40 chars of a-z, 0-9, _ or -")
    try:
        return kb_registry.create(body.kb_id, body.name, body.description).stats()
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


@router.post("/{kb_id}/upload")
async def upload(kb_id: str, background: BackgroundTasks, files: list[UploadFile] = File(...),
                 sync: bool = Query(False, description="Wait for parsing and embedding to complete before returning")):
    kb_registry.get(kb_id)
    dest_dir = get_settings().upload_dir / kb_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    out = []
    for f in files:
        name = Path(f.filename or "file").name
        f.file.seek(0, 2)
        size = f.file.tell()
        f.file.seek(0)
        validate_upload(name, size)
        dest = dest_dir / name
        with dest.open("wb") as w:
            shutil.copyfileobj(f.file, w)
        jid = jobs.create(name, kb_id)
        if sync:
            res = await ingest_file(dest, kb_id, jid)
            out.append({"job_id": jid, "file_name": name, "doc_id": res.get("doc_id"),
                        "chunks": res.get("chunks", 0), "status": res.get("status", "indexed"),
                        "error": res.get("error")})
        else:
            background.add_task(ingest_file, dest, kb_id, jid)
            out.append({"job_id": jid, "file_name": name, "status": "queued"})
    return out


@router.post("/{kb_id}/ingest-folder")
async def ingest_dir(kb_id: str, path: str = Form(...), recursive: bool = Form(True)):
    """Ingest a folder under DATA_DIR/uploads (path traversal is blocked)."""
    kb_registry.get(kb_id)
    folder = safe_join(get_settings().upload_dir, path)
    if not folder.is_dir():
        raise HTTPException(404, "Folder not found")
    return {"jobs": await ingest_folder(folder, kb_id, recursive)}


@router.get("/jobs")
async def list_jobs():
    return jobs.list()


@router.get("/{kb_id}/documents")
async def documents(kb_id: str):
    return list(kb_registry.get(kb_id).docs.values())


@router.delete("/{kb_id}/documents/{doc_id}")
async def delete_document(kb_id: str, doc_id: str):
    return {"deleted_chunks": kb_registry.get(kb_id).delete_document(doc_id)}


@router.post("/{kb_id}/documents/{doc_id}/reindex")
async def reindex(kb_id: str, doc_id: str, background: BackgroundTasks):
    kb = kb_registry.get(kb_id)
    meta = kb.docs.get(doc_id)
    if not meta:
        raise HTTPException(404, "Document not found")
    path = Path(meta["file_path"])
    kb.delete_document(doc_id)
    jid = jobs.create(path.name, kb_id)
    background.add_task(ingest_file, path, kb_id, jid)
    return {"job_id": jid}


@router.get("/{kb_id}/documents/{doc_id}/chunks")
async def chunks(kb_id: str, doc_id: str, limit: int = 200):
    kb = kb_registry.get(kb_id)
    rows = sorted((c for c in kb.chunks.values() if c.doc_id == doc_id), key=lambda c: c.position)[:limit]
    return [c.model_dump(exclude={"parent_text"}) for c in rows]


@router.get("/{kb_id}/documents/{doc_id}/preview")
async def preview_document(kb_id: str, doc_id: str):
    kb = kb_registry.get(kb_id)
    preview = kb.get_document_preview(doc_id)
    if not preview:
        raise HTTPException(404, "Document not found")
    return preview


@router.get("/{kb_id}/documents/{doc_id}/file")
async def document_file(kb_id: str, doc_id: str):
    kb = kb_registry.get(kb_id)
    meta = kb.docs.get(doc_id)
    if not meta or not meta.get("file_path"):
        raise HTTPException(404, "Document file not found")
    path = Path(meta["file_path"])
    if not path.is_file():
        raise HTTPException(404, "Physical file does not exist on server")
    media_type = "application/pdf" if path.suffix.lower() == ".pdf" else "application/octet-stream"
    return FileResponse(path, filename=path.name, media_type=media_type)


class RetrievalTest(BaseModel):
    query: str
    top_k: int = 8
    filters: dict | None = None
    multi_query: bool = True
    hyde: bool = True
    rerank: bool = True


@router.post("/{kb_id}/search")
async def test_search(kb_id: str, body: RetrievalTest):
    hits = await HybridRetriever().retrieve(body.query, [kb_registry.get(kb_id)], RetrievalOptions(
        top_k=body.top_k, filters=body.filters, multi_query=body.multi_query, hyde=body.hyde, rerank=body.rerank))
    return [{"chunk_id": h.chunk.chunk_id, "file_name": h.chunk.file_name, "page": h.chunk.page,
             "heading": h.chunk.heading, "text": h.chunk.text, "fused_score": round(h.fused_score, 5),
             "rerank_score": round(h.rerank_score, 4) if h.rerank_score is not None else None,
             "matched_by": sorted(h.matched_by)} for h in hits]
