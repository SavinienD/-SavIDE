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

Chaque rapport commence par le statut final de l'enfant : ``réussi``,
``échoué``, ``bloqué`` ou ``arrêté`` (aussi dans ``result``/``wait``).
``rlm.stop`` arrête un enfant, ``rlm.retry`` relance sa tâche dans un nouvel
enfant. Avec ``spawn(..., worktree=True)``, l'enfant travaille dans son propre
worktree git (branche ``sous-agent/<nom>``) : ``rlm.worktree``,
``rlm.fusionner``, ``rlm.liberer``. ``rlm.course`` lance la même tâche sur
plusieurs modèles, ``rlm.comparer`` aide à garder la meilleure version.

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
    "stop",
    "retry",
    "worktree",
    "fusionner",
    "liberer",
    "course",
    "comparer",
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
    worktree: bool | str = False,
) -> SubAgentHandle:
    """Crée une session de sous-agent persistante et renvoie tout de suite sa poignée.

    ``prompt``   – la description de la tâche (complète, autonome).
    ``name``     – nom de session lisible, facultatif (unique parmi les frères et sœurs).
    ``model``    – ``"fournisseur/modèle"`` à utiliser à la place, facultatif.
    ``profile``  – identifiant d'un profil de sous-agent des Réglages ou du harnais, facultatif.
    ``worktree`` – ``True`` (ou un nom) : si votre dossier est un dépôt git,
                   l'enfant travaille dans son propre worktree, sur la branche
                   ``sous-agent/<nom>``, rangé hors du dépôt
                   (``<dossier parent du dépôt>/<dépôt>-sous-agents/<nom>``),
                   parti de votre commit courant (vos modifications non
                   validées ne le suivent pas). Ensuite : ``worktree()``,
                   ``fusionner()``, ``liberer()``. Pas un dépôt git : erreur.

    Le résultat n'est PAS renvoyé ici : il arrive plus tard comme message de
    pair venant de l'enfant, qui commence par son statut (``STATUT: réussi``…).
    Le dict renvoyé porte ``worktree`` et ``branche`` le cas échéant, et un
    ``warning`` quand le quota de l'abonnement est bas.
    """
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("rlm.spawn : `prompt` doit être une chaîne non vide")
    if not isinstance(worktree, (bool, str)):
        raise TypeError("rlm.spawn : `worktree` doit valoir True, False ou un nom")
    payload: dict[str, Any] = {"prompt": prompt}
    if name:
        payload["name"] = name
    if model:
        payload["model"] = model
    if profile:
        payload["profile"] = profile
    if worktree:
        payload["worktree"] = worktree.strip() if isinstance(worktree, str) else True
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
    """Renvoie le dernier résultat connu d'un sous-agent, sans l'attendre.

    ``{"text", "statut", "fichiers", "error", "truncated", "ts", ...}`` :
    ``statut`` parmi ``"réussi"``, ``"échoué"``, ``"bloqué"``, ``"arrêté"`` ;
    ``fichiers`` = fichiers modifiés dans son worktree (vide sans worktree).
    """
    return bridge.call("rlm.result", {"id": _session_id(handle)})


