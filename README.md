# Agentic RAG

A multi-agent research assistant that mirrors the Agentic RAG architecture:

```
User ─▶ Chat UI ─▶ Aggregator Agent ──plan──▶ Agent 1 Local RAG ─▶ Local MCP  ─▶ your documents
            ▲            │  ▲                  Agent 2 Web       ─▶ DuckDuckGo / Search MCP ─▶ the web
            │            │  └── Memory          Agent 3 Cloud     ─▶ Cloud MCP  ─▶ AWS / Azure
            │            ▼   (short + long term)
            └── cited, validated answer ◀── Hugging Face Transformers LLM ◀── aggregated context
```

## How a question flows (LangGraph)

`recall → plan → execute → aggregate → [correct → execute]* → generate → validate`

1. **recall**: fetch relevant, user-approved long-term memories.
2. **plan**: the LLM classifies intent (adaptive RAG), decomposes the request into typed steps with dependencies, and picks agents. A rule-based router takes over if the LLM output is invalid.
3. **execute**: steps run in parallel by dependency level. Each agent returns normalized `Evidence` with source, locator and scores.
4. **aggregate**: global cross-encoder rerank of all evidence, near-duplicate removal, reliability weighting, prompt-injection penalty, conflict detection, and token-budgeted selection with source diversity.
5. **correct** (corrective RAG): if the best evidence is weak, rewrite the query, widen to the web and retry, bounded by `MAX_ITERATIONS`. Questions about your own documents ("the uploaded file", "my notes", attached docs) are never widened to the web unless you ask for it.
6. **generate**: a streamed answer from the local HF model, instructed to cite `[n]` and treat sources as untrusted data.
7. **validate** (Self-RAG style): every sentence is scored against the sources it cites; invalid and unsupported citations are reported.

The UI shows plans, step status, tool calls, evidence and claim checks. It never shows hidden chain-of-thought.

## Quick start (Docker, GPU)

```bash
cp .env.example .env            # pick models; add HF_TOKEN for gated models (Llama, Gemma)
docker compose up --build       # Postgres, Redis, backend on :8000, frontend on :3000

# CPU only:
docker compose -f docker-compose.yml -f docker-compose.cpu.yml up --build

# Qdrant instead of FAISS: set VECTOR_BACKEND=qdrant and add --profile qdrant
```

The first start downloads the models into the `hfcache` volume. The Models page shows loading progress.

## Local development

```bash
# Backend (Python 3.11+; Node 20 and uv are needed for the bundled MCP servers)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cu124   # or .../whl/cpu
pip install -r requirements.txt
cp ../.env.example .env
# No Postgres? Use: DATABASE_URL=sqlite+aiosqlite:///./data/rag.db
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend
npm install
npm run dev                     # http://localhost:3000
```

The smallest setup that works on a laptop CPU:

```
LLM_MODEL=Qwen/Qwen2.5-0.5B-Instruct
RERANKER_MODEL=cross-encoder/ms-marco-MiniLM-L-6-v2
USE_HYDE=false
MULTI_QUERY_COUNT=1
```

## Tests

```bash
cd backend && pytest -q
```

The suite includes a real MCP stdio round-trip (discovery, schema validation, approval gating, execution), an end-to-end LangGraph run with deterministic model doubles, and unit tests for chunking, BM25, RRF, metrics, planning, deduplication and injection guards.

`tests/test_duckduckgo_search.py` covers the DuckDuckGo tool offline (fake `ddgs` client): normalization, retries on rate limits, timeouts, fallback backend, caching, agent integration and local/web/both routing. To also run one real search: `RUN_LIVE_WEB_TESTS=1 pytest -q tests/test_duckduckgo_search.py -k live` (PowerShell: `$env:RUN_LIVE_WEB_TESTS='1'; pytest ...`).

## Code & DSA mode

Requests to write, fix or explain code, or to solve a data-structures & algorithms problem ("implement an LRU cache", "reverse a linked list in Java", pasted code with "why does this fail?"), skip document and web retrieval. They are answered directly with a coding prompt: approach, one runnable solution, time/space complexity, edge cases. Follow-ups such as "now in C++" or "optimize it" stay in code mode. Questions about your documents ("from my notes", attached files) or the web ("latest React API") are still routed normally.

The answer is written by `GROQ_MODEL_CODE` (default `openai/gpt-oss-120b`) while the composer is on the default model; picking another model in the composer overrides it, and an empty value falls back to the generator.

## Web search (DuckDuckGo)

