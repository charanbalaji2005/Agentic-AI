"""Real MCP round-trip over stdio: discovery, schema validation, approval gating, execution."""
import sys
from pathlib import Path

import pytest

from app.mcp.manager import MCPManager, ServerConfig

SERVER = str(Path(__file__).parent / "fixtures" / "demo_mcp_server.py")


@pytest.mark.asyncio
async def test_mcp_roundtrip_and_approval(tmp_path, monkeypatch):
    m = MCPManager()
    m.s.mcp_config_path = tmp_path / "mcp.json"
    await m.upsert_server(ServerConfig(name="demo", category="cloud", transport="stdio",
                                       command=sys.executable, args=[SERVER]))
    try:
        assert m.conns["demo"].status == "connected", m.conns["demo"].error
        names = {t.name for t in m.tools("cloud")}
        assert {"describe_bucket", "delete_bucket"} <= names

        bad = await m.call("demo", "describe_bucket", {"wrong": 1}, actor="test")
        assert not bad.ok and "Invalid arguments" in bad.error

        ok = await m.call("demo", "describe_bucket", {"name": "logs"}, actor="test")
        assert ok.ok and "versioning=enabled" in ok.content

        gated = await m.call("demo", "delete_bucket", {"name": "logs"}, actor="test")
        assert not gated.ok and gated.approval_id  # risky cloud action is NOT executed
        assert m.approvals[gated.approval_id]["status"] == "pending"

        done = await m.resolve_approval(gated.approval_id, approve=True)
        assert done["status"] == "executed" and "deleted logs" in done["result"]["content"]
        assert (await m.health("demo"))["healthy"]
        assert any(entry["status"] == "awaiting_approval" for entry in m.logs)
    finally:
        await m.shutdown()
