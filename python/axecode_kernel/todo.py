"""todo — la liste des tâches montrée à l'utilisateur et réinjectée à chaque tour.

``set(["étape 1", "étape 2"])`` remplace la liste (tout en attente) ;
``start(i)`` / ``done(i)`` mettent à jour une tâche par indice (à partir de 0)
ou par texte ; ``add(text)``, ``clear()`` et ``get()`` complètent l'API.
Gardez exactement une tâche en cours pendant le travail.
"""

from __future__ import annotations

from typing import Iterable, Union

from axecode_kernel import bridge

__all__ = ["get", "set", "add", "start", "done", "clear"]

_state: dict = {"active": False, "tasks": []}


def _push() -> dict:
    global _state
    try:
        _state = bridge.call("todo.set", _state)
    except bridge.HostError:
        if not bridge.standalone():
            raise
    return _state


def get() -> list[dict]:
    """Tâches actuelles : ``[{"id", "text", "status"}]``."""
    global _state
    if not bridge.standalone():
        try:
            _state = bridge.call("todo.get") or _state
        except bridge.HostError:
            pass
    return list(_state.get("tasks", []))


def set(tasks: Iterable[str]) -> list[dict]:  # noqa: A001 - module API
    """Remplace la liste par de nouvelles tâches en attente."""
    _state["tasks"] = [{"id": str(i + 1), "text": str(t), "status": "pending"} for i, t in enumerate(tasks)]
    _state["active"] = bool(_state["tasks"])
    return _push().get("tasks", [])


def add(text: str) -> list[dict]:
    """Ajoute une tâche en attente."""
    tasks = get()
    tasks.append({"id": str(len(tasks) + 1), "text": text, "status": "pending"})
    _state["tasks"], _state["active"] = tasks, True
    return _push().get("tasks", [])


def _find(ref: Union[int, str], tasks: list[dict]) -> dict:
    if isinstance(ref, int):
        return tasks[ref]
    for task in tasks:
        if task.get("id") == ref or ref.lower() in str(task.get("text", "")).lower():
            return task
    raise KeyError(f"aucune tâche ne correspond à {ref!r}")


def _status(ref: Union[int, str], status: str) -> list[dict]:
    tasks = get()
    _find(ref, tasks)["status"] = status
    _state["tasks"] = tasks
    _state["active"] = any(t["status"] != "done" for t in tasks)
    return _push().get("tasks", [])


def start(ref: Union[int, str]) -> list[dict]:
    """Marque une tâche en cours (par indice ou par texte)."""
    return _status(ref, "in_progress")


def done(ref: Union[int, str]) -> list[dict]:
    """Marque une tâche terminée (par indice ou par texte)."""
    return _status(ref, "done")


def clear() -> list[dict]:
    """Supprime toutes les tâches."""
    _state["tasks"], _state["active"] = [], False
    return _push().get("tasks", [])
