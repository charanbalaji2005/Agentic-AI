"""Hugging Face Transformers model manager.

Loads/unloads/swaps the generator LLM, embedder and reranker at runtime.
Supports CUDA / MPS / CPU, 4-bit & 8-bit (bitsandbytes), streaming via TextIteratorStreamer.
"""
from __future__ import annotations

import asyncio
import gc
import json
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

import numpy as np
import torch
from transformers import (
    AutoModelForCausalLM,
    AutoModelForSequenceClassification,
    AutoTokenizer,
    BitsAndBytesConfig,
    GenerationConfig,
    TextIteratorStreamer,
)

from app.core.config import Settings, get_settings
from app.core.logging import log
from app.models.groq_client import GroqClient


def resolve_device(pref: str) -> str:
    if pref != "auto":
        return pref
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def resolve_dtype(pref: str, device: str):
    if pref == "auto":
        if device == "cuda":
            return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        return torch.float16 if device == "mps" else torch.float32
    return {"float16": torch.float16, "bfloat16": torch.bfloat16, "float32": torch.float32}[pref]


@dataclass
class ModelStatus:
    name: str | None = None
    state: str = "unloaded"  # unloaded | loading | ready | error
    device: str | None = None
    error: str | None = None
    load_seconds: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class Generator:
    """Causal LM wrapper (Qwen / Llama / Mistral / Gemma instruct) or Groq multi-model client."""

    def __init__(self, s: Settings):
        self.s = s
        self.model = None
        self.tokenizer = None
        self.status = ModelStatus()
        self.groq_client: GroqClient | None = None
        self._lock = threading.Lock()  # one generate() at a time per GPU

    @property
    def is_ready(self) -> bool:
        return self.status.state == "ready" and (self.model is not None or self.groq_client is not None)

    def load(self, name: str | None = None, quantization: str | None = None) -> None:
        self.unload()

        # If configured for Groq, initialize the multi-model Groq client
        if self.s.llm_provider == "groq" and self.s.groq_api_key:
            self.status = ModelStatus(name="Groq Multi-Model Suite", state="loading")
            try:
                self.groq_client = GroqClient(self.s)
                self.model = self.groq_client  # truthy object for compatibility checks
                self.status = ModelStatus(
                    name="Groq Multi-Model Suite",
                    state="ready",
                    device="groq-cloud",
                    load_seconds=0.1,
                    extra={
                        "provider": "groq",
                        "planner": self.s.groq_model_planner,
                        "generator": self.s.groq_model_generator,
                        "fast": self.s.groq_model_fast,
                        "validator": self.s.groq_model_validator,
                    },
                )
                log.info(
                    "llm.loaded_groq",
                    planner=self.s.groq_model_planner,
                    generator=self.s.groq_model_generator,
                    fast=self.s.groq_model_fast,
                )
                return
            except Exception as e:  # noqa: BLE001
                self.status = ModelStatus(name="Groq Multi-Model Suite", state="error", error=str(e))
                log.error("llm.groq_load_failed", error=str(e))
                raise

        name = name or self.s.llm_model
        quantization = quantization or self.s.llm_quantization
        self.status = ModelStatus(name=name, state="loading")
        t0 = time.time()
        try:
            device = resolve_device(self.s.llm_device)
            dtype = resolve_dtype(self.s.llm_dtype, device)
            kwargs: dict[str, Any] = {"token": self.s.hf_token, "cache_dir": self.s.hf_cache_dir}
            self.tokenizer = AutoTokenizer.from_pretrained(name, **kwargs)
            if quantization in ("4bit", "8bit"):
                if device != "cuda":
                    raise RuntimeError("bitsandbytes quantization requires a CUDA GPU")
                kwargs["quantization_config"] = BitsAndBytesConfig(
                    load_in_4bit=quantization == "4bit",
                    load_in_8bit=quantization == "8bit",
                    bnb_4bit_compute_dtype=dtype,
                    bnb_4bit_quant_type="nf4",
                    bnb_4bit_use_double_quant=True,
                )
                kwargs["device_map"] = "auto"
            else:
                kwargs["torch_dtype"] = dtype
                if device == "cuda":
                    kwargs["device_map"] = "auto"
            self.model = AutoModelForCausalLM.from_pretrained(name, **kwargs)
            if "device_map" not in kwargs:
                self.model.to(device)
            self.model.eval()
            if self.tokenizer.pad_token_id is None:
                self.tokenizer.pad_token = self.tokenizer.eos_token
            self.status = ModelStatus(
                name=name, state="ready", device=device, load_seconds=round(time.time() - t0, 1),
                extra={"quantization": quantization, "dtype": str(dtype)},
            )
            log.info("llm.loaded", model=name, device=device, quantization=quantization)
        except Exception as e:  # noqa: BLE001
            self.status = ModelStatus(name=name, state="error", error=str(e))
            log.error("llm.load_failed", model=name, error=str(e))
            raise

    def unload(self) -> None:
        self.groq_client = None
        self.model = None
        self.tokenizer = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        self.status = ModelStatus()

    def _require(self):
        if self.model is None and self.groq_client is None:
            raise RuntimeError("Generator model is not loaded")

    def _encode(self, messages: list[dict]) -> dict:
        prompt = self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        enc = self.tokenizer(prompt, return_tensors="pt", truncation=True,
                             max_length=self.s.llm_max_context - self.s.llm_max_new_tokens)
        return {k: v.to(self.model.device) for k, v in enc.items()}

    def count_tokens(self, text: str) -> int:
        if self.groq_client is not None:
            return self.groq_client.count_tokens(text)
        if self.tokenizer is None:
            return max(1, len(text) // 4)
        return len(self.tokenizer.encode(text, add_special_tokens=False))

    def _gen_config(self, **overrides) -> GenerationConfig:
        temp = overrides.get("temperature", self.s.llm_temperature)
        return GenerationConfig(
            max_new_tokens=overrides.get("max_new_tokens", self.s.llm_max_new_tokens),
            do_sample=temp > 0,
            temperature=temp if temp > 0 else None,
            top_p=overrides.get("top_p", self.s.llm_top_p) if temp > 0 else None,
            pad_token_id=self.tokenizer.pad_token_id,
            eos_token_id=self.tokenizer.eos_token_id,
            repetition_penalty=overrides.get("repetition_penalty", 1.05),
        )

    def generate_sync(self, messages: list[dict], **overrides) -> str:
        self._require()
        inputs = self._encode(messages)
        with self._lock, torch.inference_mode():
            out = self.model.generate(**inputs, generation_config=self._gen_config(**overrides))
        return self.tokenizer.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True).strip()

    async def generate(self, messages: list[dict], task: str = "generate", **overrides) -> str:
        if self.groq_client is not None:
            return await self.groq_client.generate(messages, task=task, **overrides)
        return await asyncio.to_thread(self.generate_sync, messages, **overrides)

    async def stream(self, messages: list[dict], task: str = "generate", **overrides) -> AsyncIterator[str]:
        """Token streaming: delegates to Groq SSE stream or local worker thread."""
        self._require()
        if self.groq_client is not None:
            async for tok in self.groq_client.stream(messages, task=task, **overrides):
                yield tok
            return

        inputs = self._encode(messages)
        streamer = TextIteratorStreamer(self.tokenizer, skip_prompt=True, skip_special_tokens=True, timeout=300)
        cfg = self._gen_config(**overrides)
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str | None | Exception] = asyncio.Queue()

        def run():
            try:
                with self._lock, torch.inference_mode():
                    self.model.generate(**inputs, generation_config=cfg, streamer=streamer)
            except Exception as e:  # noqa: BLE001
                loop.call_soon_threadsafe(queue.put_nowait, e)

        def pump():
            try:
                for piece in streamer:
                    loop.call_soon_threadsafe(queue.put_nowait, piece)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        threading.Thread(target=run, daemon=True).start()
        threading.Thread(target=pump, daemon=True).start()
        while True:
            item = await queue.get()
            if item is None:
                break
            if isinstance(item, Exception):
                raise item
            if item:
                yield item

    async def generate_json(self, messages: list[dict], task: str = "fast", **overrides) -> Any:
        """Generate and parse a JSON object; tolerant of code fences and preamble."""
        if self.groq_client is not None:
            return await self.groq_client.generate_json(messages, task=task, **overrides)
        text = await self.generate(messages, temperature=0, **overrides)
        return parse_json_loose(text)


