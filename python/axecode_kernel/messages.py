"""messages — messaging between agents of the same nuclear family.

A session can only talk to its parent, its children and its siblings.
Messages are persisted in the journal of the receiver and delivered at the
start of its next turn inside the ``<queued_peer_messages>`` block of the
system reminder; they are never lost in the history.

``messages.send("done, see report", receiver_role="parent")``
``messages.send("please also run the tests", receiver_role="child", receiver_name="tests")``
``messages.send("heads-up: I changed types.ts", receiver_role="sibling", receiver_name="ui")``

``mode="new"`` (default) starts a fresh task for the receiver if it is idle;
``mode="follow_up"`` continues its current conversation.
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
    """Send ``text`` to a member of the nuclear family.

    ``receiver_role`` – ``"parent"`` (default), ``"child"`` or ``"sibling"``.
    ``receiver_name`` – required for children and siblings (session name or id);
                        ignored for the parent.
    ``mode``          – ``"new"`` or ``"follow_up"``.

    Returns ``{"delivered_to": session_id, "message_id": ...}``.
    """
    if not isinstance(text, str) or not text.strip():
        raise ValueError("messages.send: text must be a non-empty string")
    if receiver_role not in _ROLES:
        raise ValueError(f"messages.send: receiver_role must be one of {_ROLES}")
    if mode not in _MODES:
        raise ValueError(f"messages.send: mode must be one of {_MODES}")
    if receiver_role != "parent" and not receiver_name:
        raise ValueError("messages.send: receiver_name is required for child/sibling")
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
    """Peek at messages queued for this session (does not consume them)."""
    return list(bridge.call("messages.inbox") or [])


def family() -> dict[str, Any]:
    """Describe the nuclear family: ``{"parent": ..., "children": [...], "siblings": [...]}``."""
    return bridge.call("messages.family") or {"parent": None, "children": [], "siblings": []}
