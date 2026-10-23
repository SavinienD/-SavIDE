"""files — read, write, edit and search files in the workspace.

Paths are relative to the workspace root (or absolute). Safety rules:
``write`` and ``edit`` refuse to overwrite an existing file that changed on
disk since you last ``read`` it (or that you never read): re-read it first.
``edit`` applies exact, ordered replacements; each ``old`` must match once
(unless ``all=True``).

``read`` also returns the text of documents: Excel ``.xlsx`` (one
``## Sheet: name`` block per sheet, tab-separated cells, computed values),
Word ``.docx`` (Markdown-like headings, lists, ``|`` tables), PDF (one
``## Page n`` block per page), PowerPoint ``.pptx`` (``## Slide n`` + notes),
OpenDocument ``.odt/.ods/.odp`` and ``.epub``. This text is read-only:
``edit`` refuses these files (generate a new file with python instead).
Other binary files raise an error instead of returning garbage.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
from typing import Iterable, Optional, Union

from axecode_kernel import bridge
from axecode_kernel import _documents  # axe:viewers

__all__ = ["read", "write", "edit", "glob", "grep", "ls", "exists", "delete", "move"]

# path -> sha256 of the content last read/written by the agent
_fingerprints: dict[str, str] = {}

MAX_READ_LINES = 2000


def _root() -> str:
    return os.path.abspath(bridge.workspace_root())


def _abs(path: Union[str, os.PathLike]) -> str:
    path = os.fspath(path)
    return os.path.abspath(path if os.path.isabs(path) else os.path.join(_root(), path))


def _rel(path: str) -> str:
    try:
        rel = os.path.relpath(path, _root())
    except ValueError:
        return path
    return path if rel.startswith("..") else rel.replace(os.sep, "/")


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read_bytes(path: str) -> Optional[bytes]:
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except FileNotFoundError:
        return None


def _decode(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):  # axe:viewers — UTF-16 with BOM
        return data.decode("utf-16")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1")


# axe:viewers — documents are read as extracted text; other binaries fail.
def _document_text(path: str, full: str, data: bytes) -> Optional[str]:
    extractor = _documents.extractor_for(full)
    if extractor is not None:
        try:
            return extractor(full)
        except ImportError:
            raise
        except Exception as err:  # noqa: BLE001 - one clear message per format
            raise ValueError(f"{path}: cannot extract the text of this document ({err})") from err
    if not _documents.looks_binary(data):
        return None
    legacy = _documents.legacy_format(full)
    if legacy:
        raise ValueError(
            f"{path} is an old {legacy} binary file: files.read cannot extract it. "
            "Convert it first (e.g. LibreOffice: soffice --headless --convert-to docx/xlsx/pptx)"
        )
    size = len(data)
    raise ValueError(
        f"{path} is a binary file ({size} bytes): files.read only returns text. "
        "Open it with open(path, 'rb') or a dedicated library"
    )


def read(path: str, offset: int = 0, limit: Optional[int] = None, numbered: bool = False) -> str:
    """Return the text of a file (optionally lines ``offset``..``offset+limit``).

    Records a fingerprint so that later ``write``/``edit`` can detect external
    changes. ``numbered=True`` prefixes each line with its 1-based number.
    Documents (xlsx, docx, pdf, pptx, odt/ods/odp, epub) return their
    extracted text; ``offset``/``limit`` then apply to that text.
    """
    full = _abs(path)
    if os.path.isdir(full):
        raise IsADirectoryError(f"{path} is a directory (use files.ls)")
    data = _read_bytes(full)
    if data is None:
        raise FileNotFoundError(f"{path}: no such file")
    _fingerprints[full] = _digest(data)
    text = _document_text(path, full, data)  # axe:viewers
    if text is None:
        text = _decode(data)
    if offset or limit is not None or numbered:
        lines = text.splitlines(keepends=True)
        end = len(lines) if limit is None else offset + limit
        chunk = lines[offset:end]
        if numbered:
            width = len(str(offset + len(chunk)))
            chunk = [f"{offset + i + 1:>{width}} | {line}" for i, line in enumerate(chunk)]
        return "".join(chunk)
    return text


def _check_fresh(full: str, current: Optional[bytes]) -> None:
    if current is None:
        return
    known = _fingerprints.get(full)
    if known is None:
        raise PermissionError(
            f"{_rel(full)} exists but was not read in this session: call files.read() first"
        )
    if known != _digest(current):
        raise PermissionError(
            f"{_rel(full)} changed on disk since it was read: call files.read() again"
        )


def _store(full: str, before: Optional[bytes], text: str) -> None:
    os.makedirs(os.path.dirname(full) or ".", exist_ok=True)
    data = text.encode("utf-8")
    with open(full, "wb") as handle:
        handle.write(data)
    _fingerprints[full] = _digest(data)
    bridge.record_file_change(_rel(full), None if before is None else _decode(before), text)


def write(path: str, content: str, force: bool = False) -> str:
    """Create or overwrite a file with ``content``.

    Overwriting requires a prior ``read`` with an unchanged file, unless
    ``force=True``. Returns a short confirmation.
    """
    full = _abs(path)
    before = _read_bytes(full)
    if _documents.extractor_for(full) and not force:  # axe:viewers
        raise ValueError(
            f"{path} is a document format: writing plain text would corrupt it. "
            "Build it with python (openpyxl, python-docx, ...) or pass force=True"
        )
    if not force:
        _check_fresh(full, before)
    _store(full, before, content)
    lines = content.count("\n") + (0 if content.endswith("\n") or not content else 1)
    return f"{'updated' if before is not None else 'created'} {_rel(full)} ({lines} lines)"


def edit(path: str, edits: Union[list, tuple], force: bool = False) -> str:
    """Apply ordered exact replacements to a file.

    ``edits`` is a list of ``(old, new)`` pairs or dicts
    ``{"old": ..., "new": ..., "all": False}``. Each ``old`` must occur exactly
    once at the time it is applied (or at least once with ``all=True``).
    The whole edit is atomic: nothing is written if one replacement fails.
    """
    full = _abs(path)
    before = _read_bytes(full)
    if before is None:
        raise FileNotFoundError(f"{path}: no such file (use files.write to create it)")
    if _documents.extractor_for(full) or _documents.looks_binary(before):  # axe:viewers
        raise ValueError(
            f"{path} is a binary document: edit cannot change it. Generate a new "
            "file with python (openpyxl, python-docx, ...) and files.write/shell instead"
        )
    if not force:
        _check_fresh(full, before)
    text = _decode(before)
    crlf = "\r\n" in text
    applied = 0
    for index, item in enumerate(edits):
        if isinstance(item, dict):
            old, new, replace_all = item.get("old", ""), item.get("new", ""), bool(item.get("all"))
        else:
            old, new = item[0], item[1]
            replace_all = bool(item[2]) if len(item) > 2 else False
        if not old:
            raise ValueError(f"edit #{index + 1}: empty `old`")
        if crlf and "\r\n" not in old and old not in text:
            old, new = old.replace("\n", "\r\n"), new.replace("\n", "\r\n")
        count = text.count(old)
        if count == 0:
            raise ValueError(f"edit #{index + 1}: `old` not found in {path}")
        if count > 1 and not replace_all:
            raise ValueError(
                f"edit #{index + 1}: `old` matches {count} times in {path}; add context or pass all=True"
            )
        text = text.replace(old, new) if replace_all else text.replace(old, new, 1)
        applied += count if replace_all else 1
    _store(full, before, text)
    return f"edited {_rel(full)} ({applied} replacement{'s' if applied != 1 else ''})"


_IGNORED_DIRS = {".git", "node_modules", "target", "dist", "__pycache__", ".venv", "venv"}


def _walk(base: str) -> Iterable[str]:
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in _IGNORED_DIRS]
        for name in files:
            yield os.path.join(root, name)


def glob(pattern: str, path: str = ".", limit: int = 500) -> list[str]:
    """List files matching a glob ``pattern`` (``**`` supported), newest first.

    Skips .git, node_modules, target, dist and virtualenvs.
    """
    base = _abs(path)
    simple = "/" not in pattern
    tail = pattern[3:] if pattern.startswith("**/") else None
    hits = []
    for full in _walk(base):
        rel = os.path.relpath(full, base).replace(os.sep, "/")
        name = os.path.basename(full)
        if (
            (simple and fnmatch.fnmatch(name, pattern))
            or (not simple and fnmatch.fnmatch(rel, pattern))
            or (tail is not None and (fnmatch.fnmatch(rel, tail) or fnmatch.fnmatch(name, tail)))
        ):
            hits.append(full)
    hits.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return [_rel(p) for p in hits[:limit]]


def _rg() -> Optional[str]:
    explicit = os.environ.get("AXECODE_RG")
    if explicit and os.path.exists(explicit):
        return explicit
    return shutil.which("rg")


def grep(
    pattern: str,
    path: str = ".",
    glob: Optional[str] = None,
    ignore_case: bool = False,
    literal: bool = False,
    context: int = 0,
    limit: int = 200,
) -> list[dict]:
    """Search file contents with a regex (ripgrep when available).

    Returns ``[{"path", "line", "text"}]`` (context lines have ``"context": True``).
    """
    base = _abs(path)
    rg = _rg()
    results: list[dict] = []
    if rg:
        args = [rg, "--json", "-n"]
        if ignore_case:
            args.append("-i")
        if literal:
            args.append("-F")
        if context:
            args += ["-C", str(context)]
        if glob:
            args += ["-g", glob]
        args += ["-e", pattern, base]
        proc = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace",
                              stdin=subprocess.DEVNULL)
        for raw in proc.stdout.splitlines():
            try:
                event = json.loads(raw)
            except ValueError:
                continue
            if event.get("type") not in ("match", "context"):
                continue
            data = event["data"]
            results.append({
                "path": _rel(data["path"].get("text", "")),
                "line": data.get("line_number"),
                "text": (data["lines"].get("text") or "").rstrip("\r\n"),
                **({"context": True} if event["type"] == "context" else {}),
            })
            if len(results) >= limit:
                break
        return results
    flags = re.IGNORECASE if ignore_case else 0
    regex = re.compile(re.escape(pattern) if literal else pattern, flags)
    for full in _walk(base):
        if glob and not fnmatch.fnmatch(os.path.basename(full), glob) and not fnmatch.fnmatch(_rel(full), glob):
            continue
        try:
            with open(full, "r", encoding="utf-8", errors="strict") as handle:
                lines = handle.read().splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(lines, 1):
            if regex.search(line):
                results.append({"path": _rel(full), "line": number, "text": line})
                if len(results) >= limit:
                    return results
    return results


def ls(path: str = ".") -> list[str]:
    """List a directory (directories end with ``/``)."""
    full = _abs(path)
    entries = []
    for name in sorted(os.listdir(full)):
        entries.append(name + "/" if os.path.isdir(os.path.join(full, name)) else name)
    return entries


def exists(path: str) -> bool:
    """True if the path exists."""
    return os.path.exists(_abs(path))


def delete(path: str) -> str:
    """Delete a file (directories are refused; use shell for that)."""
    full = _abs(path)
    if os.path.isdir(full):
        raise IsADirectoryError(f"{path} is a directory")
    before = _read_bytes(full)
    os.remove(full)
    _fingerprints.pop(full, None)
    bridge.record_file_change(_rel(full), None if before is None else _decode(before), None)
    return f"deleted {_rel(full)}"


def move(src: str, dst: str) -> str:
    """Rename or move a file or directory."""
    source, target = _abs(src), _abs(dst)
    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    shutil.move(source, target)
    if source in _fingerprints:
        _fingerprints[target] = _fingerprints.pop(source)
    return f"moved {_rel(source)} -> {_rel(target)}"
