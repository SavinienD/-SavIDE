"""context — programmatic access to this session's full history.

The journal keeps everything, including what was compacted out of your
context window. ``entries(kinds)`` returns raw journal entries
(kinds: message, repl_call, repl_result, compaction, peer_message, ...);
``messages()`` returns ``[{"role", "text", "ts"}]``; ``search(text)`` finds
past messages and REPL calls containing ``text``.
"""

from __future__ import annotations

from typing import Iterable, Optional

from axecode_kernel import bridge

__all__ = ["entries", "messages", "search", "info"]


def info() -> dict:
    """Session id, name, workspace and current model."""
    return bridge.call("session.info")


def entries(kinds: Optional[Iterable[str]] = None) -> list[dict]:
    """Raw journal entries, oldest first (optionally filtered by kind)."""
    params = {"kinds": list(kinds)} if kinds else {}
    return bridge.call("context.entries", params)


def messages() -> list[dict]:
    """User/assistant text messages of the whole session, oldest first."""
    return bridge.call("session.history")


def search(text: str, limit: int = 20) -> list[dict]:
    """Past messages and REPL code/results containing ``text`` (case-insensitive)."""
    needle = text.lower()
    hits = []
    for entry in entries(["message", "repl_call", "repl_result"]):
        blob = str(entry.get("code") or entry.get("output") or entry.get("message") or "")
        if needle in blob.lower():
            hits.append(entry)
    return hits[-limit:]
