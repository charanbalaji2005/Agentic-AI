"""MCP client manager (official `mcp` Python SDK).

- stdio and Streamable HTTP transports
- tool discovery + JSON-Schema validation of every call
- per-server allow/deny/approval rules + MCP tool annotations (readOnlyHint / destructiveHint)
- human approval queue for risky actions, audit log for every call
- each connection lives in its own task (anyio contexts must open/close in the same task)
"""
from __future__ import annotations

import asyncio
import fnmatch
import json
import os
import re
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

import jsonschema
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

try:  # MCP SDK 2.x
    from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

    def _http_transport(url: str, headers: dict[str, str]):
        return streamable_http_client(url, http_client=create_mcp_http_client(headers=headers))
except ImportError:  # MCP SDK 1.x
    from mcp.client.streamable_http import streamablehttp_client

    def _http_transport(url: str, headers: dict[str, str]):
        return streamablehttp_client(url, headers=headers)


def _attr(obj: Any, *names: str, default: Any = None) -> Any:
    """Read a field across SDK versions (camelCase in 1.x, snake_case in 2.x)."""
    for n in names:
        if obj is not None and hasattr(obj, n):
            return getattr(obj, n)
    return default
from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.core.logging import log
from app.core.schemas import new_id

RISKY = re.compile(r"(delete|remove|destroy|terminate|drop|truncate|write|edit|move|create|update|put|"
                   r"patch|stop|start|restart|reboot|scale|deploy|apply|exec|run_command|invoke)", re.I)


class Permissions(BaseModel):
    allow: list[str] = Field(default_factory=lambda: ["*"])
    deny: list[str] = Field(default_factory=list)
    approval_required: list[str] = Field(default_factory=list)
    auto_approve_read_only: bool = True


class ServerConfig(BaseModel):
    name: str
    category: Literal["local", "search", "cloud", "database", "github", "browser", "custom"] = "custom"
    transport: Literal["stdio", "http"] = "stdio"
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    url: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
    timeout_s: float | None = None
    permissions: Permissions = Field(default_factory=Permissions)
    description: str = ""


class ToolInfo(BaseModel):
    server: str
    name: str
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=dict)
    read_only: bool | None = None
    destructive: bool | None = None

    @property
    def qualified(self) -> str:
        return f"{self.server}.{self.name}"


class ToolOutcome(BaseModel):
    ok: bool
    server: str
    tool: str
    content: str = ""
    structured: Any = None
    error: str | None = None
    approval_id: str | None = None
    duration_ms: int = 0


def _expand_env(v: str) -> str:
    return re.sub(r"\$\{(\w+)\}", lambda m: os.environ.get(m.group(1), ""), v)


class ServerConnection:
    def __init__(self, cfg: ServerConfig):
        self.cfg = cfg
        self.session: ClientSession | None = None
        self.tools: dict[str, ToolInfo] = {}
        self.status: str = "disconnected"
        self.error: str | None = None
        self.connected_at: str | None = None
        self._stop = asyncio.Event()
        self._ready = asyncio.Event()
        self._task: asyncio.Task | None = None

    async def start(self, timeout: float = 60):
        self._stop.clear()
        self._ready.clear()
        self.status = "connecting"
        self._task = asyncio.create_task(self._run(), name=f"mcp:{self.cfg.name}")
        try:
            await asyncio.wait_for(self._ready.wait(), timeout)
        except asyncio.TimeoutError:
            self.status, self.error = "error", "connection timed out"
            await self.stop()

    async def _run(self):
        cfg = self.cfg
        try:
            if cfg.transport == "stdio":
                params = StdioServerParameters(
                    command=cfg.command, args=[_expand_env(a) for a in cfg.args],
                    env={**os.environ, **{k: _expand_env(v) for k, v in cfg.env.items()}})
                ctx = stdio_client(params)
            else:
                ctx = _http_transport(cfg.url, {k: _expand_env(v) for k, v in cfg.headers.items()})
            async with ctx as streams:
                read, write = streams[0], streams[1]
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    self.session = session
                    await self.refresh_tools()
                    self.status, self.error = "connected", None
                    self.connected_at = datetime.now(timezone.utc).isoformat()
                    self._ready.set()
                    log.info("mcp.connected", server=cfg.name, tools=len(self.tools))
                    await self._stop.wait()
        except Exception as e:  # noqa: BLE001
            self.status, self.error = "error", f"{type(e).__name__}: {e}"
            log.error("mcp.connection_failed", server=cfg.name, error=self.error)
        finally:
            self.session = None
            if self.status != "error":
                self.status = "disconnected"
            self._ready.set()

    async def refresh_tools(self):
        res = await self.session.list_tools()
        self.tools = {}
        for t in res.tools:
            ann = getattr(t, "annotations", None)
            self.tools[t.name] = ToolInfo(
                server=self.cfg.name, name=t.name, description=t.description or "",
                input_schema=_attr(t, "input_schema", "inputSchema", default={}) or {},
                read_only=_attr(ann, "read_only_hint", "readOnlyHint"),
                destructive=_attr(ann, "destructive_hint", "destructiveHint"))

    async def stop(self):
        self._stop.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, 10)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
        self.session = None
        if self.status != "error":
            self.status = "disconnected"


