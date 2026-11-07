"""Agent 2 — Web research over search/fetch MCP servers with credibility, dedup and freshness."""
from __future__ import annotations

import asyncio
import json
import re
from urllib.parse import urlparse, urlunparse

from app.agents.base import AgentContext, BaseAgent
from app.core.config import get_settings
from app.core.logging import log
from app.core.schemas import AgentResult, Evidence, PlanStep, SourceKind
from app.ingestion.chunking import recursive_split
from app.mcp.manager import ToolInfo, mcp_manager
from app.models.manager import get_models
from app.security.guards import flag_injection, isolate_untrusted
from app.tools import duckduckgo_search as ddg

DDG_TOOL = "duckduckgo.search"

URL_RE = re.compile(r"https?://[^\s\)\]\"'<>]+")
DATE_RE = re.compile(r"\b(20\d{2}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? 20\d{2})\b")
HIGH = (".gov", ".edu", ".int", "docs.", "developer.", "learn.microsoft.com", "aws.amazon.com", "arxiv.org",
        "wikipedia.org", "github.com", "nature.com", "acm.org", "ieee.org")
LOW = ("pinterest.", "quora.", "facebook.", "tiktok.", "instagram.")


def normalize_url(u: str) -> str:
    p = urlparse(u.rstrip(".,;"))
    return urlunparse((p.scheme, p.netloc.lower().removeprefix("www."), p.path.rstrip("/"), "", "", ""))


def credibility(url: str) -> float:
    host = urlparse(url).netloc.lower()
    if any(h in host or host.startswith(h) for h in HIGH):
        return 0.9
    if any(h in host for h in LOW):
        return 0.3
    return 0.6


def _arg(schema: dict, *names: str) -> str | None:
    props = (schema or {}).get("properties", {})
    return next((n for n in names if n in props), None)


def parse_search_results(text: str) -> list[dict]:
    """Search MCP servers return JSON or 'Title/URL/Description' text — handle both."""
    try:
        data = json.loads(text)
        items = data if isinstance(data, list) else data.get("results") or data.get("web", {}).get("results", [])
        return [{"title": i.get("title", ""), "url": i.get("url") or i.get("link"),
                 "snippet": i.get("description") or i.get("snippet", "")} for i in items if i.get("url") or i.get("link")]
    except (json.JSONDecodeError, AttributeError, TypeError):
        pass
    results, cur = [], {}
    for line in text.splitlines():
        m = re.match(r"\s*(Title|URL|Description|Snippet):\s*(.*)", line, re.I)
        if not m:
            continue
        key, val = m.group(1).lower(), m.group(2).strip()
        if key == "title" and cur.get("url"):
            results.append(cur)
            cur = {}
        cur["snippet" if key in ("description", "snippet") else key] = val
    if cur.get("url"):
        results.append(cur)
    if not results:
        results = [{"title": "", "url": u, "snippet": ""} for u in URL_RE.findall(text)]
    return results


