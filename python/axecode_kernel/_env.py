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


def prepare() -> None:
    """Appelé au démarrage du noyau."""
    setup_ssl()
