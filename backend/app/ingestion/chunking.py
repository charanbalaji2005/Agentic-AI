"""Chunking strategies: fixed, sliding, recursive, structure-aware, semantic, + parent-child."""
from __future__ import annotations

import re
from typing import Callable

import numpy as np

SEPARATORS = ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " "]
CODE_SEPARATORS = ["\nclass ", "\ndef ", "\nasync def ", "\nfunction ", "\nexport ", "\n\n", "\n", " "]


def fixed_chunks(text: str, size: int, overlap: int = 0) -> list[str]:
    step = max(1, size - overlap)
    return [text[i:i + size] for i in range(0, len(text), step) if text[i:i + size].strip()]


def sliding_window(text: str, size: int, overlap: int) -> list[str]:
    """Word-boundary sliding window."""
    words = text.split()
    if not words:
        return []
    out, cur, i = [], [], 0
    approx = max(1, size // 6)  # ~6 chars/word
    step = max(1, approx - overlap // 6)
    while i < len(words):
        cur = words[i:i + approx]
        out.append(" ".join(cur))
        if i + approx >= len(words):
            break
        i += step
    return out


def recursive_split(text: str, size: int, overlap: int, separators: list[str] | None = None) -> list[str]:
    seps = separators or SEPARATORS
    text = text.strip()
    if len(text) <= size:
        return [text] if text else []
    sep = next((s for s in seps if s in text), "")
    if not sep:
        return fixed_chunks(text, size, overlap)
    parts = text.split(sep)
    chunks, cur = [], ""
    for part in parts:
        piece = part if not cur else cur + sep + part
        if len(piece) <= size:
            cur = piece
            continue
        if cur:
            chunks.append(cur)
        if len(part) > size:
            rest = seps[seps.index(sep) + 1:] if sep in seps else []
            chunks.extend(recursive_split(part, size, overlap, rest or None))
            cur = ""
        else:
            tail = cur[-overlap:] if overlap and cur else ""
            cur = (tail + sep + part) if tail else part
    if cur.strip():
        chunks.append(cur)
    return [c.strip() for c in chunks if c.strip()]


def semantic_split(text: str, size: int, embed: Callable[[list[str]], np.ndarray],
                   breakpoint_percentile: float = 85) -> list[str]:
    """Split where adjacent-sentence embedding distance spikes, then cap by size."""
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    if len(sentences) < 3:
        return recursive_split(text, size, 0)
    vecs = embed(sentences)
    dists = 1 - np.sum(vecs[:-1] * vecs[1:], axis=1)
    threshold = np.percentile(dists, breakpoint_percentile)
    chunks, cur = [], [sentences[0]]
    for sent, d in zip(sentences[1:], dists):
        if d > threshold or len(" ".join(cur)) + len(sent) > size:
            chunks.append(" ".join(cur))
            cur = [sent]
        else:
            cur.append(sent)
    chunks.append(" ".join(cur))
    return chunks


def split(text: str, strategy: str, size: int, overlap: int, content_type: str = "text",
          embed: Callable | None = None) -> list[str]:
    if content_type == "code":
        return recursive_split(text, size, overlap, CODE_SEPARATORS)
    if strategy == "fixed":
        return fixed_chunks(text, size, overlap)
    if strategy == "sliding":
        return sliding_window(text, size, overlap)
    if strategy == "semantic" and embed is not None:
        return semantic_split(text, size, embed)
    # "recursive" and "structure" both split recursively; structure-awareness comes from
    # parsers emitting one Section per heading/page, so chunks never straddle sections.
    return recursive_split(text, size, overlap)


def parent_child(text: str, parent_size: int, child_size: int, overlap: int, strategy: str,
                 content_type: str = "text", embed: Callable | None = None) -> list[tuple[str, list[str]]]:
    """Large parent blocks for generation context, small children for precise matching."""
    parents = recursive_split(text, parent_size, 0,
                              CODE_SEPARATORS if content_type == "code" else None)
    return [(p, split(p, strategy, child_size, overlap, content_type, embed)) for p in parents]
