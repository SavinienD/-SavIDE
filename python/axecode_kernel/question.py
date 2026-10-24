"""question — poser une question à l'utilisateur.

``ask(text, options=None)`` affiche la question dans la conversation.
Terminez votre tour juste après, avec la question comme message final ; la
réponse arrive comme prochain message de l'utilisateur.
"""

from __future__ import annotations

from typing import Optional, Sequence

from axecode_kernel import bridge

__all__ = ["ask"]


def ask(text: str, options: Optional[Sequence[str]] = None, multiple: bool = False) -> str:
    """Pose une question à l'utilisateur (avec des choix, si besoin)."""
    params = {"question": text, "options": list(options or []), "multiple": bool(multiple)}
    result = bridge.call("question.ask", params)
    return result.get("instruction", "Question transmise ; terminez votre tour.")
