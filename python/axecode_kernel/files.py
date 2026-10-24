"""files — lire, écrire, modifier et chercher des fichiers dans le dossier de travail.

Les chemins sont relatifs à la racine du dossier de travail (ou absolus).
Règles de sécurité : ``write`` et ``edit`` refusent d'écraser un fichier
existant modifié sur le disque depuis votre dernier ``read`` (ou jamais lu) :
relisez-le d'abord. ``edit`` applique des remplacements exacts, dans l'ordre ;
chaque ``old`` doit apparaître une seule fois (sauf avec ``all=True``).

``read`` renvoie aussi le texte des documents : Excel ``.xlsx`` (un bloc
``## Feuille : nom`` par feuille, cellules séparées par des tabulations,
valeurs calculées), Word ``.docx`` (titres façon Markdown, listes, tableaux
``|``), PDF (un bloc ``## Page n`` par page), PowerPoint ``.pptx``
(``## Diapositive n`` + notes), OpenDocument ``.odt/.ods/.odp`` et ``.epub``.
Ce texte est en lecture seule : ``edit`` refuse ces fichiers (générez plutôt
un nouveau fichier avec Python). Les autres fichiers binaires lèvent une
erreur au lieu de renvoyer du charabia.
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
            raise ValueError(f"{path} : impossible d'extraire le texte de ce document ({err})") from err
    if not _documents.looks_binary(data):
        return None
    legacy = _documents.legacy_format(full)
    if legacy:
        raise ValueError(
            f"{path} est un ancien fichier binaire {legacy} : files.read ne sait pas l'extraire. "
            "Convertissez-le d'abord (par ex. LibreOffice : soffice --headless --convert-to docx/xlsx/pptx)"
        )
    size = len(data)
    raise ValueError(
        f"{path} est un fichier binaire ({size} octets) : files.read ne renvoie que du texte. "
        "Ouvrez-le avec open(path, 'rb') ou une bibliothèque dédiée"
    )


def read(path: str, offset: int = 0, limit: Optional[int] = None, numbered: bool = False) -> str:
    """Renvoie le texte d'un fichier (si besoin les lignes ``offset``..``offset+limit``).

    Enregistre une empreinte pour que ``write``/``edit`` détectent ensuite les
    modifications extérieures. ``numbered=True`` préfixe chaque ligne de son
    numéro (à partir de 1). Les documents (xlsx, docx, pdf, pptx, odt/ods/odp,
    epub) renvoient leur texte extrait ; ``offset``/``limit`` s'appliquent alors
    à ce texte.
    """
    full = _abs(path)
    if os.path.isdir(full):
        raise IsADirectoryError(f"{path} est un dossier (utilisez files.ls)")
    data = _read_bytes(full)
    if data is None:
        raise FileNotFoundError(f"{path} : fichier introuvable")
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
            f"{_rel(full)} existe mais n'a pas été lu dans cette session : appelez d'abord files.read()"
        )
    if known != _digest(current):
        raise PermissionError(
            f"{_rel(full)} a changé sur le disque depuis sa lecture : rappelez files.read()"
        )


def _store(full: str, before: Optional[bytes], text: str) -> None:
    os.makedirs(os.path.dirname(full) or ".", exist_ok=True)
    data = text.encode("utf-8")
    with open(full, "wb") as handle:
        handle.write(data)
    _fingerprints[full] = _digest(data)
    bridge.record_file_change(_rel(full), None if before is None else _decode(before), text)


def write(path: str, content: str, force: bool = False) -> str:
    """Crée ou écrase un fichier avec ``content``.

    Pour écraser, il faut un ``read`` préalable et un fichier inchangé depuis,
    sauf avec ``force=True``. Renvoie une courte confirmation.
    """
    full = _abs(path)
    before = _read_bytes(full)
    if _documents.extractor_for(full) and not force:  # axe:viewers
        raise ValueError(
            f"{path} est un format de document : y écrire du texte brut le corromprait. "
            "Construisez-le avec Python (openpyxl, python-docx…) ou passez force=True"
        )
    if not force:
        _check_fresh(full, before)
    _store(full, before, content)
    lines = content.count("\n") + (0 if content.endswith("\n") or not content else 1)
    return f"{_rel(full)} {'mis à jour' if before is not None else 'créé'} ({lines} ligne{'s' if lines > 1 else ''})"


def edit(path: str, edits: Union[list, tuple], force: bool = False) -> str:
    """Applique à un fichier des remplacements exacts, dans l'ordre.

    ``edits`` est une liste de paires ``(old, new)`` ou de dicts
    ``{"old": ..., "new": ..., "all": False}``. Chaque ``old`` doit apparaître
    exactement une fois au moment où il est appliqué (au moins une fois avec
    ``all=True``). La modification est atomique : rien n'est écrit si un
    remplacement échoue.
    """
    full = _abs(path)
    before = _read_bytes(full)
    if before is None:
        raise FileNotFoundError(f"{path} : fichier introuvable (utilisez files.write pour le créer)")
    if _documents.extractor_for(full) or _documents.looks_binary(before):  # axe:viewers
        raise ValueError(
            f"{path} est un document binaire : edit ne peut pas le modifier. Générez plutôt un "
            "nouveau fichier avec Python (openpyxl, python-docx…) et files.write/shell"
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
            raise ValueError(f"modification n° {index + 1} : `old` est vide")
        if crlf and "\r\n" not in old and old not in text:
            old, new = old.replace("\n", "\r\n"), new.replace("\n", "\r\n")
        count = text.count(old)
        if count == 0:
            raise ValueError(f"modification n° {index + 1} : `old` introuvable dans {path}")
        if count > 1 and not replace_all:
            raise ValueError(
                f"modification n° {index + 1} : `old` apparaît {count} fois dans {path} ; ajoutez du contexte ou passez all=True"
            )
        text = text.replace(old, new) if replace_all else text.replace(old, new, 1)
        applied += count if replace_all else 1
    _store(full, before, text)
    return f"{_rel(full)} modifié ({applied} remplacement{'s' if applied > 1 else ''})"


_IGNORED_DIRS = {".git", "node_modules", "target", "dist", "__pycache__", ".venv", "venv"}


def _walk(base: str) -> Iterable[str]:
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in _IGNORED_DIRS]
        for name in files:
            yield os.path.join(root, name)


def glob(pattern: str, path: str = ".", limit: int = 500) -> list[str]:
    """Liste les fichiers qui correspondent au motif glob ``pattern`` (``**`` accepté), les plus récents d'abord.

    Ignore .git, node_modules, target, dist et les environnements virtuels.
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
    """Cherche une expression régulière dans le contenu des fichiers (avec ripgrep s'il est présent).

    Renvoie ``[{"path", "line", "text"}]`` (les lignes de contexte ont ``"context": True``).
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
    """Liste un dossier (les sous-dossiers finissent par ``/``)."""
    full = _abs(path)
    entries = []
    for name in sorted(os.listdir(full)):
        entries.append(name + "/" if os.path.isdir(os.path.join(full, name)) else name)
    return entries


def exists(path: str) -> bool:
    """Vrai si le chemin existe."""
    return os.path.exists(_abs(path))


def delete(path: str) -> str:
    """Supprime un fichier (les dossiers sont refusés : utilisez shell pour cela)."""
    full = _abs(path)
    if os.path.isdir(full):
        raise IsADirectoryError(f"{path} est un dossier")
    before = _read_bytes(full)
    os.remove(full)
    _fingerprints.pop(full, None)
    bridge.record_file_change(_rel(full), None if before is None else _decode(before), None)
    return f"{_rel(full)} supprimé"


def move(src: str, dst: str) -> str:
    """Renomme ou déplace un fichier ou un dossier."""
    source, target = _abs(src), _abs(dst)
    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    shutil.move(source, target)
    if source in _fingerprints:
        _fingerprints[target] = _fingerprints.pop(source)
    return f"{_rel(source)} déplacé vers {_rel(target)}"
