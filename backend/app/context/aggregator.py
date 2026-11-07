"""Context aggregation: normalize → global rerank → dedupe → score → conflicts → token-budgeted selection."""
from __future__ import annotations

import asyncio
import re

from app.core.config import get_settings
from app.core.schemas import Evidence
from app.models.manager import get_models


def _shingles(text: str, n: int = 5) -> set[str]:
    words = re.findall(r"\w+", text.lower())
    return {" ".join(words[i:i + n]) for i in range(max(1, len(words) - n + 1))}


def jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def dedupe(evidence: list[Evidence], threshold: float = 0.8) -> list[Evidence]:
    kept: list[tuple[Evidence, set[str]]] = []
    for ev in sorted(evidence, key=lambda e: e.rerank_score or e.score, reverse=True):
        sh = _shingles(ev.content)
        if all(jaccard(sh, s) < threshold for _, s in kept):
            kept.append((ev, sh))
    return [e for e, _ in kept]


def final_score(ev: Evidence) -> float:
    rel = ev.rerank_score if ev.rerank_score is not None else 0.0
    s = 0.75 * rel + 0.25 * ev.reliability
    if ev.metadata.get("injection_flag"):
        s *= 0.5
    if ev.metadata.get("snippet_only"):
        s *= 0.8
    return s


async def rerank_globally(question: str, evidence: list[Evidence]) -> None:
    """Score every piece against the same question so local, web and cloud evidence are comparable."""
    rr = get_models().reranker
    if rr.model is None or not evidence:
        return
    scores = await asyncio.to_thread(rr.score, question, [e.content[:2000] for e in evidence])
    for e, s in zip(evidence, scores):
        e.rerank_score = s


async def detect_conflicts(question: str, evidence: list[Evidence]) -> list[dict]:
    sources = {e.source for e in evidence}
    gen = get_models().generator
    if len(sources) < 2 or gen.model is None:
        return []
    block = "\n".join(f"[{i + 1}] ({e.source}) {e.content[:400]}" for i, e in enumerate(evidence[:6]))
    try:
        data = await gen.generate_json([
            {"role": "system", "content": "You check sources for factual contradictions. JSON only."},
            {"role": "user", "content": f"Question: {question}\nSources:\n{block}\n\nList direct factual "
             'contradictions relevant to the question (different numbers, dates, versions, claims). '
             'JSON: {"conflicts": [{"a": 1, "b": 2, "issue": "<=20 words"}]} — empty list if none.'}],
            max_new_tokens=200)
        out = []
        for c in data.get("conflicts", [])[:4]:
            a, b = int(c["a"]) - 1, int(c["b"]) - 1
            if 0 <= a < len(evidence) and 0 <= b < len(evidence) and a != b:
                out.append({"a": evidence[a].evidence_id, "b": evidence[b].evidence_id, "issue": str(c["issue"])[:200]})
        return out
    except Exception:  # noqa: BLE001
        return []


def select_within_budget(evidence: list[Evidence], budget_tokens: int, per_source: int = 3) -> list[Evidence]:
    gen = get_models().generator
    chosen, used, per = [], 0, {}
    for ev in sorted(evidence, key=final_score, reverse=True):
        # Attached documents skip the per-file cap ("explain this PDF" needs more than 3 passages);
        # the token budget still bounds them.
        if not ev.metadata.get("attached") and per.get(ev.source, 0) >= per_source:
            continue
        cost = gen.count_tokens(ev.content) + 30
        if used + cost > budget_tokens:
            if not chosen and cost > budget_tokens:  # always keep at least the best, truncated
                ev.content = ev.content[: budget_tokens * 3]
                chosen.append(ev)
            continue
        chosen.append(ev)
        used += cost
        per[ev.source] = per.get(ev.source, 0) + 1
    return chosen


async def aggregate(question: str, evidence: list[Evidence]) -> tuple[list[Evidence], list[dict], float]:
    s = get_settings()
    await rerank_globally(question, evidence)
    unique = dedupe(evidence)
    selected = select_within_budget(unique, s.context_token_budget)
    conflicts = await detect_conflicts(question, selected)
    best = max((e.rerank_score or 0.0 for e in selected), default=0.0)
    return selected, conflicts, best
