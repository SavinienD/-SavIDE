"""rlm — sous-agents persistants.

Créez un sous-agent avec ``rlm(prompt)`` (ou ``rlm.spawn``). L'appel rend la
main tout de suite avec une poignée ``{"id": ..., "session_name": ...}`` ; le
sous-agent travaille dans sa propre session (son noyau, son journal, son
modèle) et son rapport final vous est remis comme message de pair au début
d'un tour suivant (voir le bloc ``<queued_peer_messages>`` du rappel système).

Les sous-agents sont persistants : après leur première tâche, vous pouvez
leur envoyer une suite avec ``rlm.follow_up(handle, text)``, les lister avec
``rlm.list_subagents()`` et lire leur dernier résultat avec
``rlm.result(handle)``.

Avant de lancer plus de deux enfants dans un même tour, vérifiez le quota de
l'abonnement avec ``rlm.quota()`` : le résultat de ``spawn`` contient un champ
``warning`` quand la fenêtre est presque épuisée. Une consigne explicite de
l'utilisateur passe toujours avant cet avertissement : ne bloquez jamais dessus.
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
    """Poignée légère renvoyée par ``spawn`` : ``{"id", "session_name"}``."""

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
    """Crée une session de sous-agent persistante et renvoie tout de suite sa poignée.

    ``prompt``  – la description de la tâche (complète, autonome).
    ``name``    – nom de session lisible, facultatif (unique parmi les frères et sœurs).
    ``model``   – ``"fournisseur/modèle"`` à utiliser à la place, facultatif.
    ``profile`` – identifiant d'un profil de sous-agent des Réglages ou du harnais, facultatif.

    Le résultat n'est PAS renvoyé ici : il arrive plus tard comme message de
    pair venant de l'enfant. Le dict renvoyé peut porter un ``warning`` quand
    le quota de l'abonnement est bas.
    """
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("rlm.spawn : `prompt` doit être une chaîne non vide")
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
        print(f"[rlm] avertissement : {warning}", file=sys.stderr)
    return handle


def follow_up(handle: SubAgentHandle | str | dict, text: str) -> dict[str, Any]:
    """Envoie un message de suite à un sous-agent existant (poursuit sa session)."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("rlm.follow_up : `text` doit être une chaîne non vide")
    return bridge.call("rlm.follow_up", {"id": _session_id(handle), "text": text})


def list_subagents() -> list[dict[str, Any]]:
    """Liste les sous-agents de cette session : ``id``, ``session_name``, ``status``, ``model``, ``last_result``.

    ``status`` vaut ``"error"`` quand la dernière tâche s'est arrêtée sur une erreur.
    """
    return list(bridge.call("rlm.list") or [])


def result(handle: SubAgentHandle | str | dict) -> dict[str, Any] | None:
    """Renvoie le dernier résultat connu d'un sous-agent, sans l'attendre."""
    return bridge.call("rlm.result", {"id": _session_id(handle)})


def wait(handle: SubAgentHandle | str | dict, timeout: float | None = 600) -> dict[str, Any] | None:
    """Attend que le sous-agent finisse sa tâche en cours, ``timeout`` secondes
    au plus (``None`` : sans limite). Renvoie son résultat, avec ``error`` vrai
    quand la tâche s'est arrêtée sur une erreur, ou ``None`` quand le temps est
    écoulé (le résultat arrive quand même plus tard comme message de pair).

    Laissez de préférence le résultat arriver comme message de pair ;
    n'utilisez ``wait`` que si la suite de votre travail en dépend strictement
    tout de suite.
    """
    payload: dict[str, Any] = {"id": _session_id(handle)}
    if timeout is not None:
        payload["timeout_ms"] = int(timeout * 1000)
    return bridge.call("rlm.wait", payload, timeout=(timeout + 5) if timeout else None)


def quota() -> dict[str, Any] | None:
    """Renvoie le quota de l'abonnement du fournisseur actuel, s'il est connu.

    ``None`` signifie que le fournisseur n'expose pas de quota ; ne le traitez
    jamais comme une erreur.
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
    """Fait de ``rlm(prompt, ...)`` un alias de ``rlm.spawn``."""

    def __call__(self, *args: Any, **kwargs: Any) -> SubAgentHandle:
        return spawn(*args, **kwargs)


sys.modules[__name__].__class__ = _Callable
