"""Hybrid retrieval: multi-query + HyDE → dense & BM25 → RRF → cross-encoder rerank → parent expansion."""
from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from app.core.config import get_settings
from app.core.logging import log
from app.core.schemas import Chunk
from app.models.manager import get_models
from app.retrieval.fusion import reciprocal_rank_fusion
from app.retrieval.knowledge_base import KnowledgeBase


@dataclass
class RetrievedChunk:
    chunk: Chunk
    kb_id: str
    fused_score: float
    rerank_score: float | None = None
    matched_by: set[str] = field(default_factory=set)

    @property
    def context_text(self) -> str:
        return self.chunk.parent_text or self.chunk.text


@dataclass
class RetrievalOptions:
    top_k: int | None = None
    filters: dict[str, Any] | None = None
    multi_query: bool = True
    hyde: bool | None = None
    rerank: bool = True
    parent_expansion: bool = True


class HybridRetriever:
    def __init__(self):
        self.s = get_settings()
        self.m = get_models()

    async def expand_queries(self, query: str, n: int) -> list[str]:
        """Query rewriting + multi-query expansion via the local LLM or Groq fast model."""
        if n <= 0 or not self.m.generator.is_ready:
            return []
        try:
            data = await self.m.generator.generate_json([
                {"role": "system", "content": "You rewrite search queries. Reply with JSON only."},
                {"role": "user", "content": f'Write {n} diverse search queries that would retrieve passages '
                 f'answering the question. Use synonyms and specific terms.\nQuestion: {query}\n'
                 f'JSON: {{"queries": ["..."]}}'}], task="fast", max_new_tokens=200)
            return [q for q in data.get("queries", []) if isinstance(q, str) and q.strip()][:n]
        except Exception as e:  # noqa: BLE001
            log.warning("retrieval.expand_failed", error=str(e))
            return []

    async def hyde(self, query: str) -> str | None:
        if not self.m.generator.is_ready:
            return None
        try:
            return await self.m.generator.generate([
                {"role": "system", "content": "Write a short factual passage (<=120 words) that would answer "
                 "the question, as it might appear in documentation. No preamble."},
                {"role": "user", "content": query}], task="fast", max_new_tokens=180, temperature=0)
        except Exception as e:  # noqa: BLE001
            log.warning("retrieval.hyde_failed", error=str(e))
            return None

    async def retrieve(self, query: str, kbs: list[KnowledgeBase],
                       opts: RetrievalOptions | None = None) -> list[RetrievedChunk]:
        opts = opts or RetrievalOptions()
        top_k = opts.top_k or self.s.rerank_top_k
        use_hyde = self.s.use_hyde if opts.hyde is None else opts.hyde
        kbs = [kb for kb in kbs if kb.chunks]
        if not kbs:
            return []

        extra, hyde_doc = await asyncio.gather(
            self.expand_queries(query, self.s.multi_query_count) if opts.multi_query else _none_list(),
            self.hyde(query) if use_hyde else _none(),
        )
        queries = [query] + extra
        ranked_lists: list[list[str]] = []
        weights: list[float] = []
        matched: dict[str, set[str]] = defaultdict(set)
        owner: dict[str, KnowledgeBase] = {}

        def run_search():
            emb = self.m.embedder
            for kb in kbs:
                allowed = kb.filter_ids(opts.filters)
                for i, q in enumerate(queries):
                    w = 1.0 if i == 0 else 0.7
                    dense = kb.vectors.search(emb.embed_query(q), self.s.dense_top_k, allowed)
                    sparse = kb.bm25.search(q, self.s.sparse_top_k, allowed)
                    for name, res in (("dense", dense), ("bm25", sparse)):
                        ids = [cid for cid, _ in res if cid in kb.chunks]
                        ranked_lists.append(ids)
                        weights.append(w)
                        for cid in ids:
                            matched[cid].add(name if i == 0 else f"{name}:rewrite")
                            owner[cid] = kb
                if hyde_doc:  # HyDE: embed hypothetical answer as a *document*
                    vec = emb.embed_documents([hyde_doc])[0]
                    ids = [cid for cid, _ in kb.vectors.search(vec, self.s.dense_top_k, allowed) if cid in kb.chunks]
                    ranked_lists.append(ids)
                    weights.append(0.8)
                    for cid in ids:
                        matched[cid].add("hyde")
                        owner[cid] = kb

        await asyncio.to_thread(run_search)
        fused = reciprocal_rank_fusion(ranked_lists, self.s.rrf_k, weights)[: max(top_k * 4, 24)]
        results = [RetrievedChunk(owner[cid].chunks[cid], owner[cid].kb_id, score, matched_by=matched[cid])
                   for cid, score in fused]

        if opts.rerank and results and self.m.reranker.model is not None:
            scores = await asyncio.to_thread(self.m.reranker.score, query, [r.chunk.text for r in results])
            for r, sc in zip(results, scores):
                r.rerank_score = sc
            results.sort(key=lambda r: r.rerank_score or 0, reverse=True)
            results = [r for r in results if (r.rerank_score or 0) >= self.s.rerank_min_score] or results[:2]

        if opts.parent_expansion:  # parent-child: keep the best child per parent, return the parent text
            seen, deduped = set(), []
            for r in results:
                key = r.chunk.parent_id or r.chunk.chunk_id
                if key not in seen:
                    seen.add(key)
                    deduped.append(r)
            results = deduped
        return results[:top_k]


async def _none():
    return None


async def _none_list():
    return []
