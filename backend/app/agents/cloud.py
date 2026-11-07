"""Agent 3 — Cloud infrastructure (AWS / Azure MCP). ReAct tool use with approval gating."""
from __future__ import annotations

from app.agents.base import AgentContext, BaseAgent, react_tool_loop
from app.core.schemas import AgentResult, PlanStep, SourceKind
from app.mcp.manager import mcp_manager


class CloudAgent(BaseAgent):
    name = "cloud"
    display_name = "Cloud infrastructure"
    description = ("Uses AWS / Azure MCP servers to read cloud documentation, inspect resources, configs, "
                   "logs and deployment status. Risky or destructive actions are queued for human approval.")
    color = "#F5CF4C"
    argument_hints = {"provider": "aws | azure | any"}

    def available(self):
        return (True, "ready") if mcp_manager.tools("cloud") else (False, "No cloud MCP server connected")

    async def run(self, step: PlanStep, ctx: AgentContext) -> AgentResult:
        provider = (step.arguments.get("provider") or "any").lower()
        tools = [t for t in mcp_manager.tools("cloud") if provider == "any" or provider in t.server.lower()]
        await ctx.emit("agent_status", {"agent": self.name, "task_id": step.task_id, "status": "executing",
                                        "detail": f"{len(tools)} cloud tools available"})
        return await react_tool_loop(step.query, tools, agent=self.name, kind=SourceKind.cloud,
                                     emit=ctx.emit, task_id=step.task_id)


class MCPToolAgent(BaseAgent):
    """Generic agent bound to an MCP category or server — used for dynamically registered agents
    (GitHub, database, SQL, browser, custom tools…)."""

    def __init__(self, name: str, display_name: str, description: str, category: str | None = None,
                 server: str | None = None, color: str = "#9C8CF0"):
        self.name, self.display_name, self.description = name, display_name, description
        self.category, self.server, self.color = category, server, color

    def _tools(self):
        return [t for t in mcp_manager.tools(self.category) if not self.server or t.server == self.server]

    def available(self):
        return (True, "ready") if self._tools() else (False, "Its MCP server is not connected")

    async def run(self, step: PlanStep, ctx: AgentContext) -> AgentResult:
        return await react_tool_loop(step.query, self._tools(), agent=self.name, kind=SourceKind.tool,
                                     emit=ctx.emit, task_id=step.task_id)
