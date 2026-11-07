"""Aggregator Agent as a LangGraph state machine.

recall → plan → execute (parallel by dependency level) → aggregate → assess
   ↑                                                         │ insufficient & iterations left
   └──────────── corrective re-plan ◄────────────────────────┘
assess → generate (streamed) → validate → END
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from app.agents.base import AgentContext, registry
from app.context.aggregator import aggregate
from app.core.config import get_settings
from app.core.logging import log
from app.core.schemas import AgentResult, Evidence, Plan, PlanStep, SourceKind, StepStatus
from app.generation.prompts import CHITCHAT_SYSTEM, CODE_SYSTEM, MATH_DIRECT_SYSTEM, SYSTEM, build_messages

DIRECT_INTENTS = ("chitchat", "math", "direct", "code")  # answered by the model without retrieval
from app.generation.validator import validate
from app.mcp.manager import mcp_manager
from app.memory.service import memory
from app.models.manager import get_models
from app.orchestration.planner import (corrective_query, dependency_levels, document_scoped, is_math_query,
                                       make_plan)


class RAGState(TypedDict, total=False):
    question: str
    user_id: str
    kb_ids: list[str]
    doc_ids: list[str] | None
    filters: dict | None
    history: list[dict]
    memories: list[dict]
    plan: Plan
    results: list[AgentResult]
    evidence: list[Evidence]
    selected: list[Evidence]
    conflicts: list[dict]
    best_score: float
    iteration: int
    insufficient: bool
    answer: str
    citations: list[dict]
    claims: list[dict]
    validation: dict
    timings: dict[str, int]


def _emit(config: RunnableConfig):
    async def noop(*_a, **_k):
        return None
    return (config.get("configurable") or {}).get("emit") or noop


def _plan_payload(plan: Plan) -> dict:
    return plan.model_dump(mode="json")


async def recall_node(state: RAGState, config: RunnableConfig) -> dict:
    emit = _emit(config)
    await emit("agent_status", {"agent": "aggregator", "status": "planning", "detail": "Recalling memory"})
    mems = await memory.recall(state["user_id"], state["question"])
    if mems:
        await emit("memory", {"items": mems})
    return {"memories": mems, "iteration": 0, "results": [], "evidence": [], "timings": {}}


async def plan_node(state: RAGState, config: RunnableConfig) -> dict:
    emit = _emit(config)
    await emit("agent_status", {"agent": "aggregator", "status": "planning", "detail": "Building execution plan"})
    plan = await make_plan(state["question"], state["history"], state["kb_ids"], state["memories"],
                           doc_ids=state.get("doc_ids"))
    await emit("plan", _plan_payload(plan))
    return {"plan": plan}


async def execute_node(state: RAGState, config: RunnableConfig) -> dict:
    emit = _emit(config)
    plan = state["plan"]
    ctx = AgentContext(kb_ids=state["kb_ids"], doc_ids=state.get("doc_ids"), filters=state.get("filters"),
                       history=state["history"], user_id=state["user_id"], emit=emit)
    results = list(state.get("results", []))
    evidence = list(state.get("evidence", []))
    t0 = time.time()

    async def run_step(step: PlanStep):
        step.status = StepStatus.running
        await emit("step", step.model_dump(mode="json"))
        await emit("agent_status", {"agent": step.agent, "task_id": step.task_id, "status": "executing",
                                    "detail": step.description})
        try:
            agent = registry.get(step.agent)
            res = await asyncio.wait_for(agent.run(step, ctx), timeout=get_settings().tool_timeout_s * 4)
        except Exception as e:  # noqa: BLE001  retry/recovery: record failure, continue other steps
            log.error("agent.failed", agent=step.agent, error=str(e))
            res = AgentResult(agent=step.agent, task_id=step.task_id, error=f"{type(e).__name__}: {e}")
        if res.pending_approvals:
            step.status = StepStatus.awaiting_approval
            for aid in res.pending_approvals:
                await emit("approval", mcp_manager.approvals[aid])
        else:
            step.status = StepStatus.failed if res.error and not res.evidence else StepStatus.completed
        step.result_summary, step.error = res.summary, res.error
        await emit("step", step.model_dump(mode="json"))
        await emit("agent_status", {"agent": step.agent, "task_id": step.task_id,
                                    "status": "failed" if step.status == StepStatus.failed else "completed",
                                    "detail": res.error or res.summary})
        await emit("evidence", {"task_id": step.task_id, "agent": step.agent,
                                "items": [e.model_dump(mode="json", exclude={"content"}) | {"preview": e.content[:280]}
                                          for e in res.evidence]})
        return res

    for level in dependency_levels(plan.steps):
        outs = await asyncio.gather(*(run_step(s) for s in level))
        for r in outs:
            results.append(r)
            evidence.extend(r.evidence)

    timings = dict(state.get("timings", {}))
    timings["retrieval_ms"] = timings.get("retrieval_ms", 0) + int((time.time() - t0) * 1000)
    return {"results": results, "evidence": evidence, "plan": plan, "timings": timings}


async def aggregate_node(state: RAGState, config: RunnableConfig) -> dict:
    emit = _emit(config)
    await emit("agent_status", {"agent": "aggregator", "status": "validating",
                                "detail": f"Aggregating {len(state['evidence'])} pieces of evidence"})
    selected, conflicts, best = await aggregate(state["question"], list(state["evidence"]))
    await emit("context", {"selected": [e.evidence_id for e in selected], "conflicts": conflicts,
                           "best_score": round(best, 3)})
    return {"selected": selected, "conflicts": conflicts, "best_score": best}


def route_after_aggregate(state: RAGState) -> str:
    s = get_settings()
    if state["plan"].intent in DIRECT_INTENTS:
        return "generate"
    if state.get("doc_ids") and state.get("evidence"):
        return "generate"
    weak = state["best_score"] < s.sufficiency_threshold
    if weak and state["iteration"] + 1 < s.max_iterations:
        return "correct"
    return "generate"


async def correct_node(state: RAGState, config: RunnableConfig) -> dict:
    """Corrective RAG: rewrite the query and widen the search (add web if available and not yet used,
    unless the question is about the user's own documents)."""
    emit = _emit(config)
    it = state["iteration"] + 1
    hint = "; ".join(e.title for e in state["selected"][:3]) or "nothing relevant"
    q2 = await corrective_query(state["question"], hint)
    used_agents = {s.agent for s in state["plan"].steps}
    avail = {a.name for a in registry.available()}
    new_steps = []
    if "local_rag" in avail and (any(state["kb_ids"]) or state.get("doc_ids")):
        args = {"multi_hop": True}
        if state.get("doc_ids"):
            args["doc_ids"] = state.get("doc_ids")
        new_steps.append(PlanStep(task_id=f"r{it}a", description="Retry local search with a rewritten query",
                                  agent="local_rag", query=q2, arguments=args))
    doc_focused = document_scoped(state["question"], state.get("doc_ids"))
    if "web_research" in avail and not doc_focused and ("web_research" not in used_agents or it > 1):
        new_steps.append(PlanStep(task_id=f"r{it}b", description="Widen search to the web", agent="web_research",
                                  query=q2))
    plan = state["plan"]
    if not new_steps:
        await emit("iteration", {"iteration": it, "query": q2, "action": "no further sources available"})
        return {"iteration": it, "plan": plan}  # no pending steps → router goes to generate
    plan.steps.extend(new_steps)
    await emit("iteration", {"iteration": it, "query": q2, "action": "corrective retrieval"})
    await emit("plan", _plan_payload(plan))
    return {"iteration": it, "plan": plan}


async def generate_node(state: RAGState, config: RunnableConfig) -> dict:
    emit = _emit(config)
    gen = get_models().generator
    s = get_settings()
    await emit("agent_status", {"agent": "aggregator", "status": "executing", "detail": "Generating answer"})
    pending = [mcp_manager.approvals[a] for r in state.get("results", []) for a in r.pending_approvals]
    intent = state["plan"].intent
    if intent in DIRECT_INTENTS:
        system_prompt = {"math": MATH_DIRECT_SYSTEM, "code": CODE_SYSTEM}.get(intent, CHITCHAT_SYSTEM)
        messages = [{"role": "system", "content": system_prompt}] + state["history"][-6:] + \
                   [{"role": "user", "content": state["question"]}]
        insufficient = False
    elif not state.get("selected") and not state.get("doc_ids"):
        system_prompt = MATH_DIRECT_SYSTEM if is_math_query(state["question"]) else SYSTEM
        messages = [{"role": "system", "content": system_prompt}] + state["history"][-6:] + \
                   [{"role": "user", "content": state["question"]}]
        insufficient = False
    else:
        insufficient = state["best_score"] < s.sufficiency_threshold * 0.6
        messages = build_messages(state["question"], state["selected"], state["history"], state["memories"],
                                  state["conflicts"], pending, insufficient)
    t0 = time.time()
    parts: list[str] = []
    model = (config.get("configurable") or {}).get("model")
    task = "generate"
    if intent == "code" and s.groq_model_code and (not model or model == s.groq_model_generator):
        task, model = "code", None  # composer left on the default → use the dedicated code model
    overrides = {"model": model} if model else {}
    async for tok in gen.stream(messages, task=task, **overrides):
        parts.append(tok)
        await emit("token", {"text": tok})
    answer = "".join(parts).strip()
    timings = dict(state.get("timings", {}))
    timings["generation_ms"] = int((time.time() - t0) * 1000)
    timings["output_tokens"] = gen.count_tokens(answer)
    return {"answer": answer, "insufficient": insufficient, "timings": timings}


async def validate_node(state: RAGState, config: RunnableConfig) -> dict:
    emit = _emit(config)
    intent = state["plan"].intent
    if intent in DIRECT_INTENTS or not state.get("selected"):
        return {"citations": [], "claims": [], "validation": {"claims": 0, "supported_ratio": 1.0}}
    checks, citations, stats = await asyncio.to_thread(validate, state["answer"], state["selected"])
    payload = {"claims": [c.model_dump() for c in checks], "stats": stats}
    await emit("validation", payload)
    await emit("citations", {"items": [c.model_dump(mode="json") for c in citations]})
    await emit("agent_status", {"agent": "aggregator", "status": "completed",
                                "detail": f"{stats['supported']}/{stats['claims']} claims supported"})
    return {"citations": [c.model_dump(mode="json") for c in citations],
            "claims": payload["claims"], "validation": stats}


def build_graph():
    g = StateGraph(RAGState)
    g.add_node("recall", recall_node)
    g.add_node("plan", plan_node)
    g.add_node("execute", execute_node)
    g.add_node("aggregate", aggregate_node)
    g.add_node("correct", correct_node)
    g.add_node("generate", generate_node)
    g.add_node("validate", validate_node)
    g.add_edge(START, "recall")
    g.add_edge("recall", "plan")
    g.add_conditional_edges("plan", lambda s: "generate" if not s["plan"].steps else "execute",
                            {"generate": "generate", "execute": "execute"})
    g.add_edge("execute", "aggregate")
    g.add_conditional_edges("aggregate", route_after_aggregate, {"correct": "correct", "generate": "generate"})
    g.add_conditional_edges("correct", lambda s: "execute" if any(st.status == StepStatus.pending
                                                                  for st in s["plan"].steps) else "generate",
                            {"execute": "execute", "generate": "generate"})
    g.add_edge("generate", "validate")
    g.add_edge("validate", END)
    return g.compile()


graph = build_graph()


async def run_agentic_rag(question: str, *, user_id: str, kb_ids: list[str], history: list[dict],
                          filters: dict | None, doc_ids: list[str] | None = None, emit,
                          model: str | None = None) -> dict[str, Any]:
    state: RAGState = {"question": question, "user_id": user_id, "kb_ids": kb_ids, "doc_ids": doc_ids,
                       "history": history, "filters": filters, "selected": [], "conflicts": [], "best_score": 0.0}
    final = await graph.ainvoke(state, config={"configurable": {"emit": emit, "model": model}, "recursion_limit": 40})
    return final
