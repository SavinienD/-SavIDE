"""cua : piloter le bureau de ce poste (capture, clic, frappe, fenetres) via cua-driver.

A utiliser UNIQUEMENT quand l'utilisateur le demande explicitement.
Syntaxe de cua-driver 0.59 : run("call", "<outil>", '<json>') ; liste des outils : run("list-tools") ;
detail d'un outil : run("describe", "<outil>"). Le demon (cua-driver serve) est lance tout seul si besoin.
"""
import json, os, subprocess, sys, time
from pathlib import Path

__all__ = ["run", "call", "snapshot", "click", "type_text", "windows"]

_SANS_FENETRE = 0x08000000 if os.name == "nt" else 0

def _binaire():
    if os.environ.get("CUA_DRIVER_BIN"):
        return os.environ["CUA_DRIVER_BIN"]
    nom = "cua-driver.exe" if sys.platform == "win32" else "cua-driver"
    for base in Path(__file__).resolve().parents[:4]:
        p = base / "cua-driver" / nom
        if p.is_file():
            return str(p)
    return "cua-driver"

def _lancer(args, timeout):
    r = subprocess.run([_binaire(), *args], capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL, creationflags=_SANS_FENETRE)
    return r.returncode, r.stdout + (("\n[stderr] " + r.stderr.strip()) if r.stderr.strip() else "")

def _demarrer_demon():
    """Lance `cua-driver serve` en arriere-plan et attend que `status` reponde (10 s au plus)."""
    subprocess.Popen([_binaire(), "serve"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=_SANS_FENETRE, start_new_session=os.name != "nt")
    for _ in range(40):
        time.sleep(0.25)
        try:
            if _lancer(["status"], 5)[0] == 0:
                return True
        except subprocess.TimeoutExpired:
            pass
    return False

def run(*args, timeout=60):
    """Lance `cua-driver <args>` et renvoie sa sortie (erreur levee si echec)."""
    args = [str(a) for a in args]
    code, out = _lancer(args, timeout)
    if code and "daemon is not running" in out and args[:1] != ["serve"] and _demarrer_demon():
        code, out = _lancer(args, timeout)
    if code:
        raise RuntimeError(out.strip() or f"cua-driver code {code}")
    return out

def call(outil, **params):
    """Appelle un outil de cua-driver (voir run("list-tools")) avec ses parametres JSON."""
    return run("call", outil, json.dumps(params)) if params else run("call", outil)

def snapshot(fichier=None):
    """Capture de tout l'ecran (get_desktop_state) ; `fichier` : chemin PNG ou ecrire l'image."""
    return run("call", "get_desktop_state", *(["--screenshot-out-file", str(fichier)] if fichier else []))

def click(x, y, window_id=None, pid=None):
    """Clic en (x, y), pixels DANS la fenetre `window_id` (voir windows())."""
    p = {"x": x, "y": y}
    if window_id is not None:
        p["window_id"] = window_id
    if pid is not None:
        p["pid"] = pid
    return call("click", **p)

def type_text(text, pid=None, window_id=None):
    """Frappe du texte au clavier (dans la fenetre visee si pid / window_id sont donnes)."""
    p = {"text": text}
    if pid is not None:
        p["pid"] = pid
    if window_id is not None:
        p["window_id"] = window_id
    return call("type_text", **p)

def windows():
    """Liste des fenetres."""
    return call("list_windows")
