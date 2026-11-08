"""navigateur — piloter le navigateur intégré de l'IDE (l'utilisateur voit l'onglet bouger).

``ouvrir(url)`` charge l'adresse dans l'onglet Navigateur et attend la fin du chargement ;
``lire()`` rend la page en texte compact, avec les éléments interactifs numérotés
(``[e3] bouton « Envoyer »``) ; ``lire(delta=True)`` ne rend que les lignes changées depuis
la lecture précédente (moins long). ``cliquer("e3")``, ``remplir("e2", "texte")`` et
``touche("Entrée")`` agissent sur la page ; ``attendre("Bienvenue", timeout=10)`` attend un
texte ou un sélecteur CSS ; ``capture("page.png", voir=True)`` enregistre l'image de la
partie visible (Windows et Linux) et peut la joindre au résultat. Les références ``eN``
viennent de la dernière lecture : relisez la page après un changement d'adresse.
"""

from __future__ import annotations

import difflib
import os
import time
from typing import Any, Optional

from axecode_kernel import bridge

__all__ = ["ouvrir", "lire", "cliquer", "remplir", "touche", "attendre", "capture"]

# Dernière lecture (pour lire(delta=True)) : adresse et lignes.
_dernier: dict[str, Any] = {"url": None, "lignes": []}


def _appel(methode: str, params: Optional[dict] = None, timeout: Optional[float] = 60) -> Any:
    resultat = bridge.call(f"navigateur.{methode}", params or {}, timeout=timeout)
    return resultat if isinstance(resultat, dict) else {}


def _entete(page: dict) -> str:
    titre = str(page.get("titre") or "").strip()
    url = str(page.get("url") or "")
    return f"Page : {titre} — {url}" if titre else f"Page : {url}"


def _ref(ref: Any) -> str:
    valeur = str(ref).strip().strip("[]")
    return valeur if valeur.startswith("e") else f"e{valeur}"


def _apres(action: str, reponse: dict) -> str:
    morceaux = [action, _entete(reponse)]
    if reponse.get("chargement"):
        morceaux.append("(chargement en cours)")
    if reponse.get("focus"):
        morceaux.append(f"focus : {reponse['focus']}")
    return " · ".join(morceaux)


def ouvrir(url: str) -> str:
    """Ouvre ``url`` dans l'onglet Navigateur de l'IDE et attend le chargement ; rend le titre et l'adresse."""
    reponse = _appel("ouvrir", {"url": str(url)}, timeout=90)
    _dernier.update(url=None, lignes=[])
    suite = " (chargement encore en cours)" if reponse.get("chargement") else ""
    return _entete(reponse) + suite


def lire(delta: bool = False, selecteur: Optional[str] = None, max_elements: int = 150) -> str:
    """Rend la page : titres, textes et éléments interactifs numérotés (``e1``, ``e2``…).

    ``delta=True`` : seulement les lignes ajoutées (``+``) ou retirées (``-``) depuis la
    lecture précédente. ``selecteur`` : une partie de la page (sélecteur CSS).
    """
    options: dict[str, Any] = {"max_elements": int(max_elements)}
    if selecteur:
        options["selecteur"] = str(selecteur)
    page = _appel("lire", {"options": options})
    lignes = [str(ligne) for ligne in page.get("lignes") or []]
    entete = _entete(page)
    pied = ["… (page tronquée : lire(selecteur=...) pour une partie)"] if page.get("tronque") else []
    avant_url, avant_lignes = _dernier["url"], list(_dernier["lignes"])
    _dernier.update(url=page.get("url"), lignes=lignes)
    if delta and avant_url is not None:
        if avant_url != page.get("url"):
            return "\n".join([entete + " (nouvelle adresse)"] + lignes + pied)
        changees = [ligne for ligne in difflib.ndiff(avant_lignes, lignes) if ligne[:2] in ("+ ", "- ")]
        if not changees:
            return entete + "\n(aucun changement)"
        return "\n".join([entete + " (changements)"] + changees + pied)
    if not lignes:
        lignes = ["(page vide)"]
    return "\n".join([entete] + lignes + pied)


def cliquer(ref: str) -> str:
    """Clique l'élément ``ref`` (« e3 ») de la dernière lecture ; rend l'élément et la page après le clic."""
    reponse = _appel("cliquer", {"ref": _ref(ref)})
    return _apres(f"Clic : {reponse.get('element') or ref}", reponse)


def remplir(ref: str, texte: str) -> str:
    """Remplit le champ ``ref`` avec ``texte`` (liste : valeur ou libellé ; case à cocher : « oui » ou « non »)."""
    reponse = _appel("remplir", {"ref": _ref(ref), "texte": str(texte)})
    return f"Rempli : {reponse.get('element') or ref}"


def touche(nom: str) -> str:
    """Appuie sur une touche dans la page : « Entrée », « Tab », « Échap », « Flèche bas », « Maj+Tab » ou un caractère."""
    reponse = _appel("touche", {"nom": str(nom)})
    return _apres(f"Touche : {nom}", reponse)


def attendre(texte_ou_selecteur: str, timeout: float = 10) -> bool:
    """Attend qu'un texte (ou un sélecteur CSS) soit dans la page, ``timeout`` secondes au plus ; rend True ou False."""
    fin = time.monotonic() + max(0.0, float(timeout))
    while True:
        try:
            if _appel("trouver", {"cible": str(texte_ou_selecteur)}, timeout=30).get("trouve"):
                return True
        except bridge.HostError as erreur:
            message = str(erreur)
            # Navigateur fermé ou appli absente : inutile d'attendre.
            if "pas ouvert" in message or "il faut l'appli" in message:
                raise
        if time.monotonic() >= fin:
            return False
        time.sleep(0.3)


def capture(chemin: str = "capture-navigateur.png", voir: bool = False) -> str:
    """Enregistre l'image PNG de la partie visible de la page ; ``voir=True`` la joint au résultat ; rend le chemin."""
    chemin = os.path.expanduser(str(chemin))
    absolu = chemin if os.path.isabs(chemin) else os.path.join(bridge.workspace_root(), chemin)
    reponse = _appel("capture", {"chemin": absolu}, timeout=60)
    ecrit = str(reponse.get("chemin") or absolu)
    if voir:
        from axecode_kernel import images

        images.read(ecrit)
    return ecrit