def parse_json_loose(text: str) -> Any:
    text = re.sub(r"```(?:json)?", "", text).strip()
    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = text.find(opener), text.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                continue
    raise ValueError(f"Model did not return valid JSON: {text[:200]}")


class Embedder:
    """Sentence-Transformers embedder (bge / e5 / bge-m3 / Qwen3-Embedding)."""

    def __init__(self, s: Settings):
        self.s = s
        self.model = None
        self.status = ModelStatus()

    def load(self, name: str | None = None) -> None:
        from sentence_transformers import SentenceTransformer

        name = name or self.s.embedding_model
        self.status = ModelStatus(name=name, state="loading")
        t0 = time.time()
        try:
            device = resolve_device(self.s.device)
            self.model = SentenceTransformer(name, device=device, token=self.s.hf_token,
                                             cache_folder=self.s.hf_cache_dir, trust_remote_code=True)
            self.status = ModelStatus(name=name, state="ready", device=device,
                                      load_seconds=round(time.time() - t0, 1),
                                      extra={"dim": self.dim})
        except Exception as e:  # noqa: BLE001
            self.status = ModelStatus(name=name, state="error", error=str(e))
            raise

    @property
    def dim(self) -> int:
        return self.model.get_sentence_embedding_dimension()

    def _prefixes(self) -> tuple[str, str]:
        n = (self.status.name or "").lower()
        if "e5" in n:
            return "query: ", "passage: "
        if "bge" in n and "m3" not in n:
            return self.s.embedding_query_prefix, self.s.embedding_doc_prefix
        return "", ""

    def embed_documents(self, texts: list[str], batch_size: int = 32) -> np.ndarray:
        _, dp = self._prefixes()
        return self.model.encode([dp + t for t in texts], batch_size=batch_size,
                                 normalize_embeddings=True, convert_to_numpy=True).astype("float32")

    def embed_query(self, text: str) -> np.ndarray:
        qp, _ = self._prefixes()
        return self.model.encode([qp + text], normalize_embeddings=True, convert_to_numpy=True).astype("float32")[0]


