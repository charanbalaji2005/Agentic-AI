"""Agent 1 — Local knowledge: hybrid RAG over indexed KBs, multi-hop, + filesystem MCP fallback."""
from __future__ import annotations

from app.agents.base import AgentContext, BaseAgent
from app.core.config import get_settings
from app.core.schemas import AgentResult, Evidence, PlanStep, SourceKind
from app.ingestion.chunking import recursive_split
from app.mcp.manager import mcp_manager
from app.models.manager import get_models
from app.retrieval.hybrid import HybridRetriever, RetrievalOptions
from app.retrieval.knowledge_base import kb_registry
from app.security.guards import flag_injection, isolate_untrusted

# Filter keys that KnowledgeBase.filter_ids can actually match (Chunk fields + chunk metadata).
FILTER_KEYS = {"doc_id", "kb_id", "file_name", "page", "heading", "content_type", "doc_title", "language",
               "modified_after", "modified_before"}
# Names the planner LLM tends to invent for those keys.
FILTER_ALIASES = {"document_id": "doc_id", "documentid": "doc_id", "doc": "doc_id", "document": "doc_id",
                  "file": "file_name", "filename": "file_name", "type": "content_type", "title": "doc_title"}


def clean_filters(raw: dict | None) -> dict:
    """Map aliased keys and drop unknown ones. An unknown key matches no chunk, so a single invented
    filter (e.g. {"document_id": ...}) would otherwise silently empty the whole search."""
    out = {}
    for key, val in (raw or {}).items():
        key = FILTER_ALIASES.get(str(key).lower(), key)
        if key in FILTER_KEYS and val not in (None, "", [], {}):
            out[key] = val
    return out


