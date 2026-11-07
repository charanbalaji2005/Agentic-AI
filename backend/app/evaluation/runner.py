"""Evaluation runner over a custom dataset; also exports Ragas-compatible records.

Dataset item: {"question": str, "expected_sources": ["file.pdf", ...], "ground_truth": str?, "kb_id": "default"}
Relevance is judged at the source (file name) level, so datasets survive re-chunking.
"""
from __future__ import annotations

import time

from app.core.schemas import new_id
from app.evaluation import metrics as M
from app.memory.db import EvalRun, SessionLocal
from app.models.manager import get_models
from app.orchestration.graph import run_agentic_rag
from app.retrieval.hybrid import HybridRetriever, RetrievalOptions
from app.retrieval.knowledge_base import kb_registry


async def run_eval(name: str, items: list[dict], k: int = 5, generate: bool = True) -> dict:
    retriever = HybridRetriever()
    per_item, ragas = [], []
    for it in items:
        kb = kb_registry.get(it.get("kb_id", "default"))
        rel = set(it.get("expected_sources", []))
        t0 = time.time()
        hits = await retriever.retrieve(it["question"], [kb], RetrievalOptions(top_k=max(k, 10)))
        r_ms = int((time.time() - t0) * 1000)
        ranked = []
        for h in hits:  # source-level ranking (first occurrence)
            if h.chunk.file_name not in ranked:
                ranked.append(h.chunk.file_name)
        row = {"question": it["question"], "retrieved": ranked[:k], "retrieval_ms": r_ms,
               "recall@k": M.recall_at_k(ranked, rel, k), "precision@k": M.precision_at_k(ranked, rel, k),
               "mrr": M.mrr(ranked, rel), "ndcg@k": M.ndcg_at_k(ranked, rel, k),
               "context_precision": M.context_precision(ranked, rel),
               "context_recall": M.recall_at_k(ranked, rel, len(ranked) or 1)}
        if generate and get_models().generator.model is not None:
            t1 = time.time()
            final = await run_agentic_rag(it["question"], user_id="eval", kb_ids=[kb.kb_id], history=[],
                                          filters=None, emit=None)
            ans = final.get("answer", "")
            rr = get_models().reranker
            row.update({
                "answer": ans,
                "faithfulness": final.get("validation", {}).get("supported_ratio", 0.0),
                "answer_relevancy": rr.score(it["question"], [ans])[0] if rr.model and ans else 0.0,
                "citation_correctness": M.citation_correctness(
                    [c["source"] for c in final.get("citations", [])], rel),
                "generation_ms": int((time.time() - t1) * 1000),
                "output_tokens": final.get("timings", {}).get("output_tokens", 0)})
            ragas.append({"user_input": it["question"], "response": ans,
                          "retrieved_contexts": [e.content for e in final.get("selected", [])],
                          "reference": it.get("ground_truth", "")})
        per_item.append(row)
    keys = [k_ for k_ in per_item[0] if isinstance(per_item[0][k_], (int, float))] if per_item else []
    summary = {k_: M.mean([r[k_] for r in per_item if k_ in r]) for k_ in keys}
    m = get_models()
    config = {"k": k, "llm": m.generator.status.name, "embedder": m.embedder.status.name,
              "reranker": m.reranker.status.name}
    run = EvalRun(id=new_id("ev_"), name=name, config=config, metrics=summary, per_item=per_item)
    async with SessionLocal() as db:
        db.add(run)
        await db.commit()
    return {"id": run.id, "name": name, "config": config, "metrics": summary, "per_item": per_item,
            "ragas_records": ragas}
