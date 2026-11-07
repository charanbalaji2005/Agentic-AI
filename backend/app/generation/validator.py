"""Self-RAG-style answer validation: citation existence + claim support.

Claims are extracted from the answer's markdown (list markers, bold, inline code and headings stripped;
headings and "label:" lead-in lines are not claims). A sentence without its own [n] inherits the citations of
its bullet/paragraph, or else of its section, because models usually cite once per point. Support is the
better of two signals against the cited sources:
  * cross-encoder relevance on the source windows that best match the claim (not just the first 2,000 chars);
  * for claims with numbers: every number must appear in the source (rounding-tolerant), scaled by how many
    of the claim's content words the source contains. Cross-encoders are weak on numeric/tabular facts.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.core.config import get_settings
from app.core.schemas import Citation, ClaimCheck, Evidence
from app.models.manager import get_models

CITE = re.compile(r"\[(\d+)\]")
HEDGE = re.compile(r"^(i (cannot|can't|don't)|the sources (do not|don't)|no source|likely|this suggests)", re.I)
FENCE = re.compile(r"^(```|~~~).*?^(```|~~~)[ \t]*$", re.S | re.M)
MATH_BLOCK = re.compile(r"\$\$.*?\$\$", re.S)
HEADING = re.compile(r"^\s{0,3}#{1,6}\s|^\s*(?:[-*+]\s+)?(\*\*|__)[^*_]+\1:?\s*$")  # "# x" or a bold-only line
LIST_PREFIX = re.compile(r"^\s*(?:>\s*)*(?:[-*+•]\s+|\d+[.)]\s+)?")
TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}")
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9(\"'*_`])")
NUMBER = re.compile(r"(?<![\w.])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?")
WORD = re.compile(r"[a-z][a-z0-9_]{2,}")
STOP = set("""the and for are was were with that this from into over than then they them their there these those
have has had not but its also such which while where when what who whom how all any each both more most other some
only own same can will just should could would been being about after before between through during above below
under again further once here very our out per via one two three based provided sources source shows show shown
contains contain contained indicates indicate document documents""".split())
WINDOW, OVERLAP, TOP_WINDOWS = 700, 150, 3


def _clean(md: str) -> str:
    s = LIST_PREFIX.sub("", md, count=1)
    s = re.sub(r"<br\s*/?>|</?(?:b|i|em|strong|code|sup|sub|span)\b[^>]*>", " ", s, flags=re.I)  # HTML in table cells
    s = re.sub(r"\*\*|__|(?<!\w)[*_](?=\S)|(?<=\S)[*_](?!\w)|`", "", s)
    return " ".join(s.split()).strip(" |")


@dataclass
class _Claim:
    text: str                 # cleaned, citation markers removed
    own: list[int]            # citation numbers written on this sentence
    block: int                # bullet / paragraph / table row index
    section: int              # increments at every heading or "label:" line
    cited: list[int] = field(default_factory=list)
    inherited: bool = False


def extract_claims(answer: str) -> list[_Claim]:
    text = MATH_BLOCK.sub(" ", FENCE.sub(" ", answer))
    lines = text.splitlines()
    claims: list[_Claim] = []
    section = block = 0
    for i, raw in enumerate(lines):
        if not raw.strip():
            continue
        block += 1
        if HEADING.match(raw):
            section += 1
            continue
        if raw.lstrip().startswith("|"):  # table: skip header and separator rows, keep data rows
            if TABLE_SEP.match(raw) or (i + 1 < len(lines) and TABLE_SEP.match(lines[i + 1])):
                continue
            raw = " · ".join(c.strip() for c in raw.strip().strip("|").split("|"))
        for sent in SENT_SPLIT.split(raw.strip()):
            own = [int(n) for n in CITE.findall(sent)]
            claim = _clean(CITE.sub("", sent)).rstrip(" ,;")
            if not own and claim.endswith(":"):  # "Data Overview and Preprocessing:" / "The features are:"
                section += 1
                continue
            claim = re.sub(r"\s+([.,;:!?])", r"\1", claim)
            has_num = bool(NUMBER.search(claim))
            if (len(claim) < 25 and not (has_num and len(claim) >= 12)) or HEDGE.match(claim):
                continue
            claims.append(_Claim(text=claim, own=own, block=block, section=section))
    return claims


def _inherit(claims: list[_Claim], n_sources: int) -> None:
    """Uncited sentences borrow the valid citations of the same bullet/paragraph, else of the same section
    (nearest following cited claim first: models put the marker at the end of a point)."""
    valid = lambda c: [n for n in c.own if 1 <= n <= n_sources]  # noqa: E731
    for i, c in enumerate(claims):
        c.cited = valid(c)
        if c.own:
            continue
        for scope in ("block", "section"):
            near = [o for o in claims[i + 1:] if getattr(o, scope) == getattr(c, scope) and valid(o)][:1] or \
                   [o for o in reversed(claims[:i]) if getattr(o, scope) == getattr(c, scope) and valid(o)][:1]
            if near:
                c.cited, c.inherited = valid(near[0]), True
                break


def _windows(text: str) -> list[str]:
    if len(text) <= WINDOW:
        return [text]
    step = WINDOW - OVERLAP
    return [text[i:i + WINDOW] for i in range(0, max(1, len(text) - OVERLAP), step)]


def _terms(text: str) -> set[str]:
    return {w for w in WORD.findall(text.lower()) if w not in STOP}


def _numbers(text: str) -> list[tuple[float, float]]:
    """(value, rounding tolerance) for every number written in the text."""
    out = []
    for m in NUMBER.finditer(text):
        tok = m.group(0).replace(",", "")
        decimals = len(tok.split(".")[1]) if "." in tok else 0
        out.append((float(tok), 0.5 * 10 ** -decimals + 1e-9))
    return out


def lexical_support(claim: str, source: str) -> float:
    """Numeric-fact support: 0 unless every number in the claim appears in the source (within rounding)."""
    nums = _numbers(claim)
    if not nums:
        return 0.0
    src_vals = [v for v, _ in _numbers(source)]
    if not all(any(abs(v - s) <= tol for s in src_vals) for v, tol in nums):
        return 0.0
    terms = _terms(claim)
    recall = len(terms & _terms(source)) / len(terms) if terms else 1.0
    return 0.5 + 0.5 * recall


def support_score(claim: str, sources: list[str], max_windows: int | None = None) -> tuple[float, int]:
    """Best support over the sources and the index of the source that gave it.
    `max_windows` caps cross-encoder pairs overall (used when checking against every source)."""
    rr = get_models().reranker
    lex = [lexical_support(claim, src) for src in sources]
    best_lex = max(range(len(sources)), key=lambda i: lex[i], default=0)
    if rr.model is None or not sources:
        return (lex[best_lex] if sources else 0.0), best_lex
    terms = _terms(claim)
    windows: list[tuple[int, int, str]] = []  # (overlap, source index, window)
    for i, src in enumerate(sources):  # best-matching windows of each source, so facts deep in a chunk count
        ws = sorted(((len(terms & _terms(w)), i, w) for w in _windows(src)), key=lambda x: x[0], reverse=True)
        windows.extend(ws[:TOP_WINDOWS])
    if max_windows:
        windows = sorted(windows, key=lambda x: x[0], reverse=True)[:max_windows]
    scores = rr.score(claim, [w for _, _, w in windows])
    best_ce = max(range(len(scores)), key=lambda k: scores[k], default=None)
    if best_ce is not None and scores[best_ce] > lex[best_lex]:
        return scores[best_ce], windows[best_ce][1]
    return lex[best_lex], best_lex


def validate(answer: str, evidence: list[Evidence]) -> tuple[list[ClaimCheck], list[Citation], dict]:
    s = get_settings()
    claims = extract_claims(answer)
    _inherit(claims, len(evidence))
    checks: list[ClaimCheck] = []
    used: set[int] = set()
    invalid: set[int] = set()
    for c in claims:
        invalid.update(n for n in c.own if not 1 <= n <= len(evidence))
        used.update(c.cited)
        if not c.cited:
            if c.own or not evidence:  # cited only non-existent sources, or nothing to check against
                checks.append(ClaimCheck(sentence=c.text, cited=c.own, supported=False, support_score=0.0))
                continue
            # No citation anywhere near it: check it against every source (faithfulness to the whole context)
            # and record the best match. It still counts as "uncited" in the stats.
            score, idx = support_score(c.text, [e.content for e in evidence], max_windows=4)
            ok = score >= s.claim_support_threshold
            if ok:
                used.add(idx + 1)
            checks.append(ClaimCheck(sentence=c.text, cited=[idx + 1] if ok else [], supported=ok,
                                     support_score=round(score, 3), matched=ok))
            continue
        score, _ = support_score(c.text, [evidence[n - 1].content for n in c.cited])
        checks.append(ClaimCheck(sentence=c.text, cited=c.cited, supported=score >= s.claim_support_threshold,
                                 support_score=round(score, 3), inherited=c.inherited))
    citations = [Citation(index=n, evidence_id=evidence[n - 1].evidence_id, title=evidence[n - 1].title,
                          source=evidence[n - 1].source, locator=evidence[n - 1].locator,
                          kind=evidence[n - 1].kind, snippet=evidence[n - 1].content[:500])
                 for n in sorted(used)]
    total = len(checks)
    stats = {"claims": total, "supported": sum(c.supported for c in checks),
             "uncited": sum(1 for c in checks if not c.cited or c.matched), "invalid_citations": sorted(invalid),
             "supported_ratio": round(sum(c.supported for c in checks) / total, 3) if total else 1.0}
    return checks, citations, stats
