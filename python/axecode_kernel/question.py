"""question — ask the user something.

``ask(text, options=None)`` shows the question in the chat. End your turn
right after with the question as your final message; the answer arrives as
the next user message.
"""

from __future__ import annotations

from typing import Optional, Sequence

from axecode_kernel import bridge

__all__ = ["ask"]


def ask(text: str, options: Optional[Sequence[str]] = None, multiple: bool = False) -> str:
    """Ask the user a question (optionally with choices)."""
    params = {"question": text, "options": list(options or []), "multiple": bool(multiple)}
    result = bridge.call("question.ask", params)
    return result.get("instruction", "Question delivered; end your turn.")
