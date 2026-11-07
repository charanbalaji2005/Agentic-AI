"""Structured planner: intent classification (adaptive RAG), decomposition, agent selection, dependencies."""
from __future__ import annotations

import json
import re

from app.agents.base import registry
from app.core.logging import log
from app.core.schemas import Plan, PlanStep
from app.models.manager import get_models
from app.retrieval.knowledge_base import kb_registry

FRESH = re.compile(r"\b(latest|today|current|news|recent|this (week|month|year)|20\d\d|price|release|announc)", re.I)
CLOUD = re.compile(r"\b(aws|azure|ec2|s3|lambda|iam|vpc|cloudwatch|aks|eks|subscription|resource group|"
                   r"deployment|bucket|vm|cosmos|cloud ?formation|bicep)\b", re.I)
CHAT = re.compile(r"^\s*(hi|hello|hey|thanks|thank you|good (morning|evening)|ok|cool)[!. ]*$", re.I)
URL = re.compile(r"https?://")
# The user explicitly wants outside information.
EXTERNAL = re.compile(r"\b(search (the )?(web|internet|online)|web search|on the (web|internet)|online|google|"
                      r"look (it |this |that )?up|industry|competitors?|wikipedia|external (sources?|info\w*)|"
                      r"outside (of )?(the|my|these|our) (docs?|documents?|files?))\b", re.I)
# The user explicitly scopes the question to their own documents.
DOC_ONLY = re.compile(r"\b(in|from|according to|based on) (the|this|my|these|our) (uploaded |attached )?"
                      r"(docs?|documents?|files?|pdfs?|notes|report|paper|slides)\b", re.I)
# The question refers to the user's own material ("the uploaded file", "this document", "my notes").
DOC_REF = re.compile(r"\b(uploaded|attached)\b|\b(this|these|my|our) (docs?|documents?|files?|pdfs?|notes|report|"
                     r"paper|slides)\b|\bthe (docs?|documents?|files?|pdfs?|slides)\b", re.I)


def wants_web(question: str) -> bool:
    """The user explicitly asks for outside information (web search, a URL, industry, etc.)."""
    return bool(EXTERNAL.search(question) or URL.search(question))


def document_scoped(question: str, doc_ids: list[str] | None = None) -> bool:
    """The question is about the user's own documents and doesn't ask for the web. Corrective RAG must
    not widen such questions to web search: generic web pages would crowd out the documents."""
    if wants_web(question):
        return False
    return bool(doc_ids) or bool(DOC_ONLY.search(question) or DOC_REF.search(question))


def is_math_query(q: str) -> bool:
    """Detect whether a query is primarily a mathematical computation or equation."""
    s = q.strip()
    if not s:
        return False
    # Pure arithmetic expression: e.g. "2+2", "15 * (3 + 4) / 2", "sqrt(16) + 5", "3x + 15 = 42"
    if re.match(r"^[\d\s\+\-\*\/\^\(\)\.\,\%\=\!\>\<\\\|\_\{\}\[\]\:\;a-zA-Z]{1,80}$", s) and any(c in s for c in "+-*/^=%"):
        digits = sum(c.isdigit() for c in s)
        math_ops = sum(c in "+-*/^=%" for c in s)
        if digits >= 1 and math_ops >= 1:
            return True
    # Natural language math requests: "calculate...", "solve...", "what is 25 * 4"
    if re.search(r"^\s*(what is|calculate|compute|solve|eval|evaluate|find|how much is|simplify|derivative of|integral of|factor)\b.*[\d\+\-\*\/\^=]", s, re.I):
        return True
    return False


# ---- coding / DSA detection -------------------------------------------------------------------
CODE_LANG = re.compile(r"\b(python|java|javascript|typescript|c\+\+|cpp|c#|csharp|golang|rust|kotlin|swift|ruby|php|"
                       r"sql|bash|scala|dart|haskell|js|ts|node\.?js|react)\b|(?<!\w)c\+\+", re.I)
CODE_VERB = re.compile(r"\b(write|implement|code|program|create|build|generate|solve|optimi[sz]e|debug|fix|refactor|"
                       r"convert|translate|reverse|traverse|sort|merge|find|detect|design|explain|dry ?run|trace)\b", re.I)
CODE_NOUN = re.compile(r"\b(code|program|function|method|class|script|algorithm|solution|snippet|implementation|"
                       r"regex|data structure|recursion|recursive|iterative|loop|compiler error|stack ?trace|"
                       r"exception|bug)\b", re.I)