class MCPManager:
    def __init__(self):
        self.s = get_settings()
        self.configs: dict[str, ServerConfig] = {}
        self.conns: dict[str, ServerConnection] = {}
        self.approvals: dict[str, dict[str, Any]] = {}
        self.logs: deque[dict] = deque(maxlen=1000)
        self.log_sink: Callable[[dict], Awaitable[None]] | None = None

    # ---- configuration ---------------------------------------------------------
    def load_config(self, path: Path | None = None):
        path = path or self.s.mcp_config_path
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            for item in data.get("servers", []):
                cfg = ServerConfig.model_validate(item)
                self.configs[cfg.name] = cfg

    def save_config(self):
        self.s.mcp_config_path.write_text(json.dumps(
            {"servers": [c.model_dump() for c in self.configs.values()]}, indent=2), encoding="utf-8")

    async def upsert_server(self, cfg: ServerConfig, connect: bool = True):
        if cfg.name in self.conns:
            await self.disconnect(cfg.name)
        self.configs[cfg.name] = cfg
        self.save_config()
        if connect and cfg.enabled:
            await self.connect(cfg.name)

    async def remove_server(self, name: str):
        await self.disconnect(name)
        self.configs.pop(name, None)
        self.save_config()

    # ---- lifecycle -------------------------------------------------------------
    async def connect(self, name: str):
        cfg = self.configs[name]
        conn = ServerConnection(cfg)
        self.conns[name] = conn
        await conn.start()

    async def disconnect(self, name: str):
        conn = self.conns.pop(name, None)
        if conn:
            await conn.stop()

    async def connect_all(self):
        await asyncio.gather(*(self.connect(n) for n, c in self.configs.items() if c.enabled),
                             return_exceptions=True)

    async def shutdown(self):
        await asyncio.gather(*(c.stop() for c in self.conns.values()), return_exceptions=True)

    async def health(self, name: str) -> dict:
        conn = self.conns.get(name)
        if not conn or not conn.session:
            return {"server": name, "healthy": False, "status": conn.status if conn else "disconnected"}
        t0 = time.time()
        try:
            await asyncio.wait_for(conn.session.send_ping(), 10)
            return {"server": name, "healthy": True, "latency_ms": int((time.time() - t0) * 1000)}
        except Exception as e:  # noqa: BLE001
            return {"server": name, "healthy": False, "error": str(e)}

    # ---- discovery -------------------------------------------------------------
    def tools(self, category: str | None = None) -> list[ToolInfo]:
        out = []
        for name, conn in self.conns.items():
            if conn.status == "connected" and (category is None or self.configs[name].category == category):
                out.extend(t for t in conn.tools.values() if self._allowed(self.configs[name], t.name))
        return out

    def find_tool(self, category: str, *keywords: str) -> ToolInfo | None:
        tools = self.tools(category)
        for kw in keywords:
            for t in tools:
                if kw in t.name.lower():
                    return t
        return None

    def servers(self) -> list[dict]:
        out = []
        for name, cfg in self.configs.items():
            conn = self.conns.get(name)
            out.append({**cfg.model_dump(exclude={"env", "headers"}),
                        "env_keys": list(cfg.env), "status": conn.status if conn else "disconnected",
                        "error": conn.error if conn else None,
                        "tools": [t.model_dump() for t in conn.tools.values()] if conn else []})
        return out

    # ---- policy ----------------------------------------------------------------
    @staticmethod
    def _match(name: str, patterns: list[str]) -> bool:
        return any(fnmatch.fnmatch(name, p) for p in patterns)

    def _allowed(self, cfg: ServerConfig, tool: str) -> bool:
        return self._match(tool, cfg.permissions.allow) and not self._match(tool, cfg.permissions.deny)

    def needs_approval(self, info: ToolInfo) -> bool:
        p = self.configs[info.server].permissions
        if self._match(info.name, p.approval_required):
            return True
        if info.destructive:
            return True
        if info.read_only and p.auto_approve_read_only:
            return False
        cat = self.configs[info.server].category
        return cat in ("cloud", "database", "github") and bool(RISKY.search(info.name))

    # ---- invocation ------------------------------------------------------------
    async def call(self, server: str, tool: str, arguments: dict[str, Any], *, actor: str,
                   approved: bool = False) -> ToolOutcome:
        conn = self.conns.get(server)
        if not conn or not conn.session:
            return ToolOutcome(ok=False, server=server, tool=tool, error=f"MCP server '{server}' is not connected")
        info = conn.tools.get(tool)
        if not info or not self._allowed(self.configs[server], tool):
            return ToolOutcome(ok=False, server=server, tool=tool, error=f"Tool '{tool}' is not permitted")
        try:
            jsonschema.validate(arguments, info.input_schema or {"type": "object"})
        except jsonschema.ValidationError as e:
            return ToolOutcome(ok=False, server=server, tool=tool, error=f"Invalid arguments: {e.message}")
        if self.needs_approval(info) and not approved:
            aid = new_id("apr_")
            self.approvals[aid] = {"approval_id": aid, "server": server, "tool": tool, "arguments": arguments,
                                   "actor": actor, "status": "pending", "description": info.description,
                                   "created_at": datetime.now(timezone.utc).isoformat(), "result": None}
            await self._log(server, tool, arguments, actor, "awaiting_approval", None, 0)
            return ToolOutcome(ok=False, server=server, tool=tool, approval_id=aid,
                               error="Approval required before this action can run")
        t0 = time.time()
        timeout = self.configs[server].timeout_s or self.s.tool_timeout_s
        for attempt in range(2):  # one retry on transient failure
            try:
                res = await asyncio.wait_for(conn.session.call_tool(tool, arguments), timeout)
                text = "\n".join(getattr(c, "text", "") for c in res.content if getattr(c, "type", "") == "text")
                ok = not _attr(res, "is_error", "isError", default=False)
                dur = int((time.time() - t0) * 1000)
                await self._log(server, tool, arguments, actor, "ok" if ok else "tool_error", text[:500], dur)
                return ToolOutcome(ok=ok, server=server, tool=tool, content=text,
                                   structured=_attr(res, "structured_content", "structuredContent"),
                                   error=None if ok else text[:500] or "Tool reported an error", duration_ms=dur)
            except asyncio.TimeoutError:
                err = f"Timed out after {timeout}s"
            except Exception as e:  # noqa: BLE001
                err = f"{type(e).__name__}: {e}"
            if attempt == 0:
                await asyncio.sleep(0.5)
        dur = int((time.time() - t0) * 1000)
        await self._log(server, tool, arguments, actor, "failed", err, dur)
        return ToolOutcome(ok=False, server=server, tool=tool, error=err, duration_ms=dur)

    async def resolve_approval(self, approval_id: str, approve: bool, reviewer: str = "user") -> dict:
        a = self.approvals.get(approval_id)
        if not a or a["status"] != "pending":
            raise KeyError("Approval not found or already resolved")
        if not approve:
            a["status"] = "rejected"
            await self._log(a["server"], a["tool"], a["arguments"], reviewer, "rejected", None, 0)
            return a
        a["status"] = "approved"
        outcome = await self.call(a["server"], a["tool"], a["arguments"], actor=reviewer, approved=True)
        a["status"] = "executed" if outcome.ok else "failed"
        a["result"] = outcome.model_dump()
        return a

    async def _log(self, server, tool, args, actor, status, detail, duration_ms):
        entry = {"id": new_id("log_"), "ts": datetime.now(timezone.utc).isoformat(), "server": server,
                 "tool": tool, "arguments": _redact(args), "actor": actor, "status": status,
                 "detail": detail, "duration_ms": duration_ms}
        self.logs.appendleft(entry)
        log.info("mcp.tool_call", **{k: v for k, v in entry.items() if k != "arguments"})
        if self.log_sink:
            try:
                await self.log_sink(entry)
            except Exception as e:  # noqa: BLE001
                log.warning("mcp.log_sink_failed", error=str(e))


SECRET_KEYS = re.compile(r"(key|token|secret|password|credential|auth)", re.I)


def _redact(args: dict) -> dict:
    return {k: ("***" if SECRET_KEYS.search(k) else v) for k, v in (args or {}).items()}


mcp_manager = MCPManager()
