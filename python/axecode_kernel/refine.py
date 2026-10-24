"""refine — améliorer votre propre harnais à partir de cette trajectoire.

``refine.run(focus=None)`` demande à un planificateur en arrière-plan de lire
la trajectoire actuelle et de proposer le *plus petit* changement utile du
harnais (une mémoire, une note de prompt, un skill…). La planification ne vous
bloque jamais ; le changement est appliqué au début du tour suivant et signalé
dans le rappel système avec son identifiant. Chaque affinage est journalisé
avec ses preuves et peut être annulé par ``refine.rollback(id)``.

À utiliser après avoir corrigé une erreur, appris une préférence de
l'utilisateur ou écrit un utilitaire qui mérite d'être réutilisé.
"""

from __future__ import annotations

from typing import Any

from axecode_kernel import bridge

__all__ = ["run", "status", "history", "rollback"]


def run(focus: str | None = None) -> dict[str, Any]:
    """Lance un affinage en arrière-plan (ciblé si besoin, par ex. ``"git workflow"``)."""
    return bridge.call("refine.run", {"focus": focus})


def status() -> dict[str, Any]:
    """Affinage en attente (s'il y en a un) et les enregistrements les plus récents."""
    return bridge.call("refine.status", {})


def history() -> list[dict[str, Any]]:
    """Tous les enregistrements d'affinage, du plus récent au plus ancien."""
    return bridge.call("refine.history", {}) or []


def rollback(id: str) -> dict[str, Any]:  # noqa: A002
    """Annule un affinage appliqué, d'après son identifiant."""
    return bridge.call("refine.rollback", {"id": id})
