"""Retrieval + generation metrics (pure functions, unit-tested)."""
from __future__ import annotations

import math


def recall_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    return len(set(retrieved[:k]) & relevant) / len(relevant) if relevant else 0.0


def precision_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    top = retrieved[:k]
    return sum(1 for r in top if r in relevant) / len(top) if top else 0.0


def mrr(retrieved: list[str], relevant: set[str]) -> float:
    for i, r in enumerate(retrieved, 1):
        if r in relevant:
            return 1.0 / i
    return 0.0


def ndcg_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    dcg = sum(1.0 / math.log2(i + 1) for i, r in enumerate(retrieved[:k], 1) if r in relevant)
    ideal = sum(1.0 / math.log2(i + 1) for i in range(1, min(len(relevant), k) + 1))
    return dcg / ideal if ideal else 0.0


def context_precision(retrieved: list[str], relevant: set[str]) -> float:
    """Ragas-style: mean precision@i over positions i holding a relevant item."""
    hits, total = 0, 0.0
    for i, r in enumerate(retrieved, 1):
        if r in relevant:
            hits += 1
            total += hits / i
    return total / hits if hits else 0.0


def citation_correctness(cited_sources: list[str], expected: set[str]) -> float:
    return sum(1 for c in cited_sources if c in expected) / len(cited_sources) if cited_sources else 0.0


def mean(xs: list[float]) -> float:
    return round(sum(xs) / len(xs), 4) if xs else 0.0
