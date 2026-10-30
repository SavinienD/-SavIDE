"""cua : piloter le bureau de ce poste (capture, clic, frappe, fenetres) via cua-driver.

A utiliser UNIQUEMENT quand l'utilisateur le demande explicitement.
"""
import os, subprocess, sys
from pathlib import Path

__all__ = ["run", "snapshot", "click", "type_text", "windows"]

def _binaire():
    if os.environ.get("CUA_DRIVER_BIN"):
        return os.environ["CUA_DRIVER_BIN"]
    nom = "cua-driver.exe" if sys.platform == "win32" else "cua-driver"
    for base in Path(__file__).resolve().parents[:4]:
        p = base / "cua-driver" / nom
        if p.is_file():
            return str(p)
    return "cua-driver"

def run(*args, timeout=60):
    """Lance `cua-driver <args>` et renvoie sa sortie (erreur levee si echec)."""
    r = subprocess.run([_binaire(), *args], capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL, creationflags=0x08000000 if os.name == "nt" else 0)
    out = r.stdout + (("\n[stderr] " + r.stderr.strip()) if r.stderr.strip() else "")
    if r.returncode:
        raise RuntimeError(out.strip() or f"cua-driver code {r.returncode}")
    return out

def snapshot():
    """Capture de l'ecran et arbre d'accessibilite."""
    return run("snapshot")

def click(x, y):
    """Clic aux coordonnees (x, y)."""
    return run("click", "--x", str(x), "--y", str(y))

def type_text(text):
    """Frappe du texte au clavier."""
    return run("type", text)

def windows():
    """Liste des fenetres."""
    return run("list-windows")
