"""guet — être réveillé quand une tâche se termine (sans heartbeat ni boucle).

Le guet tourne dans le service SavIDE, pas dans ce noyau : il survit à la fin
du tour et au redémarrage du noyau. À la fin, un message
``<guet id=… statut=…>`` (code de sortie et fin de la sortie) lance un tour ;
si un tour tourne déjà, il est livré dès sa fin. Pose le guet puis termine ton
tour : n'attends pas et ne vérifie pas toi-même.
Statuts : ``termine`` (commande finie), ``reussi`` (condition vraie, fichier
apparu), ``delai_depasse``, ``interrompu`` (service redémarré), ``erreur``.
Durées : ``"30s"``, ``"5m"``, ``"2h"`` ou un nombre de secondes.
Commande équivalente : ``/guet <phrase libre>`` (« /guet annule » pour arrêter).
"""

from __future__ import annotations

import re
from typing import Any, Optional

from axecode_kernel import bridge

__all__ = ["commande", "condition", "fichier", "liste", "annuler"]

_DUREE_RE = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(ms|s|sec|m|min|h|hr)?\s*$", re.IGNORECASE)
_UNITE_MS = {"": 1000, "ms": 1, "s": 1000, "sec": 1000, "m": 60_000, "min": 60_000, "h": 3_600_000, "hr": 3_600_000}


def _ms(valeur: str | int | float, nom: str) -> int:
    if isinstance(valeur, (int, float)):
        return int(valeur * 1000)
    m = _DUREE_RE.match(str(valeur))
    if not m:
        raise ValueError(f"guet : durée `{nom}` invalide {valeur!r} (par exemple '30s', '5m', '2h')")
    return int(float(m.group(1).replace(",", ".")) * _UNITE_MS[(m.group(2) or "").lower()])


def _params(message: Optional[str], timeout, cwd: Optional[str], **autres) -> dict:
    p: dict[str, Any] = {k: v for k, v in autres.items() if v is not None}
    if message:
        p["message"] = message
    if cwd:
        p["cwd"] = str(cwd)
    if timeout is not None:
        p["timeout_ms"] = _ms(timeout, "timeout")
    return p


def commande(cmd: str, message: Optional[str] = None, timeout: str | int | float = "2h",
             cwd: Optional[str] = None) -> dict[str, Any]:
    """Lance ``cmd`` (shell, dossier de travail) en arrière-plan ; réveil à sa fin avec code et fin de sortie."""
    return bridge.call("guet.commande", _params(message, timeout, cwd, cmd=cmd))


def condition(cmd: str, intervalle: str | int | float = "30s", timeout: str | int | float = "2h",
              message: Optional[str] = None, cwd: Optional[str] = None) -> dict[str, Any]:
    """Relance ``cmd`` tous les ``intervalle`` jusqu'à ce qu'elle réussisse (code 0), puis réveille."""
    return bridge.call("guet.condition", _params(message, timeout, cwd, cmd=cmd, intervalle_ms=_ms(intervalle, "intervalle")))


def fichier(chemin: str, intervalle: str | int | float = "5s", timeout: str | int | float = "2h",
            message: Optional[str] = None) -> dict[str, Any]:
    """Réveille quand le fichier ``chemin`` existe (relatif au dossier de travail)."""
    return bridge.call("guet.fichier", _params(message, timeout, None, chemin=str(chemin), intervalle_ms=_ms(intervalle, "intervalle")))


def liste() -> list[dict[str, Any]]:
    """Guets en cours : ``[{"id", "genre", "cible", "statut", "depuis_ms", "prochain_ms", "essais"}]``."""
    return bridge.call("guet.liste")


def annuler(id: Optional[str] = None) -> dict[str, Any]:  # noqa: A002
    """Annule le guet ``id`` (tous si absent) : pas de réveil, la commande lancée est arrêtée."""
    return bridge.call("guet.annuler", {"id": id or ""})
