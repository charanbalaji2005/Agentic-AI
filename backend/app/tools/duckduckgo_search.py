"""DuckDuckGo web search through the `ddgs` package: free, no API key.

`ddgs` is an unofficial client, not a guaranteed API. DuckDuckGo may rate-limit or change its pages
at any time, so every search is time-boxed, retried with backoff on rate limits and timeouts, falls
back to a second backend when the primary returns nothing, and is cached briefly. Operational failures
never raise: callers get a `WebSearchResponse` whose `error` / `error_type` explain what went wrong.
"""
from __future__ import annotations

import asyncio
import threading
import time
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.core.logging import log

SafeSearch = Literal["on", "moderate", "off"]
ErrorType = Literal["invalid_input", "rate_limited", "timeout", "unavailable", "error"]
SAFESEARCH_VALUES = ("on", "moderate", "off")
TIMELIMIT_VALUES = ("d", "w", "m", "y")
MAX_RESULTS_CAP = 25
_CACHE_MAX_ENTRIES = 256


class WebSearchResult(BaseModel):
    title: str
    url: str
    description: str = ""
    source: str                    # website host, e.g. "docs.python.org"
    provider: str = "duckduckgo"   # ddgs backend that produced the result


class WebSearchResponse(BaseModel):
    query: str
    results: list[WebSearchResult] = Field(default_factory=list)
    backend: str | None = None     # backend that answered ("duckduckgo", or the fallback)
    cached: bool = False
    error: str | None = None
    error_type: ErrorType | None = None
    duration_ms: int = 0

    @property
    def ok(self) -> bool:
        """True when the search ran. It may still have found nothing (`results == []`)."""
        return self.error is None


class _SearchFailure(Exception):
    def __init__(self, error_type: ErrorType, message: str):
        super().__init__(message)
        self.error_type = error_type


# ---- cache -------------------------------------------------------------------------------------
_cache: dict[tuple, tuple[float, list[WebSearchResult], str]] = {}
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _cache_get(key: tuple, ttl: float) -> tuple[list[WebSearchResult], str] | None:
    if ttl <= 0:
        return None
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.monotonic() - hit[0] < ttl:
            return [r.model_copy() for r in hit[1]], hit[2]
        _cache.pop(key, None)
    return None


def _cache_put(key: tuple, results: list[WebSearchResult], backend: str, ttl: float) -> None:
    if ttl <= 0 or not results:
        return
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX_ENTRIES:  # drop the oldest entry
            _cache.pop(min(_cache, key=lambda k: _cache[k][0]), None)
        _cache[key] = (time.monotonic(), results, backend)


# ---- ddgs adapter ------------------------------------------------------------------------------
def is_installed() -> bool:
    try:
        import ddgs  # noqa: F401
    except ImportError:
        return False
    return True


def _classify(exc: Exception) -> _SearchFailure | None:
    """Map ddgs exceptions to our error types. None means "no results" (not an error)."""
    from ddgs.exceptions import DDGSException, RatelimitException, TimeoutException

    inner = exc.args[0] if exc.args and isinstance(exc.args[0], Exception) else None
    text = str(exc).lower()
    if isinstance(exc, RatelimitException) or isinstance(inner, RatelimitException) \
            or "ratelimit" in text or "rate limit" in text or "429" in text:
        return _SearchFailure("rate_limited", "DuckDuckGo rate limit hit; try again shortly")
    if isinstance(exc, TimeoutException) or isinstance(inner, TimeoutException) or "timed out" in text:
        return _SearchFailure("timeout", "DuckDuckGo search timed out")
    if isinstance(exc, DDGSException) and "no results found" in text:
        return None
    return _SearchFailure("error", f"{type(exc).__name__}: {exc}"[:300])


def _normalize(raw: list[dict[str, Any]], backend: str, limit: int) -> list[WebSearchResult]:
    out: list[WebSearchResult] = []
    seen: set[str] = set()
    for item in raw or []:
        url = str(item.get("href") or item.get("url") or item.get("link") or "").strip()
        if not url.startswith(("http://", "https://")) or url in seen:
            continue
        seen.add(url)
        host = urlparse(url).netloc.lower().removeprefix("www.")
        title = " ".join(str(item.get("title") or "").split()) or url
        body = " ".join(str(item.get("body") or item.get("description") or item.get("snippet") or "").split())
        out.append(WebSearchResult(title=title[:300], url=url, description=body[:1000], source=host,
                                   provider=backend))
        if len(out) >= limit:
            break
    return out


def _run_backend(query: str, backend: str, *, max_results: int, region: str, safesearch: str,
                 timelimit: str | None, timeout: int, retries: int, backoff: float) -> list[dict[str, Any]]:
    """One backend with retry/backoff on rate limits and timeouts. Raises _SearchFailure."""
    from ddgs import DDGS

    last: _SearchFailure | None = None
    for attempt in range(retries + 1):
        try:
            return DDGS(timeout=timeout).text(query, region=region, safesearch=safesearch, timelimit=timelimit,
                                              max_results=max_results, backend=backend) or []
        except Exception as e:  # noqa: BLE001  ddgs raises several exception types
            failure = _classify(e)
            if failure is None:
                return []
            last = failure
            log.warning("web_search.attempt_failed", provider="duckduckgo", backend=backend, attempt=attempt + 1,
                        error_type=failure.error_type, error=str(failure))
            if failure.error_type not in ("rate_limited", "timeout") or attempt == retries:
                break
            time.sleep(backoff * (2 ** attempt))
    raise last or _SearchFailure("error", "DuckDuckGo search failed")