Web research works out of the box with **DuckDuckGo** through the [`ddgs`](https://pypi.org/project/ddgs/) package. It is free and needs no API key; it is installed by `requirements.txt` (`pip install ddgs` on its own).

- **Provider choice** (`WEB_SEARCH_PROVIDER`): `auto` (default) uses a connected search MCP server such as brave-search if there is one, otherwise DuckDuckGo, and also falls back to DuckDuckGo when the MCP search finds nothing. `duckduckgo` always uses DuckDuckGo, `mcp` only MCP servers, `none` disables search.
- **Routing**: the Aggregator sends document questions to local RAG, external or current questions ("latest", "news", "search the web", URLs…) to web research, and questions that need both to the two agents in parallel. Their evidence is reranked together and cited with the original URLs.
- **Reading pages**: if the `fetch` MCP server is connected, the top results are read in full. Otherwise the search snippets are used as (lower-weighted) evidence.
- **Resilience**: each search is time-boxed (`DDG_TIMEOUT_S`), retried with exponential backoff on rate limits and timeouts (`DDG_MAX_RETRIES`), falls back to the `ddgs` metasearch when DuckDuckGo returns nothing (`DDG_FALLBACK_BACKEND`, empty to disable), and cached for `DDG_CACHE_TTL_S` seconds. Failures are reported in the trace and audit log (server `duckduckgo`), never raised.
- **Options**: `DDG_REGION` (`us-en`, `uk-en`, `in-en`, `wt-wt` = no region…), `DDG_SAFESEARCH` (`on` / `moderate` / `off`), `DDG_MAX_RESULTS`.

Use it from code:

```python
from app.tools.duckduckgo_search import search_web, asearch_web

res = search_web("FastAPI lifespan events", max_results=5, region="us-en", safesearch="moderate")
if res.ok:
    for r in res.results:            # WebSearchResult(title, url, description, source, provider)
        print(r.title, r.url, r.source)
else:
    print(res.error_type, res.error) # invalid_input | rate_limited | timeout | unavailable | error
```

Or over HTTP: `GET /api/tools/web-search?q=fastapi+lifespan&max_results=5&region=us-en&safesearch=moderate&timelimit=w`. It returns `{query, results: [{title, url, description, source, provider}], backend, cached, duration_ms}`. Errors map to 422 (bad input), 429 (rate-limited), 503 (ddgs missing), 504 (timeout) or 502.

> `ddgs` is an **unofficial** client, not a guaranteed API. DuckDuckGo can rate-limit or change its pages at any time. For guaranteed availability, enable the `brave-search` MCP server (it takes priority under `auto`).

## MCP servers

Servers are configured in `backend/mcp_servers.json` or on the **Tools** page. Values written as `${VAR}` are read from the backend environment, so secrets never sit in the config file.

| Server | Category | On by default | Needs |
|---|---|---|---|
| filesystem | local | yes (read-only rules) | `npx` |
| fetch | search | yes | `uvx` |
| brave-search | search | no | `BRAVE_API_KEY` (optional; DuckDuckGo is used without it) |
| aws-docs | cloud | no | `uvx` |
| azure | cloud | no (`--read-only`) | `az login` |

Agents find tools by **category**, so you can swap in any search or cloud server.

Each server has a policy of `allow`, `deny` and `approval_required` globs. Tools marked `destructiveHint`, and write-like tools on cloud, database and GitHub servers, wait in the approval queue. Every call is validated against its JSON schema, retried once on transient failure, timed out, and audit-logged with secrets redacted.

**Adding agents:** `POST /api/agents` with `{name, display_name, description, category | server}` registers an MCP-tool agent (GitHub, SQL, browser…) that the planner can route to immediately. For custom Python agents, subclass `BaseAgent` and call `registry.register()` in `app/main.py`.

## Configuration highlights

| Setting | Purpose |
|---|---|
| `LLM_MODEL`, `LLM_QUANTIZATION` | Any chat-templated HF model; `4bit` / `8bit` via bitsandbytes (CUDA) |
| `EMBEDDING_MODEL` | bge, e5, bge-m3 or Qwen3-Embedding (query/document prefixes handled). Changing it requires re-indexing |
| `RERANKER_MODEL` | Cross-encoder used for reranking *and* claim validation |
| `CHUNK_STRATEGY` | `structure` (default), `recursive`, `fixed`, `sliding` or `semantic`; always parent-child |
| `VECTOR_BACKEND` | `faiss` or `qdrant`, behind a common `VectorStore` interface |
| `SUFFICIENCY_THRESHOLD`, `MAX_ITERATIONS` | When to run corrective retrieval, and how many rounds |
| `API_KEY` | Require `X-API-Key` on every API call |
| `WEB_SEARCH_PROVIDER`, `DDG_*` | Web search provider and DuckDuckGo options (see [Web search](#web-search-duckduckgo)) |

Generation and retrieval settings can also be changed live on the **Models** page.

## Project layout

```
backend/app/
  core/           config, logging, typed schemas (Evidence, PlanStep, Citation…)
  models/         Transformers manager: generator (streaming), embedder, reranker
  ingestion/      parsers (PDF pages, DOCX headings, Markdown, HTML, CSV, code), chunking, pipeline
  retrieval/      FAISS/Qdrant stores, BM25, RRF, hybrid retriever, knowledge bases
  agents/         base + registry + ReAct tool loop, local_rag, web_research, cloud
  tools/          native tools agents call directly (duckduckgo_search)
  mcp/            MCP client manager, permissions, approvals, audit log
  orchestration/  planner + LangGraph graph (the Aggregator Agent)
  context/        evidence aggregation
  generation/     grounded prompts, citation and claim validation
  memory/         SQLAlchemy models, short- and long-term memory service
  evaluation/     metrics + benchmark runner (Ragas export)
  security/       path traversal, upload validation, injection isolation, API key
  api/routes/     chat (SSE), knowledge, system (MCP, agents, models, memory, eval, analytics)
frontend/         Next.js 14 app router, Tailwind, shadcn-style UI, Framer Motion
```

## Evaluation

The **Quality** page runs a benchmark from a JSON list of `{question, expected_sources, ground_truth?}`. It reports:

- Retrieval: Recall@k, Precision@k, MRR, nDCG@k, context precision and context recall.
- Answers: faithfulness (share of supported claims), answer relevancy and citation correctness.
- Cost: latency and token counts.

Each run is stored for comparison. **Download Ragas dataset** exports `user_input / response / retrieved_contexts / reference` records for `ragas.evaluate`.

## Known limits

- No OCR: scanned PDFs are rejected with a hint to run `ocrmypdf` first.
- No image, audio or video retrieval, and no knowledge-graph retrieval yet.
- Chroma and pgvector backends are not implemented; the `VectorStore` interface is where they go.
- Auth is a single API key; there is no per-user role-based access.
- Settings changed in the UI reset on restart.
- Knowledge-base chunk metadata lives in JSONL files next to the index; very large corpora should move it to Postgres.
