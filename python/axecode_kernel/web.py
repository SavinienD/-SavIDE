"""web — chercher sur le web et récupérer des pages.

``search(query, max_results=None)`` renvoie un texte : résultats (titre, URL,
extrait) ou réponse sourcée, selon le fournisseur de Réglages > REPL >
Recherche web et images. En mode Automatique (par défaut) : OpenAI
(outil ``web_search``) avec la clé API OpenAI si elle est saisie, sinon avec
l'abonnement ChatGPT du compte connecté, sinon Exa (gratuit). ``fetch(url)``
renvoie le contenu lisible d'une page (HTML converti en Markdown, 64 Ko au
plus), sans IA ni compte.

Pour une autre API HTTP (service tiers, clé personnelle), appelez-la
directement : ``urllib.request`` ou ``requests``, la clé lue dans une variable
d'environnement (``os.environ["NOM"]``), jamais affichée.
"""

from __future__ import annotations

from typing import Optional

from axecode_kernel import bridge

__all__ = ["search", "fetch"]


def search(query: str, max_results: Optional[int] = None) -> str:
    """Cherche sur le web (fournisseur des réglages, voir le module) ; renvoie le texte des résultats."""
    params = {"query": query}
    if max_results:
        params["max_results"] = int(max_results)
    return bridge.call("web.search", params)["content"]


def fetch(url: str, prompt: Optional[str] = None) -> str:
    """Récupère une URL (http/https) et renvoie son contenu lisible ; ``prompt`` est ignoré (gardé pour compatibilité)."""
    params = {"url": url}
    return bridge.call("web.fetch", params)["content"]