class LocalRAGAgent(BaseAgent):
    name = "local_rag"
    display_name = "Local knowledge"
    description = ("Searches the user's indexed documents (PDF, DOCX, Markdown, code, CSV…) with hybrid "
                   "dense+BM25 retrieval and reranking. Use for anything that may be in their files.")
    color = "#F2766B"
    argument_hints = {"filters": "optional metadata filter, e.g. {\"file_name\": \"spec\", \"content_type\": \"code\"}",
                      "multi_hop": "true when the answer needs facts from two linked passages"}

    def __init__(self):
        self.retriever = HybridRetriever()

    async def run(self, step: PlanStep, ctx: AgentContext) -> AgentResult:
        res = AgentResult(agent=self.name, task_id=step.task_id)
        filters = clean_filters(step.arguments.get("filters") or ctx.filters)
        target_doc_ids = step.arguments.get("doc_ids") or ctx.doc_ids or []
        if isinstance(target_doc_ids, str):
            target_doc_ids = [target_doc_ids]

        # Attached documents are always in scope, even when their knowledge base is not selected
        # in the composer (kb_ids may be empty when the user picks "No docs").
        kb_ids = [k for k in ctx.kb_ids if k in kb_registry.kbs]
        for did in target_doc_ids:
            for kid, kb in kb_registry.kbs.items():
                if did in kb.docs and kid not in kb_ids:
                    kb_ids.append(kid)
        kbs = [kb_registry.get(k) for k in kb_ids]
        if target_doc_ids:  # "what is this pdf" is about the attachment, not the rest of the KB
            filters["doc_id"] = list(target_doc_ids)

        await ctx.emit("agent_status", {"agent": self.name, "task_id": step.task_id, "status": "retrieving",
                                        "detail": f"Hybrid search in {len(kbs)} knowledge base(s)"})
        hits = await self.retriever.retrieve(step.query, kbs, RetrievalOptions(filters=filters if filters else None))

        # If specific documents were attached, directly fetch and prioritize their chunks
        if target_doc_ids:
            known_ids = {h.chunk.chunk_id for h in hits}
            doc_chunks = []
            for kb in kbs:
                for did in target_doc_ids:
                    for c in kb.get_chunks_for_doc(did):
                        if c.chunk_id not in known_ids:
                            doc_chunks.append((kb.kb_id, c))
            if doc_chunks:
                rr = get_models().reranker
                texts = [c.parent_text or c.text for _, c in doc_chunks]
                scores = rr.score(step.query, texts) if rr.model is not None else [0.6] * len(doc_chunks)
                scored = sorted(zip(doc_chunks, scores), key=lambda x: x[1], reverse=True)
                from app.retrieval.hybrid import RetrievedChunk
                for (kb_id, chunk), sc in scored[:12]:
                    hits.insert(0, RetrievedChunk(chunk=chunk, kb_id=kb_id, fused_score=sc, rerank_score=sc,
                                                  matched_by={"attached_document"}))

        # Multi-hop: ask for a bridging follow-up query using what was found, retrieve again.
        if step.arguments.get("multi_hop") and hits and get_models().generator.is_ready:
            ctx_txt = "\n---\n".join(h.chunk.text[:500] for h in hits[:4])
            try:
                hop = await get_models().generator.generate_json([
                    {"role": "system", "content": "Reply with JSON only."},
                    {"role": "user", "content": f"Question: {step.query}\nPassages:\n{ctx_txt}\n\n"
                     'If another search is needed to finish answering (e.g. about an entity named above), '
                     'give it; otherwise null. JSON: {"follow_up": "..." | null}'}], task="fast", max_new_tokens=80)
                fq = hop.get("follow_up")
                if fq:
                    await ctx.emit("agent_status", {"agent": self.name, "task_id": step.task_id,
                                                    "status": "retrieving", "detail": f"Second hop: {fq}"})
                    more = await self.retriever.retrieve(fq, kbs, RetrievalOptions(filters=filters if filters else None, top_k=4))
                    known = {h.chunk.chunk_id for h in hits}
                    hits += [h for h in more if h.chunk.chunk_id not in known]
            except Exception:  # noqa: BLE001
                pass

        if target_doc_ids:
            # Strictly restrict evidence to the attached document(s)
            hits = [h for h in hits if h.chunk.doc_id in target_doc_ids]

        for h in hits:
            c = h.chunk
            loc = ", ".join(x for x in (f"p. {c.page}" if c.page else None, c.heading) if x) or None
            res.evidence.append(Evidence(
                kind=SourceKind.local, content=isolate_untrusted(h.context_text),
                title=c.metadata.get("doc_title") or c.file_name, source=c.file_name, locator=loc,
                agent=self.name, score=h.fused_score, rerank_score=h.rerank_score, reliability=0.85,
                metadata={"chunk_id": c.chunk_id, "doc_id": c.doc_id, "kb_id": h.kb_id, "page": c.page,
                          "heading": c.heading, "matched_by": sorted(h.matched_by),
                          "attached": c.doc_id in target_doc_ids,
                          "injection_flag": flag_injection(h.context_text)}))

        if not res.evidence:
            await self._filesystem_fallback(step, ctx, res)
        res.summary = f"{len(res.evidence)} passages from local sources"
        return res

    async def _filesystem_fallback(self, step: PlanStep, ctx: AgentContext, res: AgentResult):
        """Nothing indexed matched: search file names via the filesystem MCP server and read top hits."""
        search = mcp_manager.find_tool("local", "search_files")
        read = mcp_manager.find_tool("local", "read_text_file", "read_file")
        root = get_settings().upload_dir.resolve()
        if not (search and read):
            return
        terms = [w for w in step.query.split() if len(w) > 3][:3] or [step.query]
        for term in terms:
            out = await mcp_manager.call(search.server, search.name, {"path": str(root), "pattern": term},
                                         actor=self.name)
            res.tool_calls.append({"tool": search.qualified, "arguments": {"pattern": term}, "ok": out.ok,
                                   "error": out.error})
            paths: list[str] = []
            if out.ok and out.content:
                for ln in out.content.splitlines():
                    line = ln.strip()
                    if not line:
                        continue
                    if line.startswith(("/", "\\")) or (len(line) > 2 and line[1] == ":" and line[2] in ("\\", "/")):
                        paths.append(line)
            paths = paths[:2]
            for p in paths:
                f = await mcp_manager.call(read.server, read.name, {"path": p}, actor=self.name)
                res.tool_calls.append({"tool": read.qualified, "arguments": {"path": p}, "ok": f.ok, "error": f.error})
                if not f.ok:
                    continue
                pieces = recursive_split(f.content, 1200, 100)[:40]
                scores = get_models().reranker.score(step.query, pieces) if get_models().reranker.model else [0.0] * len(pieces)
                for txt, sc in sorted(zip(pieces, scores), key=lambda x: x[1], reverse=True)[:2]:
                    res.evidence.append(Evidence(kind=SourceKind.local, content=isolate_untrusted(txt),
                                                 title=p.rsplit("/", 1)[-1], source=p, agent=self.name,
                                                 score=sc, rerank_score=sc, reliability=0.8,
                                                 metadata={"via": "filesystem-mcp"}))