class WebResearchAgent(BaseAgent):
    name = "web_research"
    display_name = "Web research"
    description = ("Searches the public web (DuckDuckGo, or a connected search MCP server), reads the top pages "
                   "and returns cited passages. Use for current events, external facts, or anything not in the "
                   "local files; pair it with local_rag when a question combines uploaded documents with outside "
                   "information.")
    color = "#5FD68A"
    argument_hints = {"queries": "optional list of 1-3 search queries", "max_pages": "pages to read (default 4)",
                      "timelimit": "optional freshness filter: d, w, m or y (day/week/month/year)"}

    def _search_tool(self) -> ToolInfo | None:
        if get_settings().web_search_provider in ("duckduckgo", "none"):
            return None
        return mcp_manager.find_tool("search", "web_search", "brave_web_search", "search")

    def _use_duckduckgo(self) -> bool:
        return get_settings().web_search_provider in ("auto", "duckduckgo") and ddg.is_installed()

    def _fetch_tool(self) -> ToolInfo | None:
        return mcp_manager.find_tool("search", "fetch") or mcp_manager.find_tool("browser", "fetch", "navigate")

    def available(self):
        if self._search_tool():
            return True, "ready"
        if self._use_duckduckgo():
            return True, "ready · DuckDuckGo search" + ("" if self._fetch_tool() else " (snippets only, no fetch)")
        if self._fetch_tool():
            return True, "ready"
        return False, ("Install `ddgs` for free DuckDuckGo search, or connect a search MCP server "
                       "(e.g. brave-search) to enable web research")

    async def run(self, step: PlanStep, ctx: AgentContext) -> AgentResult:
        res = AgentResult(agent=self.name, task_id=step.task_id)
        search, fetch = self._search_tool(), self._fetch_tool()
        queries = step.arguments.get("queries") or [step.query]
        if isinstance(queries, str):
            queries = [queries]
        max_pages = int(step.arguments.get("max_pages", 4))
        candidates: dict[str, dict] = {}

        def add(r: dict) -> None:
            key = normalize_url(r["url"])
            if key not in candidates and credibility(r["url"]) > 0.3:
                candidates[key] = r

        direct = URL_RE.findall(step.query)
        for u in direct:
            candidates[normalize_url(u)] = {"title": u, "url": u, "snippet": ""}

        if search:
            qarg = _arg(search.input_schema, "query", "q", "search_query") or "query"
            carg = _arg(search.input_schema, "count", "max_results", "num_results", "limit")
            for q in queries[:3]:
                await ctx.emit("agent_status", {"agent": self.name, "task_id": step.task_id,
                                                "status": "executing", "detail": f"Searching: {q}"})
                args = {qarg: q, **({carg: 8} if carg else {})}
                out = await mcp_manager.call(search.server, search.name, args, actor=self.name)
                res.tool_calls.append({"tool": search.qualified, "arguments": args, "ok": out.ok, "error": out.error})
                await ctx.emit("tool_result", {"agent": self.name, "task_id": step.task_id, "tool": search.qualified,
                                               "ok": out.ok, "error": out.error, "preview": out.content[:300]})
                if out.ok:
                    for r in parse_search_results(out.content):
                        add(r)

        # DuckDuckGo: the primary provider when no search MCP server is connected, and the
        # fallback (provider=auto) when the MCP server failed or found nothing.
        searched = len(candidates) > len(direct)
        if not searched and self._use_duckduckgo():
            for r in await self._duckduckgo(queries[:3], step, ctx, res):
                add(r)
        elif not search and not direct:
            res.error = "No web search provider available"
            return res

        if not candidates:
            errors = [c["error"] for c in res.tool_calls if c.get("error")]
            res.error = errors[-1] if errors else None
            res.summary = "Web search returned no results"
            return res

        ranked = sorted(candidates.values(), key=lambda r: credibility(r["url"]), reverse=True)
        seen_hosts: dict[str, int] = {}
        picked = []
        for r in ranked:  # source diversity: at most 2 pages per host
            host = urlparse(r["url"]).netloc
            if seen_hosts.get(host, 0) < 2:
                picked.append(r)
                seen_hosts[host] = seen_hosts.get(host, 0) + 1
            if len(picked) >= max_pages:
                break

        pages = await asyncio.gather(*(self._read(r, fetch, step, ctx, res) for r in picked))
        reranker = get_models().reranker
        for r, text in zip(picked, pages):
            if not text:  # fall back to the search snippet, clearly marked as such
                if r.get("snippet"):
                    res.evidence.append(self._ev(r, r["snippet"], 0.0, snippet_only=True))
                continue
            pieces = recursive_split(text, 1000, 100)[:60]
            scores = await asyncio.to_thread(reranker.score, step.query, pieces) if reranker.model else [0.0] * len(pieces)
            for piece, sc in sorted(zip(pieces, scores), key=lambda x: x[1], reverse=True)[:2]:
                res.evidence.append(self._ev(r, piece, sc, published=_date(text)))
        res.summary = f"Read {sum(1 for p in pages if p)} of {len(picked)} pages, {len(res.evidence)} passages"
        return res

    async def _duckduckgo(self, queries: list[str], step: PlanStep, ctx: AgentContext, res: AgentResult) -> list[dict]:
        s = get_settings()
        timelimit = step.arguments.get("timelimit")
        timelimit = timelimit if timelimit in ddg.TIMELIMIT_VALUES else None
        found: list[dict] = []
        for q in queries:
            await ctx.emit("agent_status", {"agent": self.name, "task_id": step.task_id,
                                            "status": "executing", "detail": f"Searching DuckDuckGo: {q}"})
            args = {"query": q, "max_results": s.ddg_max_results, "region": s.ddg_region,
                    "safesearch": s.ddg_safesearch, **({"timelimit": timelimit} if timelimit else {})}
            out = await ddg.asearch_web(q, s.ddg_max_results, s.ddg_region, s.ddg_safesearch, timelimit)
            res.tool_calls.append({"tool": DDG_TOOL, "arguments": args, "ok": out.ok, "error": out.error,
                                   "duration_ms": out.duration_ms, "results": len(out.results)})
            preview = "\n".join(f"{r.title} — {r.url}" for r in out.results[:4]) or (out.error or "no results")
            await ctx.emit("tool_result", {"agent": self.name, "task_id": step.task_id, "tool": DDG_TOOL,
                                           "ok": out.ok, "error": out.error, "preview": preview[:300]})
            await mcp_manager._log("duckduckgo", "search", args, self.name,  # same audit log as MCP tools
                                   "ok" if out.ok else "failed", out.error or f"{len(out.results)} results",
                                   out.duration_ms)
            if out.error_type == "rate_limited":
                log.warning("web_research.ddg_rate_limited", query=q[:120])
                break  # further queries would be throttled too
            found.extend({"title": r.title, "url": r.url, "snippet": r.description, "provider": r.provider}
                         for r in out.results)
        return found

    async def _read(self, r, fetch, step, ctx, res) -> str | None:
        if not fetch:
            return None
        uarg = _arg(fetch.input_schema, "url", "uri") or "url"
        args = {uarg: r["url"]}
        if _arg(fetch.input_schema, "max_length"):
            args["max_length"] = 12000
        out = await mcp_manager.call(fetch.server, fetch.name, args, actor=self.name)
        res.tool_calls.append({"tool": fetch.qualified, "arguments": args, "ok": out.ok, "error": out.error})
        await ctx.emit("tool_result", {"agent": self.name, "task_id": step.task_id, "tool": fetch.qualified,
                                       "ok": out.ok, "error": out.error, "preview": r["url"]})
        return out.content if out.ok and out.content.strip() else None

    def _ev(self, r, text, score, published=None, snippet_only=False) -> Evidence:
        return Evidence(kind=SourceKind.web, content=isolate_untrusted(text), title=r.get("title") or r["url"],
                        source=r["url"], agent=self.name, score=score, rerank_score=score,
                        reliability=credibility(r["url"]) * (0.7 if snippet_only else 1.0), published_at=published,
                        metadata={"snippet_only": snippet_only, "injection_flag": flag_injection(text),
                                  **({"search_provider": r["provider"]} if r.get("provider") else {})})


def _date(text: str) -> str | None:
    m = DATE_RE.search(text[:3000])
    return m.group(1) if m else None
