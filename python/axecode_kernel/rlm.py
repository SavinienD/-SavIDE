"""rlm — sous-agents persistants.

Créez un sous-agent avec ``rlm(prompt)`` (ou ``rlm.spawn``). L'appel rend la
main tout de suite avec une poignée ``{"id": ..., "session_name": ...}`` ; le
sous-agent travaille dans sa propre session (son noyau, son journal, son
modèle) et son rapport final vous est remis comme message de pair au début
d'un tour suivant (voir le bloc ``<queued_peer_messages>`` du rappel système).

Les sous-agents sont persistants : après leur première tâche, vous pouvez
leur envoyer une suite avec ``rlm.follow_up(handle, text)``, les lister avec
``rlm.list_subagents()`` et lire leur dernier résultat avec
``rlm.result(handle)``.

Appels légers (Recursive Language Models) : ``rlm.query(texte)`` et
``rlm.query_lot(textes)`` font un seul échange avec le modèle, sans session
ni outils : gardez un gros document dans une variable et faites-le lire
morceau par morceau, sans le mettre dans votre contexte.

Avant de lancer plus de deux enfants dans un même tour, vérifiez le quota de
l'abonnement avec ``rlm.quota()`` : le résultat de ``spawn`` contient un champ
``warning`` quand la fenêtre est presque épuisée. Une consigne explicite de
l'utilisateur passe toujours avant cet avertissement : ne bloquez jamais dessus.
"""

from __future__ import annotations

import sys
from typing import Any

from axecode_kernel import bridge

__all__ = [
    "spawn",
    "follow_up",
    "list_subagents",
    "result",
    "quota",
    "wait",
    "query",
    "query_lot",
]


class SubAgentHandle(dict):
    """Poignée légère renvoyée par ``spawn`` : ``{"id", "session_name"}``."""

    @property
    def id(self) -> str:  # noqa: A003 - mirrors the wire field
        return str(self["id"])

    @property
    def session_name(self) -> str:
        return str(self.get("session_name") or self["id"])

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"SubAgentHandle(id={self['id']!r}, session_name={self.get('session_name')!r})"


def spawn(
    prompt: str,
    name: str | None = None,
    model: str | None = None,
    profile: str | None = None,
) -> SubAgentHandle:
    """Crée une session de sous-agent persistante et renvoie tout de suite sa poignée.

    ``prompt``  – la description de la tâche (complète, autonome).
    ``name``    – nom de session lisible, facultatif (unique parmi les frères et sœurs).
    ``model``   – ``"fournisseur/modèle"`` à utiliser à la place, facultatif.
    ``profile`` – identifiant d'un profil de sous-agent des Réglages ou du harnais, facultatif.

    Le résultat n'est PAS renvoyé ici : il arrive plus tard comme message de
    pair venant de l'enfant. Le dict renvoyé peut porter un ``warning`` quand
    le quota de l'abonnement est bas.
    """
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("rlm.spawn : `prompt` doit être une chaîne non vide")
    payload: dict[str, Any] = {"prompt": prompt}
    if name:
        payload["name"] = name
    if model:
        payload["model"] = model
    if profile:
        payload["profile"] = profile
    reply = bridge.call("rlm.spawn", payload)
    handle = SubAgentHandle(reply)
    warning = reply.get("warning")
    if warning:
        print(f"[rlm] avertissement : {warning}", file=sys.stderr)
    return handle


