"""goal — persistent objective of the session.

The user sets a goal with ``/goal <text> [--budget N]``; it is stored in the
journal and re-injected at the start of every turn with its progress and the
remaining token budget. You decide when it is reached.

``goal.get()``                 – current goal (or ``None``).
``goal.progress("step 2/5 …")`` – update the progress note shown each turn.
``goal.complete(summary)``     – declare the goal reached (ends /autonomous).
``goal.pause(reason)``         – keep the goal but stop auto-continuation.
``goal.clear()``               – forget the goal.
``goal.set(text, budget)``     – set a goal programmatically (same as /goal).
"""

from __future__ import annotations

from typing import Any

from axecode_kernel import bridge

__all__ = ["get", "set", "progress", "complete", "pause", "resume", "clear"]


def get() -> dict[str, Any] | None:
    """Return the current goal: ``{text, status, progress, budget_tokens, used_tokens, ...}``."""
    return bridge.call("goal.get")


def set(text: str, budget_tokens: int | None = None) -> dict[str, Any]:  # noqa: A001
    """Set (or replace) the session goal. Optional token budget."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("goal.set: text must be a non-empty string")
    payload: dict[str, Any] = {"text": text}
    if budget_tokens is not None:
        payload["budget_tokens"] = int(budget_tokens)
    return bridge.call("goal.set", payload)


def progress(note: str) -> dict[str, Any]:
    """Record a short progress note, shown with the goal at every turn."""
    return bridge.call("goal.progress", {"note": str(note)})


def complete(summary: str = "") -> dict[str, Any]:
    """Declare the goal reached. Stops any /autonomous continuation."""
    return bridge.call("goal.complete", {"summary": str(summary)})


def pause(reason: str = "") -> dict[str, Any]:
    """Pause the goal: it stays visible but no auto-continuation happens."""
    return bridge.call("goal.pause", {"reason": str(reason)})


def resume() -> dict[str, Any]:
    """Resume a paused goal."""
    return bridge.call("goal.resume")


def clear() -> dict[str, Any]:
    """Remove the goal entirely."""
    return bridge.call("goal.clear")
