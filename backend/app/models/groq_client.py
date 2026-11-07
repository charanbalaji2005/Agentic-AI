"""Groq LLM Client with multi-model task routing.

Routes tasks to dedicated models using a single Groq API key:
- Planner (task="plan"): openai/gpt-oss-120b (high-reasoning, complex DAG decomposition)
- Generator (task="generate"): qwen/qwen3.8-27b (fast token streaming, strict citation formatting)
- Fast/retrieval (task="fast"): openai/gpt-oss-20b (HyDE, query rewrites, multi-hop)
- Validator (task="validate"): openai/gpt-oss-20b (claim verification)
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any, AsyncIterator

import httpx

from app.core.config import Settings
from app.core.logging import log


def parse_json_loose(text: str) -> Any:
    """Tolerant JSON parser handling markdown code blocks and preamble."""
    cleaned = re.sub(r"```(?:json)?", "", text).strip()
    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = cleaned.find(opener), cleaned.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(cleaned[start:end + 1])
            except json.JSONDecodeError:
                continue
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise ValueError(f"Model did not return valid JSON: {text[:200]}") from e


class GroqClient:
    def __init__(self, s: Settings):
        self.s = s
        self.api_key = s.groq_api_key
        self.base_url = s.groq_base_url.rstrip("/")
        self._task_map = {
            "plan": s.groq_model_planner,
            "generate": s.groq_model_generator,
            "fast": s.groq_model_fast,
            "validate": s.groq_model_validator,
            "code": s.groq_model_code or s.groq_model_generator,
        }

    def get_model_for_task(self, task: str) -> str:
        return self._task_map.get(task, self.s.groq_model_generator)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def count_tokens(self, text: str) -> int:
        return max(1, len(text) // 4)

    async def generate(self, messages: list[dict], task: str = "generate", **overrides) -> str:
        model = overrides.get("model") or self.get_model_for_task(task)
        max_tokens = overrides.get("max_new_tokens", overrides.get("max_tokens", self.s.llm_max_new_tokens))
        temp = overrides.get("temperature", self.s.llm_temperature)

        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temp,
        }
        if "top_p" in overrides:
            payload["top_p"] = overrides["top_p"]

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json=payload,
            )
            if resp.status_code in (429, 503) and model != self.s.groq_model_planner:
                log.warning("groq.generate_capacity_retry", status=resp.status_code, original=model)
                await asyncio.sleep(1.0)
                payload["model"] = self.s.groq_model_planner
                resp = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers=self._headers(),
                    json=payload,
                )
            if resp.status_code != 200:
                log.error("groq.generate_error", status=resp.status_code, body=resp.text)
                resp.raise_for_status()

            data = resp.json()
            choice = data["choices"][0]
            # Content contains final text; reasoning (if any) is excluded from final output
            content = choice["message"].get("content") or ""
            return content.strip()

    async def stream(self, messages: list[dict], task: str = "generate", **overrides) -> AsyncIterator[str]:
        model = overrides.get("model") or self.get_model_for_task(task)
        max_tokens = overrides.get("max_new_tokens", overrides.get("max_tokens", self.s.llm_max_new_tokens))
        temp = overrides.get("temperature", self.s.llm_temperature)

        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temp,
            "stream": True,
        }
        if "top_p" in overrides:
            payload["top_p"] = overrides["top_p"]

        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.send(
                client.build_request("POST", f"{self.base_url}/chat/completions", headers=self._headers(), json=payload),
                stream=True,
            )
            if response.status_code in (429, 503) and model != self.s.groq_model_planner:
                await response.aclose()
                log.warning("groq.stream_capacity_retry", status=response.status_code, original=model)
                await asyncio.sleep(1.0)
                payload["model"] = self.s.groq_model_planner
                response = await client.send(
                    client.build_request("POST", f"{self.base_url}/chat/completions", headers=self._headers(), json=payload),
                    stream=True,
                )

            if response.status_code != 200:
                err_body = await response.aread()
                await response.aclose()
                log.error("groq.stream_error", status=response.status_code, body=err_body.decode(errors="replace"))
                response.raise_for_status()

            try:
                async for line in response.aiter_lines():
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    if line == "data: [DONE]":
                        break
                    raw = line[5:].strip()
                    try:
                        chunk = json.loads(raw)
                        delta = chunk["choices"][0].get("delta", {})
                        # Filter out internal reasoning deltas; only stream content to user
                        text = delta.get("content")
                        if text:
                            yield text
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue
            finally:
                await response.aclose()

    async def generate_json(self, messages: list[dict], task: str = "fast", **overrides) -> Any:
        model = overrides.get("model") or self.get_model_for_task(task)
        max_tokens = overrides.get("max_new_tokens", overrides.get("max_tokens", 1000))

        # Groq json_object mode requires the word 'json' in messages
        msgs = list(messages)
        has_json_word = any("json" in m.get("content", "").lower() for m in msgs)
        if not has_json_word:
            msgs.insert(0, {"role": "system", "content": "Return valid JSON object only."})

        # Do not force response_format for gpt-oss reasoning models as their reasoning prefix can clash with grammar
        payload: dict[str, Any] = {
            "model": model,
            "messages": msgs,
            "max_tokens": max_tokens,
            "temperature": overrides.get("temperature", 0.0),
        }
        if not model.startswith("openai/gpt-oss"):
            payload["response_format"] = {"type": "json_object"}

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json=payload,
            )
            if resp.status_code != 200:
                # If json_object response format was rejected, retry without it and use loose parser
                log.warning("groq.json_retry", status=resp.status_code, body=resp.text)
                payload.pop("response_format", None)
                resp = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers=self._headers(),
                    json=payload,
                )
                if resp.status_code != 200:
                    resp.raise_for_status()

            data = resp.json()
            message = data["choices"][0]["message"]
            content = message.get("content") or ""
            if not content.strip() and "reasoning" in message:
                content = message["reasoning"]
            return parse_json_loose(content)
