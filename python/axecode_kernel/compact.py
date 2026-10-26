"""compact — compacter le contexte de cette session.

``run(directive=None)`` demande une compaction avant le prochain appel du
modèle : l'historique est résumé (en suivant la ``directive`` facultative), le
journal complet reste accessible par ``context`` et les variables du noyau
sont gardées. À utiliser quand le contexte devient gros ou avant une longue
nouvelle phase de travail.
"""

from __future__ import annotations

from typing import Optional

from axecode_kernel import bridge

__all__ = ["run"]


def run(directive: Optional[str] = None) -> str:
    """Programme une compaction (appliquée avant le prochain appel du modèle).

    Un seul appel par tour : les suivants sont ignorés. Après l'appel, terminez
    votre tour.
    """
    result = bridge.call("compact.request", {"directive": directive})
    return result.get("note", "Compaction programmée : terminez votre tour maintenant.")
