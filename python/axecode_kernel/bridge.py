"""bridge — the kernel's channel to the Rust host (internal).

Protocol (JSON-lines). The kernel writes on a private copy of the original
stdout file descriptor; the real fd 1 is redirected to stderr so that stray
prints from child processes can never corrupt the protocol.

kernel → host::

    {"type": "host_call", "call_id": "...", "method": "files.x", "params": {...}}
    {"type": "stream", "id": exec_id, "name": "stdout"|"stderr", "text": "..."}
    {"type": "done", "id": exec_id, ...}            # see __main__.py

host → kernel::

    {"type": "host_result", "call_id": "...", "ok": true, "result": ...}
    {"type": "host_result", "call_id": "...", "ok": false, "error": "..."}

``call(method, params)`` blocks the calling thread until the host replies.
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
    """Raised when the host reports an error for a ``call``."""


_write_lock = threading.Lock()
_out = None  # protocol stream, set by ``install``
_pending: dict[str, dict[str, Any]] = {}
_pending_lock = threading.Lock()
_exec_state = threading.local()
_images: list[dict[str, Any]] = []
_file_changes: list[dict[str, Any]] = []
_standalone = False


def install(stream) -> None:
    """Sets the protocol output stream (called by ``__main__``)."""
    global _out
    _out = stream


def standalone() -> bool:
    """True when the package is used outside a kernel (tests, plain python)."""
    return _out is None


def emit(message: dict[str, Any]) -> None:
    """Writes one protocol line."""
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
    """Calls a host (Rust) method and waits for its result."""
    if _out is None:
        raise HostError(f"{method}: no host attached (standalone kernel)")
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
        raise HostError(f"{method}: host call timed out")
    if not slot.get("ok"):
        raise HostError(f"{method}: {slot.get('error') or 'host error'}")
    return slot.get("result")


def resolve(message: dict[str, Any]) -> None:
    """Delivers a ``host_result`` line to the waiting caller (reader thread)."""
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
    """Attaches an image to the result of the current execution."""
    _images.append({"mediaType": media_type, "data": data_b64, "path": path})


def record_file_change(path: str, before: Optional[str], after: Optional[str]) -> None:
    """Reports a file modification (shown as a diff card by the IDE)."""
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
    """Workspace root of the session (cwd of the kernel by default)."""
    return os.environ.get("AXECODE_WORKSPACE") or os.getcwd()
