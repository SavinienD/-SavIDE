"""rlm — persistent sub-agents.

Create a sub-agent with ``rlm(prompt)`` (or ``rlm.spawn``). The call returns
immediately with a handle ``{"id": ..., "session_name": ...}``; the sub-agent
runs in its own session (own kernel, own journal, own model) and its final
report is delivered to you as a peer message at the start of a later turn
(see the ``<queued_peer_messages>`` block of the system reminder).

Sub-agents are persistent: after their first task you can send a follow-up
with ``rlm.follow_up(handle, text)``, list them with ``rlm.list_subagents()``
and read their last result with ``rlm.result(handle)``.

Before fanning out more than two children in a single turn, check the
subscription quota with ``rlm.quota()``: the spawn result contains a
``warning`` field when the window is almost exhausted. An explicit user
instruction always wins over that warning — never block on it.
"""

from __future__ import annotations

import sys
from typing import Any

from axecode_kernel import bridge

__all__ = [
    "spawn",
    "follow_up",
    "list_subagents",
    "result",
    "quota",
    "wait",
]


class SubAgentHandle(dict):
    """Lightweight handle returned by ``spawn``: ``{"id", "session_name"}``."""

    @property
    def id(self) -> str:  # noqa: A003 - mirrors the wire field
        return str(self["id"])

    @property
    def session_name(self) -> str:
        return str(self.get("session_name") or self["id"])

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"SubAgentHandle(id={self['id']!r}, session_name={self.get('session_name')!r})"


def spawn(
    prompt: str,
    name: str | None = None,
    model: str | None = None,
    profile: str | None = None,
) -> SubAgentHandle:
    """Create a persistent sub-agent session and return its handle immediately.

    ``prompt``  – the task description (full, self-contained).
    ``name``    – optional human-readable session name (unique among siblings).
    ``model``   – optional ``"provider/model"`` override.
    ``profile`` – optional sub-agent profile id from Settings or the harness.

    The result is NOT returned here: it arrives later as a peer message
    from the child. The returned dict may carry a ``warning`` when the
    subscription quota is low.
    """
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("rlm.spawn: prompt must be a non-empty string")
    payload: dict[str, Any] = {"prompt": prompt}
    if name:
        payload["name"] = name
    if model:
        payload["model"] = model
    if profile:
        payload["profile"] = profile
    reply = bridge.call("rlm.spawn", payload)
    handle = SubAgentHandle(reply)
    warning = reply.get("warning")
    if warning:
        print(f"[rlm] warning: {warning}", file=sys.stderr)
    return handle


def follow_up(handle: SubAgentHandle | str | dict, text: str) -> dict[str, Any]:
    """Send a follow-up message to an existing sub-agent (continues its session)."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("rlm.follow_up: text must be a non-empty string")
    return bridge.call("rlm.follow_up", {"id": _session_id(handle), "text": text})


def list_subagents() -> list[dict[str, Any]]:
    """List this session's sub-agents: id, session_name, status, model, last_result.

    ``status`` is ``"error"`` when the last task stopped on an error.
    """
    return list(bridge.call("rlm.list") or [])


def result(handle: SubAgentHandle | str | dict) -> dict[str, Any] | None:
    """Return the last known result of a sub-agent without waiting for it."""
    return bridge.call("rlm.result", {"id": _session_id(handle)})


def wait(handle: SubAgentHandle | str | dict, timeout: float | None = 600) -> dict[str, Any] | None:
    """Block until the sub-agent finishes its current task, at most ``timeout``
    seconds (``None``: no limit). Returns its result, with ``error`` true when
    the task stopped on an error, or ``None`` when the time is up (the result
    still arrives later as a peer message).

    Prefer letting the result arrive as a peer message; use ``wait`` only when
    the rest of your work strictly depends on it right now.
    """
    payload: dict[str, Any] = {"id": _session_id(handle)}
    if timeout is not None:
        payload["timeout_ms"] = int(timeout * 1000)
    return bridge.call("rlm.wait", payload, timeout=(timeout + 5) if timeout else None)


def quota() -> dict[str, Any] | None:
    """Return the subscription quota of the current provider if it is known.

    ``None`` means the provider does not expose a quota; never treat that as
    an error.
    """
    try:
        return bridge.call("rlm.quota")
    except bridge.HostError:
        return None


def _session_id(handle: Any) -> str:
    if isinstance(handle, dict):
        return str(handle.get("id") or handle.get("session_id"))
    return str(handle)


class _Callable(sys.modules[__name__].__class__):
    """Make ``rlm(prompt, ...)`` an alias of ``rlm.spawn``."""

    def __call__(self, *args: Any, **kwargs: Any) -> SubAgentHandle:
        return spawn(*args, **kwargs)


sys.modules[__name__].__class__ = _Callable
