"""context — accès programmatique à tout l'historique de cette session.

Le journal garde tout, y compris ce que la compaction a retiré de votre
fenêtre de contexte. ``entries(kinds)`` renvoie les entrées brutes du journal
(types : message, repl_call, repl_result, compaction, peer_message…) ;
``messages()`` renvoie ``[{"role", "text", "ts"}]`` ; ``search(text)`` trouve
les messages et appels REPL passés qui contiennent ``text``.
"""

from __future__ import annotations

from typing import Iterable, Optional

from axecode_kernel import bridge

__all__ = ["entries", "messages", "search", "info"]


def info() -> dict:
    """Identifiant, nom, dossier de travail et modèle actuel de la session."""
    return bridge.call("session.info")


def entries(kinds: Optional[Iterable[str]] = None) -> list[dict]:
    """Entrées brutes du journal, des plus anciennes aux plus récentes (filtrables par type)."""
    params = {"kinds": list(kinds)} if kinds else {}
    return bridge.call("context.entries", params)


def messages() -> list[dict]:
    """Messages texte utilisateur/assistant de toute la session, des plus anciens aux plus récents."""
    return bridge.call("session.history")


def search(text: str, limit: int = 20) -> list[dict]:
    """Messages et code/résultats REPL passés qui contiennent ``text`` (sans tenir compte de la casse)."""
    needle = text.lower()
    hits = []
    for entry in entries(["message", "repl_call", "repl_result"]):
        blob = str(entry.get("code") or entry.get("output") or entry.get("message") or "")
        if needle in blob.lower():
            hits.append(entry)
    return hits[-limit:]
