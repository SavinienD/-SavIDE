"""agents_cli — confier une tâche à un agent en ligne de commande (Claude Code, Codex, Gemini CLI, OpenCode…).

L'agent tourne en mode non interactif (``claude -p``, ``codex exec``, ``opencode run``…) dans le
dossier de travail, ou dans un nouvel arbre de travail git (``worktree=True``), sans bloquer le
noyau ; sa sortie va dans un journal. Il ne voit ni cette conversation ni ses secrets : la consigne
doit être complète et autonome. Par défaut le CLI garde son mode normal (il peut refuser une action
qui demande une permission) ; l'autonomie complète se règle par agent dans Réglages > Agents CLI.
Deux tâches au plus tournent en même temps (les suivantes attendent leur tour), 30 min chacune au plus.

    p = agents_cli.lancer("claude", "Corrige le test qui échoue dans tests/x.py", worktree=True)
    agents_cli.attendre(p, timeout=600)
    print(agents_cli.resultat(p)["texte"])
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Optional, Union

from axecode_kernel import bridge

__all__ = ["disponibles", "lancer", "attendre", "resultat", "arreter", "liste"]

_PAS = 1.0


@dataclass(frozen=True)
class Poignee:
    """Tâche confiée à un agent (rendue par ``lancer``) : ``id``, ``cli``, ``dossier``, ``journal``, ``branche``."""

    id: str
    cli: str
    dossier: str
    journal: str
    branche: Optional[str] = None

    def __repr__(self) -> str:
        ou = f" (branche {self.branche})" if self.branche else ""
        return f"<agents_cli {self.cli} {self.id} dans {self.dossier}{ou}>"


Cible = Union[Poignee, str, dict]


def _id(p: Cible) -> str:
    if isinstance(p, Poignee):
        return p.id
    if isinstance(p, dict) and p.get("id"):
        return str(p["id"])
    if isinstance(p, str) and p.strip():
        return p.strip()
    raise ValueError("agents_cli : poignée attendue (rendue par lancer) ou identifiant de tâche")


def disponibles() -> list[dict[str, Any]]:
    """Agents installés sur ce poste : ``[{"id", "nom", "chemin", "autonomie", "modele"}]`` (``modele`` : choix du modèle possible)."""
    return bridge.call("agents_cli.disponibles", {})


def lancer(cli: str, prompt: str, dossier: Optional[str] = None, worktree: bool = False,
           modele: Optional[str] = None) -> Poignee:
    """Lance l'agent ``cli`` (``id`` de ``disponibles()``, ex. "claude", "codex", "opencode") sur ``prompt`` ; rend la main tout de suite.

    ``dossier`` : relatif au dossier de travail (par défaut, lui) ; ``worktree=True`` : nouvel arbre de
    travail git sur une branche neuve ``agent/<cli>-<date>`` ; ``modele`` : modèle du CLI (ex. "opus")."""
    if not str(prompt or "").strip():
        raise ValueError("agents_cli.lancer : `prompt` est vide")
    params: dict[str, Any] = {"cli": str(cli), "prompt": str(prompt), "worktree": bool(worktree)}
    if dossier:
        params["dossier"] = str(dossier)
    if modele:
        params["modele"] = str(modele)
    r = bridge.call("agents_cli.lancer", params)
    return Poignee(id=r["id"], cli=r["cli"], dossier=r["dossier"], journal=r["journal"], branche=r.get("branche"))


def attendre(p: Cible, timeout: float = 600) -> dict[str, Any]:
    """Attend la fin de la tâche, ``timeout`` secondes au plus ; rend son état ``{"id", "statut", "fini", "code_sortie"}``.

    Statuts : ``en_attente``, ``en_cours``, ``termine`` (code 0), ``erreur``, ``arrete``."""
    ident = _id(p)
    fin = time.monotonic() + max(0.0, float(timeout))
    while True:
        etat = bridge.call("agents_cli.statut", {"id": ident})
        reste = fin - time.monotonic()
        if etat.get("fini") or reste <= 0:
            return etat
        time.sleep(min(_PAS, max(0.05, reste)))


def resultat(p: Cible) -> dict[str, Any]:
    """Sortie de l'agent : ``{"statut", "fini", "code_sortie", "texte", "tronque", "journal"}``.

    ``texte`` : la sortie sans couleurs, entière jusqu'à 12 000 caractères, sinon son début et sa
    fin ; ``journal`` : chemin du journal complet (à lire avec ``files.read``)."""
    return bridge.call("agents_cli.resultat", {"id": _id(p)})


def arreter(p: Cible) -> dict[str, Any]:
    """Arrête la tâche et ses processus ; rend ``{"id", "statut"}``."""
    return bridge.call("agents_cli.arreter", {"id": _id(p)})


def liste() -> list[dict[str, Any]]:
    """Tâches confiées depuis ce dossier de travail, les plus récentes d'abord."""
    return bridge.call("agents_cli.liste", {})
