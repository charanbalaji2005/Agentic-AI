"""Environment-driven configuration. Every model, store and limit is swappable via .env."""
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Agentic RAG"
    environment: Literal["dev", "prod", "production", "development"] = "dev"
    log_level: str = "INFO"
    api_key: str | None = None  # if set, every request must send X-API-Key
    cors_origins: list[str] = ["http://localhost:3000"]

    # --- LLM Provider & Groq -------------------------------------------------
    llm_provider: Literal["groq", "hf"] = "groq"
    groq_api_key: str = ""
    groq_base_url: str = "https://api.groq.com/openai/v1"
    groq_model_planner: str = "openai/gpt-oss-120b"
    groq_model_generator: str = "qwen/qwen3.8-27b"
    groq_model_fast: str = "qwen/qwen3.8-27b"
    groq_model_validator: str = "openai/gpt-oss-20b"
    # Writes answers to coding / DSA questions (strong reasoning model). Used when the composer is on the
    # default model; picking another model in the composer overrides it. Empty = use the generator.
    groq_model_code: str = "openai/gpt-oss-120b"

    # --- Hugging Face models -------------------------------------------------
    hf_token: str | None = None
    hf_cache_dir: str | None = None
    llm_model: str = "Qwen/Qwen2.5-3B-Instruct"
    llm_device: Literal["auto", "cuda", "cpu", "mps"] = "auto"
    llm_quantization: Literal["none", "4bit", "8bit"] = "none"
    llm_dtype: Literal["auto", "float16", "bfloat16", "float32"] = "auto"
    llm_max_context: int = 8192
    llm_max_new_tokens: int = 1024
    llm_temperature: float = 0.2
    llm_top_p: float = 0.9
    embedding_model: str = "BAAI/bge-small-en-v1.5"
    embedding_query_prefix: str = "Represent this sentence for searching relevant passages: "
    embedding_doc_prefix: str = ""
    reranker_model: str = "BAAI/bge-reranker-v2-m3"
    device: Literal["auto", "cuda", "cpu", "mps"] = "auto"  # for embedder/reranker

    # --- Storage --------------------------------------------------------------
    database_url: str = "postgresql+asyncpg://rag:rag@localhost:5432/agentic_rag"
    redis_url: str | None = None
    vector_backend: Literal["faiss", "qdrant"] = "faiss"
    qdrant_url: str = "http://localhost:6333"
    qdrant_api_key: str | None = None
    data_dir: Path = Path("./data")
    max_upload_mb: int = 50

    # --- Chunking -------------------------------------------------------------
    chunk_strategy: Literal["recursive", "fixed", "sliding", "structure", "semantic"] = "structure"
    chunk_size: int = 800          # characters for child chunks
    chunk_overlap: int = 120
    parent_chunk_size: int = 2400  # parent-child retrieval
    contextual_headers: bool = True  # prepend doc title/section to chunk text before embedding

    # --- Retrieval ------------------------------------------------------------
    dense_top_k: int = 30
    sparse_top_k: int = 30
    rrf_k: int = 60
    rerank_top_k: int = 8
    rerank_min_score: float = 0.05
    multi_query_count: int = 3
    use_hyde: bool = True
    context_token_budget: int = 3500

    # --- Agent loop -----------------------------------------------------------
    max_iterations: int = 3
    sufficiency_threshold: float = 0.35  # min best rerank score to consider evidence sufficient
    claim_support_threshold: float = 0.15
    tool_timeout_s: float = 45.0
    mcp_config_path: Path = Path("./mcp_servers.json")

    # --- Web search -----------------------------------------------------------
    # auto: use a connected search MCP server (e.g. brave-search) if any, else DuckDuckGo.
    # mcp: only MCP search servers. duckduckgo: always DuckDuckGo. none: no web search (fetch-only).
    web_search_provider: Literal["auto", "mcp", "duckduckgo", "none"] = "auto"
    ddg_region: str = "us-en"            # ddgs region code; "wt-wt" = no region
    ddg_safesearch: Literal["on", "moderate", "off"] = "moderate"
    ddg_max_results: int = 8
    ddg_timeout_s: int = 10
    ddg_max_retries: int = 2             # retries on rate limit / timeout, with exponential backoff
    ddg_retry_backoff_s: float = 1.0
    ddg_backend: str = "duckduckgo"      # ddgs backend; DuckDuckGo first
    ddg_fallback_backend: str = "auto"   # used when the primary returns nothing; "" disables
    ddg_cache_ttl_s: int = 300           # in-process result cache; 0 disables

    @property
    def upload_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def index_dir(self) -> Path:
        return self.data_dir / "indexes"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.upload_dir.mkdir(parents=True, exist_ok=True)
    s.index_dir.mkdir(parents=True, exist_ok=True)
    return s
