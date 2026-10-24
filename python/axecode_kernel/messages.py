"""messages — messagerie entre agents de la même famille proche.

Une session ne peut parler qu'à son parent, à ses enfants et à ses frères et
sœurs. Les messages sont enregistrés dans le journal du destinataire et lui
sont remis au début de son tour suivant, dans le bloc
``<queued_peer_messages>`` du rappel système ; ils ne se perdent jamais dans
l'historique.

``messages.send("fini, voir le rapport", receiver_role="parent")``
``messages.send("lance aussi les tests", receiver_role="child", receiver_name="tests")``
``messages.send("pour info : j'ai changé types.ts", receiver_role="sibling", receiver_name="ui")``

``mode="new"`` (par défaut) lance une nouvelle tâche chez le destinataire s'il
est inactif ; ``mode="follow_up"`` poursuit sa conversation en cours.
"""

from __future__ import annotations

from typing import Any, Literal

from axecode_kernel import bridge

__all__ = ["send", "inbox", "family"]

ReceiverRole = Literal["parent", "child", "sibling"]
Mode = Literal["new", "follow_up"]

_ROLES = ("parent", "child", "sibling")
_MODES = ("new", "follow_up")


def send(
    text: str,
    receiver_role: ReceiverRole = "parent",
    receiver_name: str | None = None,
    mode: Mode = "new",
) -> dict[str, Any]:
    """Envoie ``text`` à un membre de la famille proche.

    ``receiver_role`` – ``"parent"`` (par défaut), ``"child"`` ou ``"sibling"``.
    ``receiver_name`` – obligatoire pour un enfant ou un frère/une sœur (nom ou
                        identifiant de session) ; ignoré pour le parent.
    ``mode``          – ``"new"`` ou ``"follow_up"``.

    Renvoie ``{"delivered_to": session_id, "message_id": ...}``.
    """
    if not isinstance(text, str) or not text.strip():
        raise ValueError("messages.send : `text` doit être une chaîne non vide")
    if receiver_role not in _ROLES:
        raise ValueError(f"messages.send : `receiver_role` doit valoir l'une de ces valeurs : {_ROLES}")
    if mode not in _MODES:
        raise ValueError(f"messages.send : `mode` doit valoir l'une de ces valeurs : {_MODES}")
    if receiver_role != "parent" and not receiver_name:
        raise ValueError("messages.send : `receiver_name` est obligatoire pour `child` et `sibling`")
    return bridge.call(
        "messages.send",
        {
            "text": text,
            "receiver_role": receiver_role,
            "receiver_name": receiver_name,
            "mode": mode,
        },
    )


def inbox() -> list[dict[str, Any]]:
    """Montre les messages en attente pour cette session (sans les consommer)."""
    return list(bridge.call("messages.inbox") or [])


def family() -> dict[str, Any]:
    """Décrit la famille proche : ``{"parent": ..., "children": [...], "siblings": [...]}``."""
    return bridge.call("messages.family") or {"parent": None, "children": [], "siblings": []}
