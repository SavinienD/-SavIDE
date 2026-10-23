"""mcp — tools of the configured MCP servers.

``list()`` connects to the servers on first use and lists their tools;
``schema(name)`` shows a tool's input schema; ``call(name, **arguments)``
runs it. ``server("name")`` returns a namespace whose attributes are that
server's tools, e.g. ``gh = mcp.server("github"); gh.search_issues(q="bug")``.
"""

from __future__ import annotations

import types
from typing import Any

from axecode_kernel import bridge

__all__ = ["list", "schema", "call", "server"]


def list() -> list[dict]:  # noqa: A001 - module API
    """MCP tools: ``[{"name", "server", "tool", "description"}]``."""
    return bridge.call("mcp.list", timeout=120)


def schema(name: str) -> dict:
    """JSON schema of a tool's arguments."""
    return bridge.call("mcp.schema", {"name": name})


def call(name: str, **arguments: Any) -> str:
    """Run an MCP tool by its listed ``name``; returns its text output."""
    return bridge.call("mcp.call", {"name": name, "arguments": arguments})["content"]


def server(name: str) -> types.SimpleNamespace:
    """Namespace exposing one server's tools as Python functions."""
    namespace = types.SimpleNamespace()
    for tool in list():
        if tool.get("server") != name:
            continue
        tool_name = tool["name"]

        def _fn(_tool=tool_name, **arguments):
            return call(_tool, **arguments)

        _fn.__doc__ = tool.get("description") or ""
        _fn.__name__ = tool.get("tool") or tool_name
        setattr(namespace, _fn.__name__, _fn)
    return namespace
