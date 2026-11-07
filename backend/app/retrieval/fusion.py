"""Reciprocal Rank Fusion (Cormack et al., 2009) with optional per-list weights."""
from __future__ import annotations

from collections import defaultdict


def reciprocal_rank_fusion(ranked_lists: list[list[str]], k: int = 60,
                           weights: list[float] | None = None) -> list[tuple[str, float]]:
    scores: dict[str, float] = defaultdict(float)
    weights = weights or [1.0] * len(ranked_lists)
    for lst, w in zip(ranked_lists, weights):
        for rank, item in enumerate(lst):
            scores[item] += w / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


def weighted_score_fusion(score_lists: list[list[tuple[str, float]]], weights: list[float]) -> list[tuple[str, float]]:
    """Min-max normalize each list, then weighted sum (alternative to RRF)."""
    out: dict[str, float] = defaultdict(float)
    for lst, w in zip(score_lists, weights):
        if not lst:
            continue
        vals = [s for _, s in lst]
        lo, hi = min(vals), max(vals)
        for item, s in lst:
            out[item] += w * ((s - lo) / (hi - lo) if hi > lo else 1.0)
    return sorted(out.items(), key=lambda x: x[1], reverse=True)
