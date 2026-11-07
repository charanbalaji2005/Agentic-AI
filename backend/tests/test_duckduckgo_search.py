"""DuckDuckGo search tool, its web_research integration, and local/web/both routing.

`ddgs.DDGS` is replaced by fakes so the suite is offline and deterministic. Set RUN_LIVE_WEB_TESTS=1 to
also run one real search against DuckDuckGo.
"""
import os

import ddgs
import pytest
from ddgs.exceptions import DDGSException, RatelimitException, TimeoutException

from app.agents.base import AgentContext, registry
from app.agents.web_research import DDG_TOOL, WebResearchAgent
from app.core.config import get_settings
from app.core.schemas import PlanStep, SourceKind
from app.tools import duckduckgo_search as ddg

RAW = [
    {"title": "Python 3.13 released", "href": "https://www.python.org/downloads/release/python-3130/",
     "body": "Python 3.13 is the newest   major release."},
    {"title": "asyncio docs", "href": "https://docs.python.org/3/library/asyncio.html", "body": "asyncio is a library"},
    {"title": "duplicate", "href": "https://docs.python.org/3/library/asyncio.html", "body": "dup"},
    {"title": "not a web url", "href": "ftp://example.com/file", "body": "skip me"},
    {"title": "", "href": "https://example.org/x", "body": ""},
]


class FakeDDGS:
    """Scripted stand-in for ddgs.DDGS: `script[backend]` is a list of results-or-exceptions, one per call."""
    script: dict[str, list] = {}
    calls: list[dict] = []

    def __init__(self, timeout=None, **_kw):
        self.timeout = timeout

    def text(self, query, **kw):
        FakeDDGS.calls.append({"query": query, **kw})
        queue = FakeDDGS.script.get(kw.get("backend"), [])
        outcome = queue.pop(0) if queue else DDGSException("No results found.")
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


@pytest.fixture(autouse=True)
def fake_ddgs(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "ddg_retry_backoff_s", 0.0)
    monkeypatch.setattr(s, "ddg_max_retries", 2)
    monkeypatch.setattr(s, "ddg_backend", "duckduckgo")
    monkeypatch.setattr(s, "ddg_fallback_backend", "auto")
    monkeypatch.setattr(s, "ddg_cache_ttl_s", 300)
    monkeypatch.setattr(s, "web_search_provider", "auto")
    monkeypatch.setattr(ddgs, "DDGS", FakeDDGS)
    FakeDDGS.script, FakeDDGS.calls = {}, []
    ddg.clear_cache()
    yield FakeDDGS
    ddg.clear_cache()


# ---- the search tool ---------------------------------------------------------------------------

def test_results_are_normalized_with_source_urls():
    FakeDDGS.script = {"duckduckgo": [list(RAW)]}
    out = ddg.search_web("python release", max_results=5, region="uk-en", safesearch="off")
    assert out.ok and out.backend == "duckduckgo" and not out.cached
    assert [r.url for r in out.results] == ["https://www.python.org/downloads/release/python-3130/",
                                            "https://docs.python.org/3/library/asyncio.html",
                                            "https://example.org/x"]  # dup and non-http dropped
    first = out.results[0]
    assert first.title == "Python 3.13 released"
    assert first.description == "Python 3.13 is the newest major release."  # whitespace collapsed
    assert first.source == "python.org" and first.provider == "duckduckgo"
    assert out.results[2].title == "https://example.org/x"  # missing title falls back to URL
    call = FakeDDGS.calls[0]
    assert call["region"] == "uk-en" and call["safesearch"] == "off" and call["backend"] == "duckduckgo"


def test_max_results_is_respected_and_clamped():
    FakeDDGS.script = {"duckduckgo": [list(RAW)]}
    assert len(ddg.search_web("q", max_results=1).results) == 1
    FakeDDGS.script = {"duckduckgo": [list(RAW)]}
    ddg.search_web("other", max_results=999)
    assert FakeDDGS.calls[-1]["max_results"] == ddg.MAX_RESULTS_CAP