def wait(handle: SubAgentHandle | str | dict, timeout: float | None = 600) -> dict[str, Any] | None:
    """Attend que le sous-agent finisse sa tâche en cours, ``timeout`` secondes
    au plus (``None`` : sans limite). Renvoie son résultat (voir ``result``),
    ou ``None`` quand le temps est écoulé (le résultat arrive quand même plus
    tard comme message de pair).

    ``statut`` vaut ``"réussi"``, ``"échoué"``, ``"bloqué"`` ou ``"arrêté"`` :
    l'enfant finit son rapport par une ligne ``STATUT: …`` (à défaut :
    ``réussi`` sans erreur, ``échoué`` sur une erreur).

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


def stop(handle: SubAgentHandle | str | dict) -> dict[str, Any]:
    """Arrête le tour en cours d'un sous-agent, comme le bouton Stop ; son statut devient ``"arrêté"``.

    Rien ne change s'il ne travaillait pas (``etait_en_cours`` faux). La
    session reste vivante : ``follow_up`` la relance, ``retry`` repart de zéro.
    Son worktree éventuel est gardé tel quel.
    """
    return bridge.call("rlm.stop", {"id": _session_id(handle)}) or {}


def retry(handle: SubAgentHandle | str | dict, note: str | None = None) -> SubAgentHandle:
    """Relance la tâche dans un NOUVEL enfant : même brief, même modèle, même profil, plus le rapport de la tentative précédente et ``note``.

    L'ancien enfant est d'abord arrêté s'il travaille encore ; il garde sa
    session et son worktree (à comparer, fusionner ou libérer). Si l'ancien
    avait un worktree, le nouveau en reçoit un neuf, parti de votre commit
    courant. Renvoie la poignée du nouvel enfant (champ ``reprise_de``).
    """
    payload: dict[str, Any] = {"id": _session_id(handle)}
    if note and note.strip():
        payload["note"] = note.strip()
    return SubAgentHandle(bridge.call("rlm.retry", payload))


def worktree(handle: SubAgentHandle | str | dict) -> dict[str, Any]:
    """Où en est le worktree d'un sous-agent lancé avec ``worktree=True``.

    Renvoie ``{"chemin", "branche", "base", "fichiers", "diff_stat",
    "commits", "existe", "en_cours"}`` : ``fichiers`` = fichiers modifiés
    depuis la base (validés ou non, nouveaux compris), ``diff_stat`` = sortie
    de ``git diff --stat``. Après ``liberer``, l'état est lu sur la branche.
    """
    return bridge.call("rlm.worktree", {"id": _session_id(handle)}) or {}


def fusionner(handle: SubAgentHandle | str | dict) -> dict[str, Any]:
    """Fusionne la branche du sous-agent dans votre branche courante (``git merge --no-ff``).

    Son travail non validé est d'abord validé sur sa branche. Refusé tant
    qu'il travaille encore (``wait`` ou ``stop`` d'abord). Sur un conflit, la
    fusion est annulée et votre branche reste inchangée : la réponse porte
    ``fusionne: False`` et ``conflits`` (liste des fichiers), et le message
    est écrit sur stderr ; faites alors corriger l'enfant (``follow_up``)
    puis fusionnez de nouveau. Succès : ``fusionne: True``, ``commit``,
    ``fichiers``, ``diff_stat``.
    """
    reply = bridge.call("rlm.fusionner", {"id": _session_id(handle)}) or {}
    if not reply.get("fusionne") and reply.get("message"):
        print(f"[rlm] {reply['message']}", file=sys.stderr)
    return reply


def liberer(handle: SubAgentHandle | str | dict, garder_branche: bool = True) -> dict[str, Any]:
    """Supprime le worktree d'un sous-agent (son travail non validé est d'abord validé sur sa branche).

    ``garder_branche=False`` supprime aussi la branche, seulement si elle est
    déjà fusionnée (sinon elle est gardée et le message le dit). Refusé tant
    que l'enfant travaille. Ensuite, l'enfant n'a plus de dossier de travail :
    ne lui envoyez plus de suite.
    """
    return bridge.call("rlm.liberer", {"id": _session_id(handle), "garder_branche": bool(garder_branche)}) or {}


def course(
    prompt: str,
    modeles: list[str],
    worktree: bool | str = True,
    name: str | None = None,
) -> list[SubAgentHandle]:
    """Lance la même tâche sur plusieurs modèles (un enfant par modèle, chacun dans son worktree) ; renvoie leurs poignées.

    ``modeles`` – liste de ``"fournisseur/modèle"``.
    ``name``    – préfixe des noms (``"course"`` par défaut) : ``course-<modèle>``.
    Comparez ensuite avec ``comparer(poignees)``, fusionnez la meilleure
    version avec ``fusionner`` et libérez les autres avec ``liberer``.
    """
    modeles = [m for m in (modeles or []) if isinstance(m, str) and m.strip()]
    if not modeles:
        raise ValueError("rlm.course : `modeles` doit contenir au moins un \"fournisseur/modèle\"")
    base = (name or "course").strip() or "course"
    poignees = []
    for m in modeles:
        court = "".join(c if c.isalnum() or c in "._-" else "-" for c in m.split("/", 1)[-1]).strip("-.") or "modele"
        poignees.append(spawn(prompt, name=f"{base}-{court}", model=m.strip(), worktree=worktree))
    return poignees


class Comparaison(list):
    """Lignes de ``comparer`` (dicts), affichées en tableau Markdown."""

    def __repr__(self) -> str:
        lignes = ["| sous-agent | modèle | statut | durée | fichiers | diff --stat |",
                  "|---|---|---|---|---|---|"]
        for r in self:
            lignes.append("| {} | {} | {} | {} | {} | {} |".format(
                r.get("session_name", ""), r.get("modele", ""), r.get("statut", ""),
                _duree(r.get("duree_s") or 0), len(r.get("fichiers") or []), r.get("diff_stat") or "—"))
        return "\n".join(lignes)

    __str__ = __repr__


def comparer(poignees: list[SubAgentHandle | str | dict]) -> list[dict[str, Any]]:
    """Compare des sous-agents (par ex. ceux d'une ``course``) : un tableau statut, durée, fichiers modifiés, diff --stat.

    Chaque ligne est un dict ``{"session_name", "modele", "statut", "duree_s",
    "fichiers", "diff_stat", "diff_stat_complet", "branche", "id"}`` ;
    l'affichage de la liste est un tableau Markdown. Le statut vaut
    ``"en cours"`` tant que l'enfant travaille.
    """
    ids = [_session_id(p) for p in poignees]
    return Comparaison(bridge.call("rlm.comparer", {"ids": ids}) or [])


def _duree(secondes: int) -> str:
    s = int(secondes)
    if s < 60:
        return f"{s} s"
    if s < 3600:
        return f"{s // 60} min {s % 60:02d} s" if s % 60 else f"{s // 60} min"
    return f"{s // 3600} h {(s % 3600) // 60:02d} min"


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