# ---- public API --------------------------------------------------------------------------------
def search_web(query: str, max_results: int | None = None, region: str | None = None,
               safesearch: SafeSearch | str | None = None, timelimit: str | None = None) -> WebSearchResponse:
    """Search the web with DuckDuckGo and return normalized results with source URLs.

    Args:
        query: what to search for.
        max_results: 1–25 (default `DDG_MAX_RESULTS`).
        region: ddgs region code such as "us-en", "uk-en", "in-en" or "wt-wt" (no region).
        safesearch: "on", "moderate" or "off".
        timelimit: optional freshness filter: "d" (day), "w" (week), "m" (month) or "y" (year).
    """
    s = get_settings()
    t0 = time.monotonic()
    q = " ".join((query or "").split())
    max_results = max(1, min(int(max_results or s.ddg_max_results), MAX_RESULTS_CAP))
    region = (region or s.ddg_region).strip().lower()
    safesearch = (safesearch or s.ddg_safesearch).strip().lower()

    def fail(kind: ErrorType, msg: str) -> WebSearchResponse:
        return WebSearchResponse(query=q, error=msg, error_type=kind, duration_ms=int((time.monotonic() - t0) * 1000))

    if not q:
        return fail("invalid_input", "Search query is empty")
    if len(q) > 500:
        q = q[:500]
    if safesearch not in SAFESEARCH_VALUES:
        return fail("invalid_input", f"safesearch must be one of {SAFESEARCH_VALUES}")
    if timelimit is not None and timelimit not in TIMELIMIT_VALUES:
        return fail("invalid_input", f"timelimit must be one of {TIMELIMIT_VALUES}")
    if not is_installed():
        return fail("unavailable", "The 'ddgs' package is not installed (pip install ddgs)")

    key = (q.lower(), max_results, region, safesearch, timelimit)
    hit = _cache_get(key, s.ddg_cache_ttl_s)
    if hit:
        results, backend = hit
        log.info("web_search.cache_hit", provider="duckduckgo", query=q[:120], results=len(results))
        return WebSearchResponse(query=q, results=results, backend=backend, cached=True,
                                 duration_ms=int((time.monotonic() - t0) * 1000))

    backends = [s.ddg_backend] + ([s.ddg_fallback_backend] if s.ddg_fallback_backend
                                  and s.ddg_fallback_backend != s.ddg_backend else [])
    last: _SearchFailure | None = None
    for backend in backends:
        try:
            raw = _run_backend(q, backend, max_results=max_results, region=region, safesearch=safesearch,
                               timelimit=timelimit, timeout=s.ddg_timeout_s, retries=s.ddg_max_retries,
                               backoff=s.ddg_retry_backoff_s)
        except _SearchFailure as e:
            last = e
            continue
        results = _normalize(raw, backend, max_results)
        if results:
            _cache_put(key, results, backend, s.ddg_cache_ttl_s)
            dur = int((time.monotonic() - t0) * 1000)
            log.info("web_search.ok", provider="duckduckgo", backend=backend, query=q[:120],
                     results=len(results), duration_ms=dur)
            return WebSearchResponse(query=q, results=results, backend=backend, duration_ms=dur)
        log.info("web_search.empty", provider="duckduckgo", backend=backend, query=q[:120])

    if last:  # every backend failed or came back empty, and at least one actually errored
        log.warning("web_search.failed", provider="duckduckgo", query=q[:120], error_type=last.error_type,
                    error=str(last))
        return fail(last.error_type, str(last))
    return WebSearchResponse(query=q, results=[], backend=backends[-1],
                             duration_ms=int((time.monotonic() - t0) * 1000))


async def asearch_web(query: str, max_results: int | None = None, region: str | None = None,
                      safesearch: SafeSearch | str | None = None, timelimit: str | None = None) -> WebSearchResponse:
    """Async wrapper: runs the blocking ddgs call in a worker thread under an overall deadline."""
    s = get_settings()
    retries = s.ddg_max_retries + 1
    backends = 2 if s.ddg_fallback_backend else 1
    deadline = s.ddg_timeout_s * retries * backends + s.ddg_retry_backoff_s * (2 ** retries) + 5
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(search_web, query, max_results, region, safesearch, timelimit), timeout=deadline)
    except asyncio.TimeoutError:
        log.warning("web_search.deadline", provider="duckduckgo", query=(query or "")[:120], deadline_s=deadline)
        return WebSearchResponse(query=query or "", error="DuckDuckGo search timed out", error_type="timeout",
                                 duration_ms=int(deadline * 1000))
