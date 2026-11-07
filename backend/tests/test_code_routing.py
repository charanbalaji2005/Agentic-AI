"""Coding / DSA requests are answered directly by the code model, without document or web retrieval."""
import pytest

from app.core.config import get_settings
from app.core.schemas import Plan
from app.orchestration.planner import heuristic_plan, is_code_query

CODE_ANSWER = [{"role": "user", "content": "reverse a linked list"},
               {"role": "assistant", "content": "**Approach** ...\n```python\ndef reverse(head): ...\n```"}]


@pytest.mark.parametrize("q", [
    "Implement an LRU cache in Python",
    "reverse a linked list in Java",
    "Write a function to check if a string is a palindrome",
    "Two sum problem: nums = [2,7,11,15], target = 9",
    "```python\ndef f(x): return x+\n```\nwhy does this fail?",
    "What is the time complexity of merge sort?",
    "best time to buy and sell stock prices using dynamic programming",
    "sort an array of 0s, 1s and 2s",
    "write a program that reads the file and counts words",
    "find the in-order successor of the current node in a BST",
    "Explain Dijkstra's algorithm with code",
    "solve N-Queens in C++",
])
def test_detects_code_and_dsa_requests(q):
    assert is_code_query(q)


@pytest.mark.parametrize("q,doc_ids", [
    ("Summarize the key points in the uploaded document.", None),
    ("Explain binary search from my notes", None),
    ("What is the latest Python release?", None),
    ("write code using the latest React API", None),
    ("search the web for dijkstra implementations", None),
    ("Who won the most recent F1 race?", None),
    ("What is 25 * 4?", None),
    ("hello", None),
    ("Implement the algorithm described here", ["doc1"]),  # attached docs → document task
])
def test_leaves_other_requests_alone(q, doc_ids):
    assert not is_code_query(q, doc_ids)


def test_follow_ups_to_a_code_answer_stay_in_code_mode():
    assert is_code_query("now in Java", history=CODE_ANSWER)
    assert is_code_query("can you optimize it?", history=CODE_ANSWER)
    assert not is_code_query("now in Java")  # no code context


def test_heuristic_plan_routes_code_directly_and_keeps_math():
    plan = heuristic_plan("Implement a min-heap in Python", ["default"])
    assert plan.intent == "code" and plan.steps == []
    assert heuristic_plan("15 * (3 + 4)", ["default"]).intent == "math"


class RecordingGenerator:
    model = object()
    is_ready = True

    def __init__(self):
        self.calls = []

    def count_tokens(self, t):
        return len(t) // 4

    async def stream(self, messages, task="generate", **kw):
        self.calls.append({"task": task, "system": messages[0]["content"], **kw})
        yield "```python\nprint(1)\n```"


@pytest.mark.parametrize("chosen,expected_task,expected_model", [
    (None, "code", None),                       # no choice → code model
    ("__default__", "code", None),              # composer on the default model → code model
    ("someone/other-model", "generate", "someone/other-model"),  # explicit pick wins
])
async def test_code_answers_use_code_prompt_and_model(monkeypatch, chosen, expected_task, expected_model):
    from app.models.manager import get_models
    from app.orchestration.graph import generate_node
    s = get_settings()
    gen = RecordingGenerator()
    monkeypatch.setattr(get_models(), "generator", gen)
    model = s.groq_model_generator if chosen == "__default__" else chosen
    state = {"question": "Implement quicksort", "plan": Plan(intent="code"), "history": [], "results": [],
             "selected": [], "best_score": 0.0}
    out = await generate_node(state, {"configurable": {"model": model}})
    call = gen.calls[0]
    assert call["task"] == expected_task and call.get("model") == expected_model
    assert "competitive programmer" in call["system"]
    assert out["answer"].startswith("```python")
