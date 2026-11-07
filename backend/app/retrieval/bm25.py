"""BM25 sparse retrieval with an identifier-aware tokenizer (keeps snake_case, dotted.names, v1.2.3)."""
from __future__ import annotations

import re

from rank_bm25 import BM25Okapi

TOKEN = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.\-/]*[A-Za-z0-9_]|[A-Za-z0-9_]")
STOP = set("a an the of to in on for and or is are was were be been it this that with as at by from".split())


def tokenize(text: str) -> list[str]:
    toks = []
    for t in TOKEN.findall(text.lower()):
        if t in STOP:
            continue
        toks.append(t)
        if any(c in t for c in "._-/"):  # also index the parts of compound identifiers
            toks.extend(p for p in re.split(r"[._\-/]", t) if p and p not in STOP)
    return toks


class BM25Index:
    def __init__(self):
        self.ids: list[str] = []
        self.bm25: BM25Okapi | None = None

    def build(self, ids: list[str], texts: list[str]) -> None:
        self.ids = list(ids)
        corpus = [tokenize(t) for t in texts]
        self.bm25 = BM25Okapi(corpus) if corpus else None

    def search(self, query: str, k: int, allowed_ids: set[str] | None = None) -> list[tuple[str, float]]:
        if not self.bm25:
            return []
        scores = self.bm25.get_scores(tokenize(query))
        ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
        out = []
        for i in ranked:
            if scores[i] <= 0:
                break
            if allowed_ids is None or self.ids[i] in allowed_ids:
                out.append((self.ids[i], float(scores[i])))
            if len(out) >= k:
                break
        return out
