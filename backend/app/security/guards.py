"""Security helpers: path traversal protection, upload validation, untrusted-content isolation."""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import Header, HTTPException

from app.core.config import get_settings
from app.ingestion.parsers import SUPPORTED

INJECTION_PATTERNS = [
    r"ignore (all |any )?(previous|prior|above) (instructions|prompts)",
    r"disregard (the )?(system|previous) (prompt|instructions)",
    r"you are now [a-z ]+",
    r"reveal (your|the) (system prompt|instructions|api key)",
    r"<\s*/?\s*(system|assistant|im_start|im_end)\s*>",
    r"\[INST\]|\[/INST\]",
    r"call the tool|execute the following command|run this (shell )?command",
]
_inj = re.compile("|".join(INJECTION_PATTERNS), re.IGNORECASE)


def safe_join(root: Path, user_path: str) -> Path:
    root = root.resolve()
    target = (root / user_path).resolve()
    if root != target and root not in target.parents:
        raise HTTPException(400, "Path escapes the allowed directory")
    return target


def validate_upload(filename: str, size: int) -> None:
    ext = Path(filename).suffix.lower()
    if ext not in SUPPORTED:
        raise HTTPException(415, f"Unsupported file type '{ext}'. Supported: {', '.join(sorted(SUPPORTED))}")
    if size > get_settings().max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {get_settings().max_upload_mb} MB")
    if "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(400, "Invalid file name")


def flag_injection(text: str) -> bool:
    return bool(_inj.search(text))


def isolate_untrusted(text: str, max_chars: int = 6000) -> str:
    """Neutralize role tags & instruction-like markup so retrieved text is treated as data."""
    text = text[:max_chars]
    text = re.sub(r"<\s*/?\s*(system|assistant|user|im_start|im_end)[^>]*>", "[tag removed]", text, flags=re.I)
    text = text.replace("[INST]", "[inst]").replace("[/INST]", "[/inst]")
    text = text.replace("<<<", "‹‹‹").replace(">>>", "›››")
    return text


async def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    key = get_settings().api_key
    if key and x_api_key != key:
        raise HTTPException(401, "Missing or invalid X-API-Key")
