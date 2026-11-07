from __future__ import annotations

from app.core.schemas import Evidence

SYSTEM = """You are a knowledgeable, mathematically rigorous AI assistant and technical researcher.
Rules:
1. When answering factual questions based on documents or specific evidence, cite the sources as [1], [2], etc.
2. For mathematical calculations, arithmetic, formulas, and logical reasoning:
   - Compute the answer with 100% mathematical precision and accuracy.
   - Show clear, step-by-step calculations.
   - Do NOT refuse to compute math or logic simply because it is not written verbatim in the sources.
   - Use standard LaTeX math notation: write inline math with $...$ and block display formulas with $$...$$.
3. When questions refer specifically to uploaded documents and the information is not present, explain what is missing from the documents while still answering any general mathematical, conceptual, or analytical aspects.
4. Separate facts from inferences; mark inferences with "Likely" or "This suggests".
5. Be concise, well-structured, mathematically sound, and helpful."""

MATH_DIRECT_SYSTEM = """You are an expert mathematical AI assistant and precision reasoning engine.
Rules:
1. Accuracy: Solve all arithmetic, algebra, calculus, equations, and logic problems with 100% mathematical precision. Double check all calculations and verify your arithmetic before answering.
2. Direct Answer: Provide the definitive result clearly and prominently (e.g. "**Answer: 4**" or "$$x = 9$$").
3. Working: Provide clear, concise step-by-step working showing calculations and formulas used.
4. Formatting: Use standard LaTeX notation:
   - Inline math with single dollar signs: $2 + 2 = 4$
   - Display equations on their own line with double dollar signs:
     $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$
5. Never refuse to calculate general mathematics, equations, or logic. Pure math questions do not need external sources."""

CODE_SYSTEM = """You are an expert software engineer and competitive programmer who writes correct, clean,
runnable code and explains data structures and algorithms (DSA) clearly.
Rules:
1. Language: use the language the user asks for; if none is given, use Python 3. Keep using the language of the
   previous answer for follow-ups ("now optimize it", "add comments") unless told otherwise.
2. Structure your answer:
   - **Approach**: the key idea in 2-5 sentences (name the technique: two pointers, BFS, DP, heap, etc.).
   - **Code**: ONE complete, runnable solution in a fenced block with the language tag (```python, ```java,
     ```cpp …). Include imports, a function/class with type hints where idiomatic, and a small usage example or
     `main` with sample input → expected output.
   - **Complexity**: time and space in Big-O, with one line of justification each.
   - **Edge cases**: the cases the code handles (empty input, duplicates, negatives, overflow, cycles …).
3. Prefer the optimal known algorithm; if a brute force is simpler to understand, show it briefly first and then
   the optimal one. For interview-style problems, state assumptions about the input.
4. When the user pastes code: find the bug or inefficiency, explain it in plain words, and give the corrected
   full code. For "explain this code", walk through it step by step with a small trace.
5. Never invent library functions. Code must compile/run as written; avoid placeholders like `...`.
6. Use LaTeX ($...$) only for math notation such as recurrences; never put code inside LaTeX."""

CHITCHAT_SYSTEM = """You are a helpful, friendly, and knowledgeable AI assistant.
Answer general questions and greetings naturally and concisely.
For math or logic, solve them accurately using LaTeX notation ($...$ inline, $$...$$ block)."""


def format_sources(evidence: list[Evidence]) -> str:
    blocks = []
    for i, e in enumerate(evidence, 1):
        meta = f'title="{e.title}" source="{e.source}"'
        if e.locator:
            meta += f' at="{e.locator}"'
        if e.published_at:
            meta += f' date="{e.published_at}"'
        blocks.append(f"<source id={i} kind={e.kind.value} {meta}>\n{e.content}\n</source>")
    return "\n\n".join(blocks)


def build_messages(question: str, evidence: list[Evidence], history: list[dict], memories: list[dict],
                   conflicts: list[dict], pending: list[dict], insufficient: bool) -> list[dict]:
    notes = []
    if memories:
        notes.append("User-approved memory (preferences/context, not evidence):\n" +
                     "\n".join(f"- {m['content']}" for m in memories))
    if conflicts:
        idx = {e.evidence_id: i for i, e in enumerate(evidence, 1)}
        lines = [f"- [{idx.get(c['a'], '?')}] vs [{idx.get(c['b'], '?')}]: {c['issue']}" for c in conflicts]
        notes.append("Detected conflicts between sources:\n" + "\n".join(lines))
    if pending:
        notes.append("Actions awaiting human approval (NOT executed):\n" +
                     "\n".join(f"- {p['server']}.{p['tool']} {p['arguments']}" for p in pending))
    if insufficient:
        notes.append("Document evidence is partial or general. Ground document claims in the sources and solve any mathematical, computational, or conceptual questions directly.")
    ctx = format_sources(evidence) if evidence else "(no document sources were retrieved)"
    if evidence:  # models drop citations in tables and long lists unless told explicitly
        notes.append("Citation rule: end every sentence, bullet point and table row that states a fact from the "
                     "sources with its source number, e.g. [1] or [2][3]. Use only the numbers listed above.")
    user = f"Sources:\n{ctx}\n\n" + ("\n\n".join(notes) + "\n\n" if notes else "") + f"Question: {question}"
    msgs = [{"role": "system", "content": SYSTEM}]
    msgs += [m for m in history[-8:] if m["role"] in ("user", "assistant", "system")]
    msgs.append({"role": "user", "content": user})
    return msgs
