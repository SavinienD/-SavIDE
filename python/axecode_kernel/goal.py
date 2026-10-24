"""goal — objectif persistant de la session.

L'utilisateur fixe un objectif avec ``/goal <texte> [--budget N]`` ; il est
enregistré dans le journal et réinjecté au début de chaque tour avec son
avancement et le budget de jetons restant. C'est vous qui décidez quand il est
atteint.

``goal.get()``                  – objectif actuel (ou ``None``).
``goal.progress("étape 2/5 …")`` – met à jour la note d'avancement montrée à chaque tour.
``goal.complete(summary)``      – déclare l'objectif atteint (arrête /autonomous).
``goal.pause(reason)``          – garde l'objectif mais arrête la poursuite automatique.
``goal.clear()``                – oublie l'objectif.
``goal.set(text, budget)``      – fixe un objectif depuis le code (comme /goal).
"""

from __future__ import annotations

from typing import Any

from axecode_kernel import bridge

__all__ = ["get", "set", "progress", "complete", "pause", "resume", "clear"]


def get() -> dict[str, Any] | None:
    """Renvoie l'objectif actuel : ``{text, status, progress, budget_tokens, used_tokens, ...}``."""
    return bridge.call("goal.get")


def set(text: str, budget_tokens: int | None = None) -> dict[str, Any]:  # noqa: A001
    """Fixe (ou remplace) l'objectif de la session. Budget de jetons facultatif."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("goal.set : `text` doit être une chaîne non vide")
    payload: dict[str, Any] = {"text": text}
    if budget_tokens is not None:
        payload["budget_tokens"] = int(budget_tokens)
    return bridge.call("goal.set", payload)


def progress(note: str) -> dict[str, Any]:
    """Enregistre une courte note d'avancement, montrée avec l'objectif à chaque tour."""
    return bridge.call("goal.progress", {"note": str(note)})


def complete(summary: str = "") -> dict[str, Any]:
    """Déclare l'objectif atteint. Arrête toute poursuite /autonomous."""
    return bridge.call("goal.complete", {"summary": str(summary)})


def pause(reason: str = "") -> dict[str, Any]:
    """Met l'objectif en pause : il reste visible mais rien ne se poursuit automatiquement."""
    return bridge.call("goal.pause", {"reason": str(reason)})


def resume() -> dict[str, Any]:
    """Reprend un objectif en pause."""
    return bridge.call("goal.resume")


def clear() -> dict[str, Any]:
    """Supprime complètement l'objectif."""
    return bridge.call("goal.clear")
