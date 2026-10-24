"""Environnement du noyau, préparé à chaque (re)démarrage (interne).

- ``refresh_user_environment`` : relit l'environnement utilisateur courant
  (registre ``HKCU\Environment`` et variables système sous Windows), pour qu'une
  variable créée après le lancement de l'appli (``setx``, réglages Windows)
  soit vue par le noyau et survive à son redémarrage.
- ``setup_ssl`` : certificats racine de ``certifi`` pour le Python embarqué
  (sinon urllib échoue avec CERTIFICATE_VERIFY_FAILED).
- ``prepend_python`` : le Python du noyau en tête du PATH, pour que ``python``
  et ``pip`` lancés depuis le module shell visent ce même interpréteur.
"""

from __future__ import annotations

import os
import sys
from typing import Callable, Iterable, Optional

IS_WINDOWS = sys.platform == "win32"
# Fixées par l'hôte au lancement : jamais remplacées par le registre.
_ALWAYS_PROTECTED = ("PYTHONPATH", "PYTHONHOME", "PYTHONIOENCODING", "PYTHONUTF8")


def _protected() -> set[str]:
    names = {n.upper() for n in _ALWAYS_PROTECTED}
    names.update(n.strip().upper() for n in os.environ.get("AXECODE_PROTECTED_ENV", "").split(",") if n.strip())
    return names


def _read_registry() -> list[tuple[str, dict[str, str]]]:
    """[(portée, {nom: valeur})] : système puis utilisateur (l'utilisateur l'emporte)."""
    import winreg

    sources = [
        (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment", "machine"),
        (winreg.HKEY_CURRENT_USER, "Environment", "user"),
    ]
    out = []
    for root, key_path, scope in sources:
        values: dict[str, str] = {}
        try:
            with winreg.OpenKey(root, key_path) as key:
                index = 0
                while True:
                    try:
                        name, value, kind = winreg.EnumValue(key, index)
                    except OSError:
                        break
                    index += 1
                    if not isinstance(value, str):
                        continue
                    if kind == winreg.REG_EXPAND_SZ:
                        value = os.path.expandvars(value)
                    values[name] = value
        except OSError:
            pass
        out.append((scope, values))
    return out


def _split(path: str) -> list[str]:
    return [p for p in path.split(os.pathsep) if p]


def refresh_user_environment(reader: Optional[Callable[[], Iterable[tuple[str, dict[str, str]]]]] = None,
                             environ=None) -> list[str]:
    """Applique l'environnement utilisateur courant à ``environ`` ; renvoie les noms changés.

    PATH = PATH système + PATH utilisateur, puis les entrées du PATH hérité
    qui n'y sont pas (celles que l'appli a ajoutées)."""
    environ = os.environ if environ is None else environ
    if reader is None:
        if not IS_WINDOWS:
            return []
        reader = _read_registry
    try:
        scopes = list(reader())
    except Exception:
        return []
    protected = _protected()
    merged: dict[str, str] = {}
    paths: list[str] = []
    for _scope, values in scopes:
        for name, value in values.items():
            if name.upper() == "PATH":
                paths.extend(_split(value))
            else:
                merged[name] = value
    changed = []
    for name, value in merged.items():
        upper = name.upper()
        if upper in protected or upper.startswith("AXECODE_"):
            continue
        if environ.get(name) != value:
            environ[name] = value
            changed.append(name)
    if paths:
        seen = {os.path.normcase(p) for p in paths}
        extra = [p for p in _split(environ.get("PATH", "")) if os.path.normcase(p) not in seen]
        new_path = os.pathsep.join(paths + extra)
        if environ.get("PATH") != new_path:
            environ["PATH"] = new_path
            changed.append("PATH")
    return changed


def setup_ssl(environ=None) -> Optional[str]:
    """Règle SSL_CERT_FILE sur le paquet certifi s'il n'est pas déjà valide."""
    environ = os.environ if environ is None else environ
    current = environ.get("SSL_CERT_FILE")
    if current and os.path.isfile(current):
        return current
    try:
        import certifi
    except Exception:
        return None
    path = certifi.where()
    if not os.path.isfile(path):
        return None
    environ["SSL_CERT_FILE"] = path
    environ.setdefault("REQUESTS_CA_BUNDLE", path)
    return path


def python_dirs(executable: Optional[str] = None) -> list[str]:
    """Dossiers à mettre en tête du PATH : celui de l'interpréteur (et Scripts sous Windows)."""
    executable = os.path.abspath(executable or sys.executable)
    base = os.path.dirname(executable)
    dirs = [base]
    if IS_WINDOWS:
        dirs.append(os.path.join(base, "Scripts"))
    return dirs


def prepend_python(environ=None, executable: Optional[str] = None) -> str:
    """Met le Python du noyau (python, pip) en tête du PATH ; renvoie le nouveau PATH."""
    environ = os.environ if environ is None else environ
    first = python_dirs(executable)
    keys = {os.path.normcase(os.path.normpath(p)) for p in first}
    rest = [p for p in _split(environ.get("PATH", "")) if os.path.normcase(os.path.normpath(p)) not in keys]
    environ["PATH"] = os.pathsep.join(first + rest)
    return environ["PATH"]


def prepare() -> None:
    """Appelé au démarrage du noyau, dans cet ordre."""
    refresh_user_environment()
    setup_ssl()
    prepend_python()
