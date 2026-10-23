"""refine — improve your own harness from this trajectory.

``refine.run(focus=None)`` asks a background planner to read the current
trajectory and propose the *smallest* useful harness change (a memory, a
prompt note, a skill...). Planning never blocks you; the change is applied at
the start of the next turn and reported in the system reminder with its id.
Every refinement is logged with its evidence and can be undone with
``refine.rollback(id)``.

Use it after you corrected a mistake, learned a user preference, or wrote a
helper worth reusing.
"""

from __future__ import annotations

from typing import Any

from axecode_kernel import bridge

__all__ = ["run", "status", "history", "rollback"]


def run(focus: str | None = None) -> dict[str, Any]:
    """Start a background refinement (optionally focused, e.g. ``"git workflow"``)."""
    return bridge.call("refine.run", {"focus": focus})


def status() -> dict[str, Any]:
    """Pending refinement (if any) and the most recent records."""
    return bridge.call("refine.status", {})


def history() -> list[dict[str, Any]]:
    """All refinement records, newest first."""
    return bridge.call("refine.history", {}) or []


def rollback(id: str) -> dict[str, Any]:  # noqa: A002
    """Undo an applied refinement by id."""
    return bridge.call("refine.rollback", {"id": id})
