"""mcp — outils des serveurs MCP configurés.

``list()`` se connecte aux serveurs à la première utilisation et liste leurs
outils ; ``schema(name)`` montre le schéma d'entrée d'un outil ;
``call(name, **arguments)`` l'exécute. ``server("nom")`` renvoie un espace de
noms dont les attributs sont les outils de ce serveur, par exemple
``gh = mcp.server("github"); gh.search_issues(q="bug")``.
"""

from __future__ import annotations

import types
from typing import Any

from axecode_kernel import bridge

__all__ = ["list", "schema", "call", "server"]


def list() -> list[dict]:  # noqa: A001 - module API
    """Outils MCP : ``[{"name", "server", "tool", "description"}]``."""
    return bridge.call("mcp.list", timeout=120)


def schema(name: str) -> dict:
    """Schéma JSON des arguments d'un outil."""
    return bridge.call("mcp.schema", {"name": name})


def call(name: str, **arguments: Any) -> str:
    """Exécute un outil MCP d'après son ``name`` listé ; renvoie sa sortie texte."""
    return bridge.call("mcp.call", {"name": name, "arguments": arguments})["content"]


def server(name: str) -> types.SimpleNamespace:
    """Espace de noms qui expose les outils d'un serveur comme fonctions Python."""
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
