"""bridge — le canal du noyau vers l'hôte Rust (interne).

Protocole (JSON, une ligne par message). Le noyau écrit sur une copie privée
du descripteur stdout d'origine ; le vrai fd 1 est redirigé vers stderr pour
que les affichages parasites des processus enfants ne puissent jamais
corrompre le protocole.

noyau → hôte ::

    {"type": "host_call", "call_id": "...", "method": "files.x", "params": {...}}
    {"type": "stream", "id": exec_id, "name": "stdout"|"stderr", "text": "..."}
    {"type": "done", "id": exec_id, ...}            # voir __main__.py

hôte → noyau ::

    {"type": "host_result", "call_id": "...", "ok": true, "result": ...}
    {"type": "host_result", "call_id": "...", "ok": false, "error": "..."}

``call(method, params)`` bloque le fil appelant jusqu'à la réponse de l'hôte.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import uuid
from typing import Any, Optional

__all__ = ["call", "HostError", "emit", "emit_image", "current_exec_id"]


class HostError(RuntimeError):
    """Levée quand l'hôte signale une erreur pour un ``call``."""


_write_lock = threading.Lock()
_out = None  # protocol stream, set by ``install``
_pending: dict[str, dict[str, Any]] = {}
_pending_lock = threading.Lock()
_exec_state = threading.local()
_images: list[dict[str, Any]] = []
_file_changes: list[dict[str, Any]] = []
_standalone = False


def install(stream) -> None:
    """Fixe le flux de sortie du protocole (appelé par ``__main__``)."""
    global _out
    _out = stream


def standalone() -> bool:
    """Vrai quand le paquet est utilisé hors d'un noyau (tests, Python seul)."""
    return _out is None


def emit(message: dict[str, Any]) -> None:
    """Écrit une ligne du protocole."""
    if _out is None:
        return
    line = json.dumps(message, ensure_ascii=False, default=str)
    with _write_lock:
        _out.write(line + "\n")
        _out.flush()


def current_exec_id() -> Optional[str]:
    return getattr(_exec_state, "exec_id", None) or _main_exec_id


_main_exec_id: Optional[str] = None


def set_exec_id(exec_id: Optional[str]) -> None:
    global _main_exec_id
    _main_exec_id = exec_id


def call(method: str, params: Optional[dict[str, Any]] = None, timeout: Optional[float] = None) -> Any:
    """Appelle une méthode de l'hôte (Rust) et attend son résultat."""
    if _out is None:
        raise HostError(f"{method} : aucun hôte relié (noyau autonome)")
    call_id = uuid.uuid4().hex
    slot: dict[str, Any] = {"event": threading.Event()}
    with _pending_lock:
        _pending[call_id] = slot
    emit({
        "type": "host_call",
        "call_id": call_id,
        "exec_id": current_exec_id(),
        "method": method,
        "params": params or {},
    })
    if not slot["event"].wait(timeout):
        with _pending_lock:
            _pending.pop(call_id, None)
        raise HostError(f"{method} : délai dépassé pour l'appel à l'hôte")
    if not slot.get("ok"):
        raise HostError(f"{method} : {slot.get('error') or 'erreur de l’hôte'}")
    return slot.get("result")


def resolve(message: dict[str, Any]) -> None:
    """Remet une ligne ``host_result`` à l'appelant qui attend (fil de lecture)."""
    with _pending_lock:
        slot = _pending.pop(str(message.get("call_id")), None)
    if slot is None:
        return
    slot["ok"] = bool(message.get("ok"))
    slot["result"] = message.get("result")
    slot["error"] = message.get("error")
    slot["event"].set()


def fail_all(reason: str) -> None:
    with _pending_lock:
        slots = list(_pending.values())
        _pending.clear()
    for slot in slots:
        slot["ok"] = False
        slot["error"] = reason
        slot["event"].set()


def emit_image(media_type: str, data_b64: str, path: Optional[str] = None) -> None:
    """Joint une image au résultat de l'exécution en cours."""
    _images.append({"mediaType": media_type, "data": data_b64, "path": path})


def record_file_change(path: str, before: Optional[str], after: Optional[str]) -> None:
    """Signale la modification d'un fichier (affichée en carte de différences par l'IDE)."""
    _file_changes.append({"path": path, "before": before, "after": after})
    emit({"type": "file_change", "id": current_exec_id(), "path": path,
          "before": before, "after": after})


def take_attachments() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    images = list(_images)
    changes = list(_file_changes)
    _images.clear()
    _file_changes.clear()
    return images, changes


def workspace_root() -> str:
    """Racine du dossier de travail de la session (dossier courant du noyau par défaut)."""
    return os.environ.get("AXECODE_WORKSPACE") or os.getcwd()
