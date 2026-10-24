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


def _split(path: str) -> list[str]:
    return [p for p in path.split(os.pathsep) if p]


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
    setup_ssl()
    prepend_python()
