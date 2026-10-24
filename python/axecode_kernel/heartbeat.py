"""heartbeat — message périodique injecté dans la session.

Sert à surveiller un sous-agent, un long processus ou une compilation sans
attente active : ``heartbeat.set("30s", "vérifie si le sous-agent des tests a
fini")`` fait injecter ce message comme tour utilisateur toutes les 30
secondes tant que la session n'a rien d'autre à faire. ``heartbeat.clear()``
l'arrête.

Intervalles acceptés : ``"45s"``, ``"2m"``, ``"1h"`` ou un nombre de secondes.
Commande équivalente : ``/heartbeat <intervalle> <message>``.
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
    """Convertit ``"30s"`` / ``"2m"`` / ``90`` en millisecondes (minimum 5 s)."""
    if isinstance(value, (int, float)):
        ms = int(value * 1000)
    else:
        match = _INTERVAL_RE.match(str(value))
        if not match:
            raise ValueError(f"heartbeat : intervalle invalide {value!r} (par exemple '30s', '2m', '1h')")
        amount, unit = match.groups()
        ms = int(float(amount) * _UNIT_MS[(unit or "").lower() or None])
    if ms < MIN_INTERVAL_MS:
        raise ValueError(f"heartbeat : l'intervalle doit être d'au moins {MIN_INTERVAL_MS // 1000} s")
    return ms


def set(interval: str | int | float, message: str) -> dict[str, Any]:  # noqa: A001
    """Installe (ou remplace) le heartbeat : ``message`` est injecté tous les ``interval``."""
    if not isinstance(message, str) or not message.strip():
        raise ValueError("heartbeat.set : `message` doit être une chaîne non vide")
    return bridge.call(
        "heartbeat.set",
        {"interval_ms": parse_interval(interval), "message": message},
    )


def get() -> dict[str, Any] | None:
    """Renvoie le heartbeat actif ``{interval_ms, message, next_at_ms}`` ou ``None``."""
    return bridge.call("heartbeat.get")


def clear() -> dict[str, Any]:
    """Supprime le heartbeat."""
    return bridge.call("heartbeat.clear")