# Unambiguous DSA vocabulary: enough on its own.
DSA_STRONG = re.compile(
    r"\b(linked ?lists?|doubly linked|binary search( tree)?|bst|avl tree|red[- ]black tree|tries?|segment tree|fenwick|"
    r"heaps?|min[- ]?heap|max[- ]?heap|priority queue|hash ?(map|table|set)|deque|stacks? and queues?|"
    r"dfs|bfs|depth[- ]first|breadth[- ]first|dijkstra|bellman[- ]ford|floyd[- ]warshall|kruskal|prim'?s|"
    r"topological sort|union[- ]find|disjoint set|minimum spanning tree|shortest path|"
    r"dynamic programming|memoi[sz]ation|tabulation|backtracking|greedy algorithm|divide and conquer|"
    r"two[- ]pointers?|sliding window|prefix sums?|kadane|knapsack|longest (common|increasing) sub\w+|lcs|lis|"
    r"merge ?sort|quick ?sort|heap ?sort|bubble sort|insertion sort|selection sort|counting sort|radix sort|"
    r"lru cache|lfu cache|n[- ]queens?|sudoku solver|tower of hanoi|two sum|three sum|"
    r"leetcode|hackerrank|codeforces|codechef|geeksforgeeks|gfg|time complexity|space complexity|big[- ]?o)\b", re.I)
# Generic words that are DSA only next to a coding verb or language ("sort an array", "graph in python").
DSA_WEAK = re.compile(r"\b(arrays?|strings?|lists?|trees?|graphs?|matri(x|ces)|grids?|queues?|stacks?|nodes?|"
                      r"subarrays?|subsequences?|substrings?|permutations?|combinations?|subsets?|palindromes?|"
                      r"anagrams?|fibonacci|factorial|primes?|gcd|sorting|searching|intervals?)\b", re.I)
CODE_SHAPE = re.compile(r"```|^\s*(def |class |import |from \w+ import|#include|public (static )?\w+|function |"
                        r"const \w+ ?=|let \w+ ?=|for ?\(|while ?\(|if ?\(|return )", re.M)
# Narrower than DOC_REF: "reads the file" in a coding task is not about the user's documents.
CODE_DOC_REF = re.compile(r"\b(uploaded|attached)\b|\b(my|our) (docs?|documents?|notes|pdfs?|slides|report|files)\b|"
                          r"\b(in|from|according to|based on) (my|our|these|the uploaded|the attached) "
                          r"(docs?|documents?|files?|pdfs?|notes|report|paper|slides)\b", re.I)
# Narrower than FRESH: "current node" or "stock prices" are normal DSA wording.
CODE_FRESH = re.compile(r"\b(latest|newest|news|today|this (week|month|year)|20\d\d|releases?|released|"
                        r"release notes|announc\w*)\b", re.I)


def is_code_query(question: str, doc_ids: list[str] | None = None, history: list[dict] | None = None) -> bool:
    """A request to write, fix or explain code / a DSA problem that the model should answer directly,
    without document or web retrieval. Document- or web-scoped questions are never treated as code."""
    q = question.strip()
    if not q or doc_ids:
        return False
    if "```" in q:  # pasted code is unambiguous
        return True
    if CODE_DOC_REF.search(q) or wants_web(q):
        return False
    if CODE_SHAPE.search(q) or DSA_STRONG.search(q):
        return True
    if CODE_FRESH.search(q):  # "latest React API" needs the web, not just the model
        return False
    verb, lang = bool(CODE_VERB.search(q)), bool(CODE_LANG.search(q))
    if (verb or lang) and (CODE_NOUN.search(q) or DSA_WEAK.search(q)):
        return True
    if lang and verb:
        return True
    # Follow-ups to a code answer: "now in Java", "optimize it", "explain the complexity".
    last = next((m["content"] for m in reversed(history or []) if m.get("role") == "assistant"), "")
    return "```" in last and (lang or verb or bool(CODE_NOUN.search(q)) or bool(re.search(r"\b(complexity|faster|"
                              r"optimal|edge cases?|comments?|test cases?|it|this)\b", q, re.I)))


def code_plan() -> Plan:
    return Plan(intent="code", rationale="Coding / DSA request — written directly by the code model", steps=[])


def heuristic_plan(question: str, kb_ids: list[str], doc_ids: list[str] | None = None,
                   history: list[dict] | None = None) -> Plan:
    """Rule-based routing: local RAG for document questions, web search for external or current
    information, both when a question needs documents plus outside facts."""
    if is_code_query(question, doc_ids, history):  # before math: "nums = [2,7,11]" is code, not arithmetic
        return code_plan()
    if is_math_query(question) and not doc_ids:
        return Plan(intent="math", rationale="Mathematical calculation — direct computation", steps=[])
    if CHAT.match(question) and not doc_ids:
        return Plan(intent="chitchat", rationale="Greeting — no retrieval needed")
    avail = {a.name for a in registry.available()}
    has_docs = bool(doc_ids) or any(kb_registry.kbs.get(k) and kb_registry.kbs[k].chunks for k in kb_ids)
    steps = []
    if has_docs:
        args = {"doc_ids": doc_ids} if doc_ids else {}
        steps.append(PlanStep(task_id="t1", description="Search local documents", agent="local_rag", query=question, arguments=args))
    if "cloud" in avail and CLOUD.search(question):
        steps.append(PlanStep(task_id=f"t{len(steps) + 1}", description="Query cloud tools", agent="cloud", query=question))
    fresh = bool(FRESH.search(question)) and not (has_docs and document_scoped(question))
    if "web_research" in avail and (wants_web(question) or fresh or not steps):
        steps.append(PlanStep(task_id=f"t{len(steps) + 1}", description="Research the web", agent="web_research", query=question))
    intent = "document_task" if doc_ids else ("cloud_ops" if any(s.agent == "cloud" for s in steps) else "question")
    used = [s.agent for s in steps]
    route = ("local documents + web" if {"local_rag", "web_research"} <= set(used)
             else "web" if used == ["web_research"] else ", ".join(used) or "none")
    return Plan(intent=intent, rationale=f"Rule-based routing ({route})", steps=steps)