class Reranker:
    """Cross-encoder reranker via AutoModelForSequenceClassification (bge-reranker, ms-marco)."""

    def __init__(self, s: Settings):
        self.s = s
        self.model = None
        self.tokenizer = None
        self.device = "cpu"
        self.status = ModelStatus()

    def load(self, name: str | None = None) -> None:
        name = name or self.s.reranker_model
        self.status = ModelStatus(name=name, state="loading")
        t0 = time.time()
        try:
            self.device = resolve_device(self.s.device)
            self.tokenizer = AutoTokenizer.from_pretrained(name, token=self.s.hf_token, cache_dir=self.s.hf_cache_dir)
            self.model = AutoModelForSequenceClassification.from_pretrained(
                name, token=self.s.hf_token, cache_dir=self.s.hf_cache_dir).to(self.device).eval()
            self.status = ModelStatus(name=name, state="ready", device=self.device,
                                      load_seconds=round(time.time() - t0, 1))
        except Exception as e:  # noqa: BLE001
            self.status = ModelStatus(name=name, state="error", error=str(e))
            raise

    @torch.inference_mode()
    def score(self, query: str, passages: list[str], batch_size: int = 16) -> list[float]:
        if not passages:
            return []
        scores: list[float] = []
        for i in range(0, len(passages), batch_size):
            batch = passages[i:i + batch_size]
            enc = self.tokenizer([query] * len(batch), batch, padding=True, truncation=True,
                                 max_length=512, return_tensors="pt").to(self.device)
            logits = self.model(**enc).logits
            logits = logits[:, -1] if logits.shape[-1] > 1 else logits.squeeze(-1)
            scores.extend(torch.sigmoid(logits.float()).cpu().tolist())
        return scores


class ModelManager:
    def __init__(self, s: Settings | None = None):
        self.s = s or get_settings()
        self.generator = Generator(self.s)
        self.embedder = Embedder(self.s)
        self.reranker = Reranker(self.s)

    def load_all(self) -> None:
        self.embedder.load()
        self.reranker.load()
        self.generator.load()

    def status(self) -> dict:
        gpu = None
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            gpu = {"name": torch.cuda.get_device_name(0), "used_gb": round((total - free) / 1e9, 2),
                   "total_gb": round(total / 1e9, 2)}
        return {
            "generator": self.generator.status.__dict__,
            "embedder": self.embedder.status.__dict__,
            "reranker": self.reranker.status.__dict__,
            "gpu": gpu,
            "device_available": resolve_device("auto"),
        }


_manager: ModelManager | None = None


def get_models() -> ModelManager:
    global _manager
    if _manager is None:
        _manager = ModelManager()
    return _manager
