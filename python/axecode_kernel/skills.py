"""skills — reusable know-how.

Two kinds of skills exist:
* Python skills from the harness (``<scope>/skills/<name>/``): importable
  packages, e.g. ``import my_skill`` — already on ``sys.path``.
* Markdown skills (``.agents/skills``, ``.axecode/skills``, ``~/.agents/skills``):
  instructions to read with ``load(name)`` before doing the related task.

``list()`` shows both; ``load(name)`` returns a Markdown skill's content;
``refresh()`` picks up skills created during the session.
"""

from __future__ import annotations

import importlib
import os
import sys

from axecode_kernel import bridge

__all__ = ["list", "load", "refresh"]


def _python_skill_dirs() -> list[str]:
    try:
        return [p for p in bridge.call("harness.skills_paths") or [] if os.path.isdir(p)]
    except bridge.HostError:
        return []


def refresh() -> list[str]:
    """Add harness skill directories to sys.path and invalidate import caches."""
    paths = _python_skill_dirs()
    for path in paths:
        if path not in sys.path:
            sys.path.insert(0, path)
    importlib.invalidate_caches()
    return paths


def list() -> list[dict]:  # noqa: A001 - module API
    """Available skills: ``[{"name", "description", "kind"}]``."""
    out = []
    for path in refresh():
        for name in sorted(os.listdir(path)):
            folder = os.path.join(path, name)
            if os.path.isfile(os.path.join(folder, "__init__.py")):
                description = ""
                doc = os.path.join(folder, "SKILL.md")
                if os.path.isfile(doc):
                    with open(doc, encoding="utf-8", errors="replace") as handle:
                        for line in handle:
                            if line.strip().lower().startswith("description:"):
                                description = line.split(":", 1)[1].strip()
                                break
                out.append({"name": name, "description": description, "kind": "python",
                            "import": f"import {name}"})
    try:
        for skill in bridge.call("skills.list") or []:
            out.append({"name": skill.get("name"), "description": skill.get("description") or "",
                        "kind": "markdown"})
    except bridge.HostError:
        pass
    return out


def load(name: str) -> str:
    """Return the instructions of a Markdown skill."""
    return bridge.call("skills.load", {"name": name})["content"]
