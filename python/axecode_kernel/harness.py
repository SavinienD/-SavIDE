"""harness — your continual harness (persistent memory across sessions).

Four kinds of entries, each in two scopes (``"global"`` follows the user
everywhere, ``"project"`` lives in ``<workspace>/.axecode/harness``):

* prompt notes  – standing instructions injected every turn
* memories      – facts learned about the user / project, injected every turn
* skills        – importable Python packages (``import <skill_name>``) + SKILL.md
* subagent specs – reusable sub-agent profiles for ``rlm(profile=...)``

Keep entries small and specific. Always pass ``evidence`` (what in the
trajectory justifies the entry). Prefer updating an existing entry over
creating a near-duplicate; ids are shown in the system reminder.

Examples::

    harness.create_memory("User prefers French UI strings", "UI text is in French.",
                          scope="global", evidence=["turn 4: user correction"])
    harness.list("memory")
    harness.promote("mem_1a2b3c4d")      # project -> global
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
    """Create a standing instruction injected every turn. Returns the entry (with ``id``)."""
    return _create("prompt_note", title, body, scope, evidence, tags)


def create_memory(title: str, body: str, scope: str = "project", evidence=None, tags=None) -> dict:
    """Record a durable fact (user preference, project convention, past mistake)."""
    return _create("memory", title, body, scope, evidence, tags)


def create_skill(name: str, description: str, code: str | None = None, scope: str = "project",
                 evidence=None, tags=None) -> dict:
    """Create an importable skill package ``name`` (slugified) with SKILL.md = ``description``.

    ``code`` is the package ``__init__.py``. Usable immediately: ``import <slug>``.
    """
    return _create("skill", name, description, scope, evidence, tags, code=code)


def create_subagent(name: str, prompt: str, scope: str = "project", evidence=None, tags=None) -> dict:
    """Create a sub-agent spec usable with ``rlm(task, profile=<id>)``."""
    return _create("subagent_spec", name, prompt, scope, evidence, tags)


def update_prompt_note(id: str, title=None, body=None, evidence=None, tags=None) -> dict:  # noqa: A002
    """Patch a prompt note; ``None`` fields are left untouched."""
    return _update("prompt_note", id, title=title, body=body, evidence=evidence, tags=tags)


def update_memory(id: str, title=None, body=None, evidence=None, tags=None) -> dict:  # noqa: A002
    """Patch a memory; ``None`` fields are left untouched."""
    return _update("memory", id, title=title, body=body, evidence=evidence, tags=tags)


def update_skill(id: str, title=None, description=None, code=None, evidence=None, tags=None) -> dict:  # noqa: A002
    """Patch a skill (SKILL.md body via ``description``, ``__init__.py`` via ``code``)."""
    return _update("skill", id, title=title, body=description, code=code, evidence=evidence, tags=tags)


def update_subagent(id: str, title=None, prompt=None, evidence=None, tags=None) -> dict:  # noqa: A002
    """Patch a sub-agent spec."""
    return _update("subagent_spec", id, title=title, body=prompt, evidence=evidence, tags=tags)


def delete_prompt_note(id: str) -> dict:  # noqa: A002
    """Delete a prompt note."""
    return _delete("prompt_note", id)


def delete_memory(id: str) -> dict:  # noqa: A002
    """Delete a memory."""
    return _delete("memory", id)


def delete_skill(id: str) -> dict:  # noqa: A002
    """Delete a skill and its package."""
    return _delete("skill", id)


def delete_subagent(id: str) -> dict:  # noqa: A002
    """Delete a sub-agent spec."""
    return _delete("subagent_spec", id)


def list(kind: str | None = None, scope: str | None = None) -> "list[dict]":  # noqa: A001
    """List entries (metadata + excerpt). ``kind`` in prompt_note/memory/skill/subagent_spec."""
    return bridge.call("harness.list", {"kind": kind, "scope": scope}) or []


def get(kind: str, id: str) -> dict | None:  # noqa: A002
    """Full entry (body included) or ``None``."""
    return bridge.call("harness.get", {"kind": kind, "id": id})


def promote(id: str) -> dict:  # noqa: A002
    """Move a project entry to the global scope."""
    return bridge.call("harness.promote", {"id": id})


def demote(id: str) -> dict:  # noqa: A002
    """Move a global entry to the project scope."""
    return bridge.call("harness.demote", {"id": id})


def archive_plan(title: str, body: str, perimeter: str = "", decisions=None, status: str = "draft",
                 deviations=None) -> dict:
    """Archive a plan you produced in the project harness (or update the plan with the same title).

    A header is added: date, ``perimeter``, ``status`` (draft/in_progress/done/abandoned),
    ``decisions`` and ``deviations`` (gaps between the plan and what was built).
    Call it again with the same title to update status/deviations as work progresses.
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