@pytest.mark.parametrize("kwargs", [{"query": "   "}, {"query": "x", "safesearch": "strict"},
                                    {"query": "x", "timelimit": "decade"}])
def test_invalid_input_is_reported_not_raised(kwargs):
    out = ddg.search_web(**kwargs)
    assert not out.ok and out.error_type == "invalid_input"
    assert FakeDDGS.calls == []


def test_empty_primary_falls_back_to_secondary_backend():
    FakeDDGS.script = {"duckduckgo": [DDGSException("No results found.")], "auto": [RAW[:1]]}
    out = ddg.search_web("rare query")
    assert out.ok and out.backend == "auto" and out.results[0].provider == "auto"
    assert [c["backend"] for c in FakeDDGS.calls] == ["duckduckgo", "auto"]


def test_no_results_anywhere_is_ok_and_empty():
    out = ddg.search_web("nothing matches this")
    assert out.ok and out.results == [] and out.error is None


def test_rate_limit_is_retried_then_succeeds():
    FakeDDGS.script = {"duckduckgo": [RatelimitException("202 Ratelimit"),
                                      DDGSException(RatelimitException("202 Ratelimit")),  # ddgs-wrapped form
                                      RAW[:2]]}
    out = ddg.search_web("q")
    assert out.ok and len(out.results) == 2
    assert len(FakeDDGS.calls) == 3


def test_persistent_rate_limit_returns_rate_limited_error():
    FakeDDGS.script = {"duckduckgo": [RatelimitException("x")] * 3, "auto": [RatelimitException("x")] * 3}
    out = ddg.search_web("q")
    assert not out.ok and out.error_type == "rate_limited" and out.results == []
    assert len(FakeDDGS.calls) == 6  # 1 + 2 retries on each backend


def test_timeout_is_reported():
    FakeDDGS.script = {"duckduckgo": [TimeoutException("timed out")] * 3,
                       "auto": [TimeoutException("timed out")] * 3}
    out = ddg.search_web("q")
    assert out.error_type == "timeout"


def test_unexpected_error_is_not_retried():
    FakeDDGS.script = {"duckduckgo": [ValueError("boom")], "auto": [ValueError("boom")]}
    out = ddg.search_web("q")
    assert out.error_type == "error" and "boom" in out.error
    assert len(FakeDDGS.calls) == 2  # one per backend, no retries


def test_results_are_cached():
    FakeDDGS.script = {"duckduckgo": [RAW[:2]]}
    a = ddg.search_web("Cache Me")
    b = ddg.search_web("  cache   me ")
    assert len(FakeDDGS.calls) == 1 and b.cached and [r.url for r in b.results] == [r.url for r in a.results]


def test_missing_package_is_reported(monkeypatch):
    monkeypatch.setattr(ddg, "is_installed", lambda: False)
    out = ddg.search_web("q")
    assert out.error_type == "unavailable" and "ddgs" in out.error


async def test_async_wrapper():
    FakeDDGS.script = {"duckduckgo": [RAW[:2]]}
    out = await ddg.asearch_web("q", max_results=2)
    assert out.ok and len(out.results) == 2


# ---- web_research agent integration ------------------------------------------------------------

async def test_web_research_agent_uses_duckduckgo_without_mcp():
    FakeDDGS.script = {"duckduckgo": [RAW[:2]]}
    agent = WebResearchAgent()
    ok, detail = agent.available()
    assert ok and "DuckDuckGo" in detail
    events = []

    async def emit(e, d):
        events.append((e, d))

    res = await agent.run(PlanStep(task_id="t1", description="", agent="web_research",
                                   query="latest python release"), AgentContext(emit=emit))
    assert res.error is None
    assert res.tool_calls[0]["tool"] == DDG_TOOL and res.tool_calls[0]["ok"]
    assert {e.source for e in res.evidence} == {r["href"] for r in RAW[:2]}  # source URLs kept for citations
    assert all(e.kind == SourceKind.web and e.metadata["snippet_only"] for e in res.evidence)
    assert res.evidence[0].metadata["search_provider"] == "duckduckgo"
    assert any(e == "tool_result" and d["tool"] == DDG_TOOL for e, d in events)


