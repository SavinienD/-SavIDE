"""web — chercher sur le web et récupérer des pages.

``search(query)`` renvoie les résultats classés (titre, url, extrait) en
texte ; ``fetch(url)`` renvoie le contenu lisible d'une page (HTML converti en
texte/Markdown). Les deux passent par le fournisseur web configuré dans l'IDE.
"""

from __future__ import annotations

from typing import Optional

from axecode_kernel import bridge

__all__ = ["search", "fetch"]


def search(query: str, max_results: Optional[int] = None) -> str:
    """Cherche sur le web ; renvoie les résultats mis en forme par le fournisseur."""
    params = {"query": query}
    if max_results:
        params["max_results"] = int(max_results)
    return bridge.call("web.search", params)["content"]


def fetch(url: str, prompt: Optional[str] = None) -> str:
    """Récupère une URL et renvoie son contenu lisible."""
    params = {"url": url}
    if prompt:
        params["prompt"] = prompt
    return bridge.call("web.fetch", params)["content"]
