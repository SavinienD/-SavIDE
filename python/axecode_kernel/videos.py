"""videos — générer des vidéos avec une API (fournisseur personnalisé).

``generate(prompt, path=None, provider=None, **options)`` envoie la demande à
l'API vidéo configurée dans Réglages > REPL > Recherche web et images > API
personnalisées (la première de type Vidéo, ou celle choisie ; ``provider=``
donne son nom pour un appel), attend la fin si l'API répond « en cours »
(suivi automatique), enregistre la vidéo (mp4/webm/mov) à ``path`` (relatif
au dossier de travail, ou absolu ; extension ajoutée si besoin), sinon dans le
dossier de données de l'appli, et renvoie son chemin. Les ``options``
(``duration``, ``aspect_ratio``, ``image_url``…) remplissent le gabarit JSON
de l'API ou s'ajoutent à côté du prompt. La clé reste dans les réglages de
l'appli : elle n'est jamais visible ici. ``providers()`` liste les API.
"""

from __future__ import annotations

from typing import Optional

from axecode_kernel import bridge

__all__ = ["generate", "providers"]


def generate(prompt: str, path: Optional[str] = None, provider: Optional[str] = None, **options) -> str:
    """Génère une vidéo d'après ``prompt`` ; renvoie le chemin du fichier enregistré."""
    params = dict(options)
    params["prompt"] = prompt
    if path:
        params["path"] = path
    if provider:
        params["provider"] = provider
    result = bridge.call("videos.generate", params)
    files = [f.get("path") for f in result.get("images", []) if f.get("path")]
    if not files:
        raise RuntimeError(result.get("content") or "aucune vidéo reçue")
    return files[0] if len(files) == 1 else files


def providers() -> list:
    """API personnalisées de génération (images et vidéos) : nom, type, modèle, hôte, clé configurée ou non."""
    return bridge.call("media.providers", {})