async def test_web_research_agent_reports_rate_limit():
    FakeDDGS.script = {"duckduckgo": [RatelimitException("x")] * 3, "auto": [RatelimitException("x")] * 3}
    res = await WebResearchAgent().run(PlanStep(task_id="t1", description="", agent="web_research", query="q",
                                                arguments={"queries": ["a", "b"]}), AgentContext())
    assert res.evidence == [] and "rate limit" in res.error
    assert len(res.tool_calls) == 1  # stops after the first rate-limited query


def test_provider_none_disables_duckduckgo(monkeypatch):
    monkeypatch.setattr(get_settings(), "web_search_provider", "none")
    assert not WebResearchAgent()._use_duckduckgo()


# ---- aggregator routing: local, web, or both ---------------------------------------------------

@pytest.fixture
def web_agent_registered():
    saved = dict(registry._agents)
    registry.register(WebResearchAgent())
    yield
    registry._agents.clear()
    registry._agents.update(saved)


@pytest.mark.parametrize("question,doc_ids,expected", [
    ("Summarize the key findings", ["d1"], ["local_rag"]),
    ("What is the latest figure in the uploaded report?", ["d1"], ["local_rag"]),
    ("How does this report compare with the latest industry news?", ["d1"], ["local_rag", "web_research"]),
    ("Search the web for related work on this topic", ["d1"], ["local_rag", "web_research"]),
    ("Who won the most recent F1 race?", None, ["web_research"]),
])
def test_heuristic_routing(web_agent_registered, question, doc_ids, expected):
    from app.orchestration.planner import heuristic_plan
    plan = heuristic_plan(question, ["__no_such_kb__"], doc_ids)
    assert [s.agent for s in plan.steps] == expected


@pytest.mark.parametrize("question,doc_ids,scoped", [
    ("Summarize the key points in the uploaded document.", None, True),
    ("What does my notes file say about retries?", None, True),
    ("Explain the attention mechanism", ["d1"], True),
    ("Compare this document with what is online", ["d1"], False),  # explicit web request wins
    ("Who won the most recent F1 race?", None, False),
])
def test_document_scoped(question, doc_ids, scoped):
    from app.orchestration.planner import document_scoped
    assert document_scoped(question, doc_ids) is scoped


@pytest.mark.parametrize("question,web_added", [
    ("Summarize the key points in the uploaded document.", False),
    ("Who won the most recent F1 race?", True),
])
async def test_corrective_rag_widens_to_web_only_for_non_document_questions(web_agent_registered, question,
                                                                            web_added):
    """Weak local evidence must not drag a document question onto generic web pages."""
    from app.core.schemas import Plan
    from app.orchestration.graph import correct_node
    plan = Plan(intent="question", steps=[PlanStep(task_id="t1", description="", agent="local_rag", query=question)])
    out = await correct_node({"question": question, "iteration": 0, "selected": [], "plan": plan,
                              "kb_ids": ["default"], "doc_ids": None}, {})
    assert any(s.agent == "web_research" for s in out["plan"].steps) is web_added


# ---- optional live check -----------------------------------------------------------------------

@pytest.mark.skipif(os.environ.get("RUN_LIVE_WEB_TESTS") != "1", reason="set RUN_LIVE_WEB_TESTS=1 to hit DuckDuckGo")
def test_live_duckduckgo_search(monkeypatch):
    import importlib
    monkeypatch.setattr(ddgs, "DDGS", importlib.import_module("ddgs.ddgs").DDGS)
    out = ddg.search_web("python programming language", max_results=3)
    assert out.ok, out.error
    assert out.results and all(r.url.startswith("http") for r in out.results)