async def make_plan(question: str, history: list[dict], kb_ids: list[str], memories: list[dict],
                    doc_ids: list[str] | None = None) -> Plan:
    if is_code_query(question, doc_ids, history):  # deterministic and skips a planner LLM round-trip
        return code_plan()
    gen = get_models().generator
    agents = registry.available()
    if gen.model is None or not agents:
        return heuristic_plan(question, kb_ids, doc_ids, history)
    kb_info = [kb_registry.kbs[k].stats() for k in kb_ids if k in kb_registry.kbs]
    catalog = [{"agent": a.name, "does": a.description, "arguments": a.argument_hints} for a in agents]
    recent = "\n".join(f"{m['role']}: {m['content'][:300]}" for m in history[-4:])
    attached_note = f"\nUser attached specific document IDs: {doc_ids}. ALWAYS prioritize querying local_rag with these documents." if doc_ids else ""
    prompt = f"""Create an execution plan for the user's request.{attached_note}

Agents:
{json.dumps(catalog, indent=1)}

Knowledge bases in scope: {json.dumps(kb_info)}
User memory: {json.dumps([m['content'] for m in memories])}
Recent conversation:
{recent or '(none)'}

Request: {question}

Rules:
- intent: "chitchat" (no steps), "math" (for mathematical calculations, arithmetic, formulas; no steps), "code" (write/fix/explain code or a data-structures & algorithms problem that does not depend on the user's documents or the web; no steps), "question", "research", "cloud_ops", or "document_task".
- If the request is a direct math problem, equation, calculation, or greeting that does NOT require uploaded documents, set intent="math" or "chitchat" with steps=[].
- Resolve pronouns from the conversation into self-contained step queries.
- Split multi-part requests into separate steps. Independent steps have empty depends_on.
- Use only listed agents.
- Source routing:
  * Calculations, arithmetic, math, logic puzzles, greetings → steps=[] (intent="math" or "chitchat").
  * Attached documents or questions specifically asking about uploaded/local docs → local_rag.
  * External, public or current facts (news, web, online) → web_research.
  * When documents are attached or question specifically asks about uploaded data, use local_rag.
- rationale: one short user-facing sentence.
Reply with JSON only:
{{"intent":"question","rationale":"...","steps":[{{"task_id":"t1","description":"...","agent":"local_rag","query":"...","arguments":{{}},"depends_on":[]}}]}}"""
    try:
        data = await gen.generate_json([{"role": "system", "content": "You are a planning module. JSON only."},
                                        {"role": "user", "content": prompt}], task="plan", max_new_tokens=500)
        plan = Plan.model_validate(data)
        names = {a.name for a in agents}
        ids = set()
        clean = []
        for st in plan.steps[:6]:
            if st.agent not in names or not st.query.strip():
                continue
            if doc_ids and st.agent == "local_rag" and "doc_ids" not in st.arguments:
                st.arguments["doc_ids"] = doc_ids
            st.depends_on = [d for d in st.depends_on if d in ids]
            ids.add(st.task_id)
            clean.append(st)
        plan.steps = clean
        if plan.intent in ("chitchat", "math", "direct", "code") and not plan.steps:
            return plan
        if is_math_query(question) and not doc_ids:
            return Plan(intent="math", rationale="Mathematical calculation — direct computation", steps=[])
        if plan.intent != "chitchat" and not plan.steps:
            return heuristic_plan(question, kb_ids, doc_ids)
        return plan
    except Exception as e:  # noqa: BLE001
        log.warning("planner.fallback", error=str(e))
        return heuristic_plan(question, kb_ids, doc_ids)


def dependency_levels(steps: list[PlanStep]) -> list[list[PlanStep]]:
    """Topological levels: steps in one level run in parallel."""
    done: set[str] = set()
    remaining = [s for s in steps if s.status.value == "pending"]
    levels = []
    while remaining:
        ready = [s for s in remaining if all(d in done for d in s.depends_on)]
        if not ready:  # cycle or missing dependency: run the rest anyway
            ready = remaining
        levels.append(ready)
        done.update(s.task_id for s in ready)
        remaining = [s for s in remaining if s not in ready]
    return levels


async def corrective_query(question: str, weak_hint: str) -> str:
    gen = get_models().generator
    if not gen.is_ready:
        return question
    try:
        out = await gen.generate([{"role": "system", "content": "Rewrite the search query to find better "
                                   "evidence. Output only the query."},
                                  {"role": "user", "content": f"Original: {question}\nWhat we found was weak: {weak_hint}"}],
                                 task="fast", max_new_tokens=60, temperature=0)
        return out.strip().strip('"')[:300] or question
    except Exception:  # noqa: BLE001
        return question
