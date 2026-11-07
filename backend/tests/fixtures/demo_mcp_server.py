"""Tiny real MCP server used by integration tests (works with mcp 1.x FastMCP and 2.x MCPServer)."""
try:
    from mcp.server.mcpserver import MCPServer as Server
except ImportError:
    from mcp.server.fastmcp import FastMCP as Server

srv = Server("demo-cloud")


@srv.tool()
def describe_bucket(name: str) -> str:
    """Read-only: describe an S3-like bucket."""
    return f"bucket {name}: region=eu-west-1 versioning=enabled objects=42"


@srv.tool()
def delete_bucket(name: str) -> str:
    """Delete a bucket (destructive)."""
    return f"deleted {name}"


if __name__ == "__main__":
    srv.run()
