"""automatisations — prompts planifiés, lancés par le service même appli fermée.

Horaire : ``"08:00"`` (tous les jours), ``{"jours": [1, 5], "heure": "08:00"}``
(1 = lundi … 7 = dimanche), ``{"heures": 2}`` (toutes les 2 heures, calées sur
minuit) ou ``"cron:0 8 * * 1-5"``. Chaque exécution ouvre une nouvelle
conversation dans le dossier (``meme_conversation=True`` : toujours la même) ;
dossier et modèle par défaut : ceux de cette conversation. Après une veille ou
un arrêt du PC, une seule exécution manquée est rattrapée (``rattrapage=False``
pour l'éviter). Jamais deux exécutions à la fois. Écran : Automatisations
(Ctrl+Maj+L).
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Optional

from axecode_kernel import bridge

__all__ = ["creer", "lister", "modifier", "supprimer", "lancer", "historique"]

# Nom Python -> nom du service.
_CHAMPS = {
    "nom": "nom",
    "prompt": "prompt",
    "horaire": "horaire",
    "dossier": "dossier",
    "modele": "modele",
    "meme_conversation": "memeConversation",
    "active": "active",
    "rattrapage": "rattrapage",
    "verification": "verification",
}


def _horaire(h: Any) -> dict:
    if isinstance(h, dict):
        if "type" in h:
            return dict(h)
        if "cron" in h:
            return {"type": "cron", "expression": str(h["cron"])}
        if "jours" in h:
            return {"type": "hebdomadaire", "jours": [int(j) for j in h["jours"]], "heure": str(h.get("heure", "08:00"))}
        if "heures" in h:
            return {"type": "intervalle", "heures": int(h["heures"]), "minute": int(h.get("minute", 0))}
        if "heure" in h:
            return {"type": "quotidien", "heure": str(h["heure"])}
    if isinstance(h, str) and h.strip():
        t = h.strip()
        if t.lower().startswith("cron:"):
            return {"type": "cron", "expression": t[5:].strip()}
        if t.startswith("@") or len(t.split()) == 5:
            return {"type": "cron", "expression": t}
        return {"type": "quotidien", "heure": t}
    raise ValueError(
        f"automatisations : horaire illisible {h!r} (par exemple '08:00', "
        "{'jours': [1], 'heure': '08:00'}, {'heures': 2} ou 'cron:0 8 * * 1-5')"
    )


def _date(ms: Optional[int]) -> Optional[str]:
    if not ms:
        return None
    return _dt.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M")


def _ligne(x: dict, nom: Optional[str] = None) -> dict:
    fin, debut = x.get("finMs"), x.get("debutMs")
    ligne = {
        "statut": x.get("statut"),
        "date": _date(x.get("prevueMs") or debut),
        "declencheur": x.get("declencheur"),
        "duree_s": round((fin - debut) / 1000) if fin and debut else None,
        "resume": x.get("resume"),
        "session_id": x.get("sessionId"),
    }
    return {"automatisation": nom, **ligne} if nom is not None else ligne


def _fiche(a: dict) -> dict:
    h = a.get("historique") or []
    m = a.get("modele") or {}
    return {
        "id": a.get("id"),
        "nom": a.get("nom"),
        "dossier": a.get("dossier"),
        "horaire": a.get("horaireTexte"),
        "active": a.get("active"),
        "prochaine": _date(a.get("prochaineMs")),
        "en_cours": a.get("enCours"),
        "modele": f"{m.get('provider')}/{m.get('name')}" if m else None,
        "meme_conversation": a.get("memeConversation"),
        "verification": a.get("verification"),
        "derniere": _ligne(h[0]) if h else None,
    }


def creer(nom: str, prompt: str, horaire: Any, dossier: Optional[str] = None, modele: Optional[str] = None,
          meme_conversation: bool = False, active: bool = True, rattrapage: bool = True,
          verification: Optional[str] = None) -> dict[str, Any]:
    """Crée une automatisation et renvoie sa fiche (``id``, ``horaire`` en clair, ``prochaine``). ``modele`` : ``"fournisseur/modèle"`` ; ``verification`` : commande shell lancée dans le dossier avant chaque exécution prévue (code 0 = on lance, sinon elle est sautée)."""
    p: dict[str, Any] = {
        "nom": nom,
        "prompt": prompt,
        "horaire": _horaire(horaire),
        "memeConversation": bool(meme_conversation),
        "active": bool(active),
        "rattrapage": bool(rattrapage),
    }
    if dossier:
        p["dossier"] = str(dossier)
    if modele:
        p["modele"] = modele
    if verification:
        p["verification"] = verification
    return _fiche(bridge.call("automatisations.creer", p))


def lister() -> list[dict[str, Any]]:
    """Toutes les automatisations, de tous les dossiers : horaire en clair, prochaine exécution, dernière exécution."""
    r = bridge.call("automatisations.lister", {}) or {}
    return [_fiche(a) for a in r.get("automatisations", [])]


def modifier(id: str, **champs: Any) -> dict[str, Any]:  # noqa: A002
    """Change des champs : ``nom``, ``prompt``, ``horaire``, ``dossier``, ``modele``, ``meme_conversation``, ``active`` (``False`` = pause), ``rattrapage``, ``verification``."""
    inconnus = sorted(set(champs) - set(_CHAMPS))
    if inconnus:
        raise TypeError(f"automatisations.modifier : champ inconnu {', '.join(inconnus)} (possibles : {', '.join(_CHAMPS)})")
    p: dict[str, Any] = {"id": id}
    for cle, valeur in champs.items():
        if cle == "horaire":
            valeur = _horaire(valeur)
        elif cle == "verification" and valeur is None:
            valeur = ""
        p[_CHAMPS[cle]] = valeur
    return _fiche(bridge.call("automatisations.modifier", p))


def supprimer(id: str) -> dict[str, Any]:  # noqa: A002
    """Supprime une automatisation ; ses conversations restent."""
    return bridge.call("automatisations.supprimer", {"id": id})


def lancer(id: str) -> dict[str, Any]:  # noqa: A002
    """Lance une exécution tout de suite, sans la vérification ; refusé si une exécution tourne déjà."""
    return _ligne(bridge.call("automatisations.lancer", {"id": id}))


def historique(id: Optional[str] = None, limite: int = 20) -> list[dict[str, Any]]:  # noqa: A002
    """Dernières exécutions (toutes, ou d'une automatisation) : date, statut, durée, résumé, conversation."""
    p: dict[str, Any] = {"limite": int(limite)}
    if id:
        p["id"] = id
    return [_ligne(x, x.get("nom")) for x in (bridge.call("automatisations.historique", p) or [])]

