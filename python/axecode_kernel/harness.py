"""harness — votre harnais continu (mémoire persistante d'une session à l'autre).

Quatre sortes d'entrées, chacune dans deux portées (``"global"`` suit
l'utilisateur partout, ``"project"`` vit dans ``<workspace>/.axecode/harness`` s'il existe déjà, sinon dans les données de l'appli) :

* notes de prompt    – consignes permanentes injectées à chaque tour
* mémoires           – faits appris sur l'utilisateur / le projet, injectés à chaque tour
* skills             – paquets Python importables (``import <nom_du_skill>``) + SKILL.md
* specs de sous-agent – profils de sous-agent réutilisables pour ``rlm(profile=...)``

Gardez les entrées petites et précises. Passez toujours ``evidence`` (ce qui,
dans la trajectoire, justifie l'entrée). Mettez à jour une entrée existante
plutôt que d'en créer une quasi-copie ; les identifiants sont affichés dans le
rappel système.

Exemples ::

    harness.create_memory("Textes d'interface en français", "L'interface est en français.",
                          scope="global", evidence=["tour 4 : correction de l'utilisateur"])
    harness.list("memory")
    harness.promote("mem_1a2b3c4d")      # projet -> global
"""

from __future__ import annotations

from typing import Any

from axecode_kernel import bridge

__all__ = [
    "create_prompt_note",
    "create_memory",
    "create_skill",
    "create_subagent",
    "update_prompt_note",
    "update_memory",
    "update_skill",
    "update_subagent",
    "delete_prompt_note",
    "delete_memory",
    "delete_skill",
    "delete_subagent",
    "list",
    "get",
    "promote",
    "demote",
    "archive_plan",
]

_KINDS = ("prompt_note", "memory", "skill", "subagent_spec")


def _create(kind: str, title: str, body: str, scope: str, evidence, tags, code=None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "kind": kind,
        "scope": scope,
        "entry": {
            "title": title,
            "body": body,
            "source": "agent",
            "evidence": [str(e) for e in (evidence or [])],
            "tags": [str(t) for t in (tags or [])],
        },
    }
    if code is not None:
        payload["entry"]["code"] = code
    return bridge.call("harness.create", payload)


def _update(kind: str, id: str, **fields: Any) -> dict[str, Any]:  # noqa: A002
    patch = {k: v for k, v in fields.items() if v is not None}
    return bridge.call("harness.update", {"kind": kind, "id": id, "patch": patch})


def _delete(kind: str, id: str) -> dict[str, Any]:  # noqa: A002
    return bridge.call("harness.delete", {"kind": kind, "id": id})


def create_prompt_note(title: str, body: str, scope: str = "project", evidence=None, tags=None) -> dict:
    """Crée une consigne permanente injectée à chaque tour. Renvoie l'entrée (avec son ``id``)."""
    return _create("prompt_note", title, body, scope, evidence, tags)


def create_memory(title: str, body: str, scope: str = "project", evidence=None, tags=None) -> dict:
    """Enregistre un fait durable (préférence de l'utilisateur, convention du projet, erreur passée)."""
    return _create("memory", title, body, scope, evidence, tags)


def create_skill(name: str, description: str, code: str | None = None, scope: str = "project",
                 evidence=None, tags=None) -> dict:
    """Crée un paquet de skill importable ``name`` (nom normalisé) avec SKILL.md = ``description``.

    ``code`` est le ``__init__.py`` du paquet. Utilisable tout de suite : ``import <slug>``.
    """
    return _create("skill", name, description, scope, evidence, tags, code=code)


def create_subagent(name: str, prompt: str, scope: str = "project", evidence=None, tags=None) -> dict:
    """Crée une spec de sous-agent utilisable avec ``rlm(task, profile=<id>)``."""
    return _create("subagent_spec", name, prompt, scope, evidence, tags)


def update_prompt_note(id: str, title=None, body=None, evidence=None, tags=None) -> dict:  # noqa: A002
    """Modifie une note de prompt ; les champs à ``None`` restent inchangés."""
    return _update("prompt_note", id, title=title, body=body, evidence=evidence, tags=tags)


def update_memory(id: str, title=None, body=None, evidence=None, tags=None) -> dict:  # noqa: A002
    """Modifie une mémoire ; les champs à ``None`` restent inchangés."""
    return _update("memory", id, title=title, body=body, evidence=evidence, tags=tags)


def update_skill(id: str, title=None, description=None, code=None, evidence=None, tags=None) -> dict:  # noqa: A002
    """Modifie un skill (corps de SKILL.md par ``description``, ``__init__.py`` par ``code``)."""
    return _update("skill", id, title=title, body=description, code=code, evidence=evidence, tags=tags)


def update_subagent(id: str, title=None, prompt=None, evidence=None, tags=None) -> dict:  # noqa: A002
    """Modifie une spec de sous-agent."""
    return _update("subagent_spec", id, title=title, body=prompt, evidence=evidence, tags=tags)


def delete_prompt_note(id: str) -> dict:  # noqa: A002
    """Supprime une note de prompt."""
    return _delete("prompt_note", id)


def delete_memory(id: str) -> dict:  # noqa: A002
    """Supprime une mémoire."""
    return _delete("memory", id)


def delete_skill(id: str) -> dict:  # noqa: A002
    """Supprime un skill et son paquet."""
    return _delete("skill", id)


def delete_subagent(id: str) -> dict:  # noqa: A002
    """Supprime une spec de sous-agent."""
    return _delete("subagent_spec", id)


def list(kind: str | None = None, scope: str | None = None) -> "list[dict]":  # noqa: A001
    """Liste les entrées (métadonnées + extrait). ``kind`` parmi ``prompt_note``/``memory``/``skill``/``subagent_spec``."""
    return bridge.call("harness.list", {"kind": kind, "scope": scope}) or []


def get(kind: str, id: str) -> dict | None:  # noqa: A002
    """Entrée complète (corps compris) ou ``None``."""
    return bridge.call("harness.get", {"kind": kind, "id": id})


def promote(id: str) -> dict:  # noqa: A002
    """Déplace une entrée du projet vers la portée globale."""
    return bridge.call("harness.promote", {"id": id})


def demote(id: str) -> dict:  # noqa: A002
    """Déplace une entrée globale vers la portée du projet."""
    return bridge.call("harness.demote", {"id": id})


def archive_plan(title: str, body: str, perimeter: str = "", decisions=None, status: str = "draft",
                 deviations=None) -> dict:
    """Archive un plan que vous avez produit dans le harnais du projet (ou met à jour le plan de même titre).

    Un en-tête est ajouté : date, ``perimeter``, ``status`` (``draft``/``in_progress``/``done``/``abandoned``),
    ``decisions`` et ``deviations`` (écarts entre le plan et ce qui a été construit).
    Rappelez-la avec le même titre pour mettre à jour ``status``/``deviations`` au fil du travail.
    """
    return bridge.call("harness.archive_plan", {
        "title": title,
        "body": body,
        "perimeter": perimeter,
        "decisions": [str(d) for d in (decisions or [])],
        "status": status,
        "deviations": [str(d) for d in (deviations or [])],
        "source": "agent:plan",
    })
