"""heartbeat — periodic message injected into the session.

Use it to poll a sub-agent, a long process or a build without busy-waiting:
``heartbeat.set("30s", "check whether the tests sub-agent finished")`` makes
the host inject that message as a user turn every 30 seconds while the
session is otherwise idle. ``heartbeat.clear()`` stops it.

Intervals accept ``"45s"``, ``"2m"``, ``"1h"`` or a number of seconds.
Equivalent slash command: ``/heartbeat <interval> <message>``.
"""

from __future__ import annotations

import re
from typing import Any

from axecode_kernel import bridge

__all__ = ["set", "get", "clear", "parse_interval"]

_INTERVAL_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr)?\s*$", re.IGNORECASE)
_UNIT_MS = {
    None: 1000,
    "ms": 1,
    "s": 1000,
    "sec": 1000,
    "m": 60_000,
    "min": 60_000,
    "h": 3_600_000,
    "hr": 3_600_000,
}
MIN_INTERVAL_MS = 5_000


def parse_interval(value: str | int | float) -> int:
    """Convert ``"30s"`` / ``"2m"`` / ``90`` into milliseconds (minimum 5 s)."""
    if isinstance(value, (int, float)):
        ms = int(value * 1000)
    else:
        match = _INTERVAL_RE.match(str(value))
        if not match:
            raise ValueError(f"heartbeat: invalid interval {value!r} (use e.g. '30s', '2m', '1h')")
        amount, unit = match.groups()
        ms = int(float(amount) * _UNIT_MS[(unit or "").lower() or None])
    if ms < MIN_INTERVAL_MS:
        raise ValueError(f"heartbeat: interval must be at least {MIN_INTERVAL_MS // 1000}s")
    return ms


def set(interval: str | int | float, message: str) -> dict[str, Any]:  # noqa: A001
    """Install (or replace) the heartbeat: ``message`` is injected every ``interval``."""
    if not isinstance(message, str) or not message.strip():
        raise ValueError("heartbeat.set: message must be a non-empty string")
    return bridge.call(
        "heartbeat.set",
        {"interval_ms": parse_interval(interval), "message": message},
    )


def get() -> dict[str, Any] | None:
    """Return the active heartbeat ``{interval_ms, message, next_at_ms}`` or ``None``."""
    return bridge.call("heartbeat.get")


def clear() -> dict[str, Any]:
    """Remove the heartbeat."""
    return bridge.call("heartbeat.clear")