def follow_up(handle: SubAgentHandle | str | dict, text: str) -> dict[str, Any]:
    """Envoie un message de suite à un sous-agent existant (poursuit sa session)."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("rlm.follow_up : `text` doit être une chaîne non vide")
    return bridge.call("rlm.follow_up", {"id": _session_id(handle), "text": text})


def list_subagents() -> list[dict[str, Any]]:
    """Liste les sous-agents de cette session : ``id``, ``session_name``, ``status``, ``model``, ``last_result``.

    ``status`` vaut ``"error"`` quand la dernière tâche s'est arrêtée sur une erreur.
    """
    return list(bridge.call("rlm.list") or [])


def result(handle: SubAgentHandle | str | dict) -> dict[str, Any] | None:
    """Renvoie le dernier résultat connu d'un sous-agent, sans l'attendre."""
    return bridge.call("rlm.result", {"id": _session_id(handle)})


def wait(handle: SubAgentHandle | str | dict, timeout: float | None = 600) -> dict[str, Any] | None:
    """Attend que le sous-agent finisse sa tâche en cours, ``timeout`` secondes
    au plus (``None`` : sans limite). Renvoie son résultat, avec ``error`` vrai
    quand la tâche s'est arrêtée sur une erreur, ou ``None`` quand le temps est
    écoulé (le résultat arrive quand même plus tard comme message de pair).

    Laissez de préférence le résultat arriver comme message de pair ;
    n'utilisez ``wait`` que si la suite de votre travail en dépend strictement
    tout de suite.
    """
    payload: dict[str, Any] = {"id": _session_id(handle)}
    if timeout is not None:
        payload["timeout_ms"] = int(timeout * 1000)
    return bridge.call("rlm.wait", payload, timeout=(timeout + 5) if timeout else None)


def quota() -> dict[str, Any] | None:
    """Renvoie le quota de l'abonnement du fournisseur actuel, s'il est connu.

    ``None`` signifie que le fournisseur n'expose pas de quota ; ne le traitez
    jamais comme une erreur.
    """
    try:
        return bridge.call("rlm.quota")
    except bridge.HostError:
        return None


class ResultatsLot(list):
    """Réponses de ``query_lot`` dans l'ordre des textes (``None`` pour un
    élément en échec), avec ``erreurs`` : ``[(indice, message), ...]`` et
    ``usage`` : jetons cumulés ``{"input_tokens": ..., "output_tokens": ...}``."""

    def __init__(self, items=(), erreurs=None, usage=None):
        super().__init__(items)
        self.erreurs: list[tuple[int, str]] = list(erreurs or [])
        self.usage: dict[str, int] = dict(usage or {})


def query(
    texte: str,
    systeme: str | None = None,
    modele: str | None = None,
    plafond: int | None = None,
) -> str:
    """Un appel léger au modèle : un seul échange, sans session, sans outils ni harnais ; renvoie le texte de la réponse.

    C'est l'outil des Recursive Language Models : gardez le gros document dans
    une variable du noyau, découpez-le, et faites lire chaque morceau par
    ``query`` (ou ``query_lot``) au lieu de le mettre dans votre contexte.
    Aucun fichier n'est lu ni modifié, aucun outil n'est disponible : tout ce
    dont le modèle a besoin doit être dans ``texte`` (et ``systeme``).

    ``texte``   – le message envoyé au modèle (le morceau et la question).
    ``systeme`` – consigne système facultative (rôle, format de réponse).
    ``modele``  – ``"fournisseur/modèle"`` facultatif ; par défaut le modèle des
                  sous-agents des Réglages, sinon celui de cette conversation.
                  Compte et clé : ceux configurés dans l'appli pour ce fournisseur.
    ``plafond`` – jetons de sortie au plus (4 000 par défaut).

    Pas de réflexion étendue. Les erreurs passagères (réseau, 429) sont
    réessayées deux fois ; une erreur définitive lève ``bridge.HostError``.
    Une réponse coupée par le plafond est signalée sur stderr.

    Exemple ::

        morceaux = [doc[i:i + 40_000] for i in range(0, len(doc), 40_000)]
        notes = rlm.query_lot([f"Relève les montants :\n{m}" for m in morceaux])
        synthese = rlm.query("Fais la somme :\n" + "\n".join(n or "" for n in notes))
    """
    if not isinstance(texte, str) or not texte.strip():
        raise ValueError("rlm.query : `texte` doit être une chaîne non vide")
    payload: dict[str, Any] = {"texte": texte}
    payload.update(_options(systeme, modele, plafond))
    reply = bridge.call("rlm.query", payload) or {}
    if reply.get("tronque"):
        print(f"[rlm] réponse coupée au plafond de sortie ({plafond or 4000} jetons) : "
              "augmentez `plafond` ou demandez une réponse plus courte", file=sys.stderr)
    return str(reply.get("texte") or "")


def query_lot(
    textes: list[str],
    systeme: str | None = None,
    modele: str | None = None,
    parallele: int = 4,
    plafond: int | None = None,
) -> list[str | None]:
    """Plusieurs appels légers (comme ``query``), ``parallele`` à la fois (16 au plus) ; renvoie les réponses dans l'ordre des textes.

    Même consigne ``systeme``, même ``modele`` et même ``plafond`` pour tous
    les éléments. Idéal pour traiter un gros document morceau par morceau.

    Erreurs : un élément en échec ne bloque pas les autres. Il vaut ``None``
    dans la liste rendue, et la liste porte ``.erreurs`` = ``[(indice,
    message), ...]`` (un résumé est aussi écrit sur stderr) : relancez au
    besoin les seuls éléments en échec. Si TOUS les éléments échouent,
    ``bridge.HostError`` est levée avec la première erreur. La liste porte
    aussi ``.usage`` (jetons cumulés). 2 000 textes au plus par lot.

    Exemple ::

        r = rlm.query_lot(morceaux, systeme="Résume en 5 puces.", parallele=6)
        a_refaire = [morceaux[i] for i, _ in r.erreurs]
    """
    if isinstance(textes, (str, bytes)) or not hasattr(textes, "__iter__"):
        raise TypeError("rlm.query_lot : `textes` doit être une liste de chaînes")
    textes = list(textes)
    if not all(isinstance(t, str) for t in textes):
        raise TypeError("rlm.query_lot : chaque élément de `textes` doit être une chaîne")
    if not isinstance(parallele, int) or parallele < 1:
        raise ValueError("rlm.query_lot : `parallele` doit être un entier ≥ 1")
    if not textes:
        return ResultatsLot()
    payload: dict[str, Any] = {"textes": textes}
    payload.update(_options(systeme, modele, plafond))
    payload["parallele"] = parallele
    reponses = list(bridge.call("rlm.query_lot", payload) or [])
    valeurs: list[str | None] = []
    erreurs: list[tuple[int, str]] = []
    usage: dict[str, int] = {}
    coupees = 0
    for i, rep in enumerate(reponses):
        rep = rep or {}
        if "erreur" in rep:
            valeurs.append(None)
            erreurs.append((i, str(rep.get("erreur"))))
            continue
        valeurs.append(str(rep.get("texte") or ""))
        coupees += bool(rep.get("tronque"))
        for cle in ("input_tokens", "output_tokens"):
            usage[cle] = usage.get(cle, 0) + int((rep.get("usage") or {}).get(cle) or 0)
    if erreurs and len(erreurs) == len(reponses):
        raise bridge.HostError(f"rlm.query_lot : tous les éléments ont échoué ({erreurs[0][1]})")
    if erreurs:
        apercu = " ; ".join(f"#{i} {m[:120]}" for i, m in erreurs[:3])
        print(f"[rlm] query_lot : {len(erreurs)} sur {len(reponses)} en échec (None dans la liste, "
              f"détail dans .erreurs) : {apercu}", file=sys.stderr)
    if coupees:
        print(f"[rlm] query_lot : {coupees} réponse(s) coupée(s) au plafond de sortie", file=sys.stderr)
    return ResultatsLot(valeurs, erreurs, usage)


def _options(systeme: str | None, modele: str | None, plafond: int | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if systeme:
        out["systeme"] = systeme
    if modele:
        out["modele"] = modele
    if plafond is not None:
        if not isinstance(plafond, int) or plafond < 1:
            raise ValueError("rlm : `plafond` doit être un entier ≥ 1 (jetons de sortie)")
        out["plafond"] = plafond
    return out


def _session_id(handle: Any) -> str:
    if isinstance(handle, dict):
        return str(handle.get("id") or handle.get("session_id"))
    return str(handle)


class _Callable(sys.modules[__name__].__class__):
    """Fait de ``rlm(prompt, ...)`` un alias de ``rlm.spawn``."""

    def __call__(self, *args: Any, **kwargs: Any) -> SubAgentHandle:
        return spawn(*args, **kwargs)


sys.modules[__name__].__class__ = _Callable
