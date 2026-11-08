""" « Endormir » une conversation arrête son noyau Python ; au message suivant,
un NOUVEAU noyau reprend les variables du dernier instantané (dill). Ce test vérifie ce que
l'interface promet : variables simples, fonctions et classes définies dans la conversation
reprises ; fichiers ouverts (et autres ressources vivantes) perdus.

pytest python/tests/test_sommeil.py, ou sans pytest avec le Python embarqué (IPython + dill) :
<python-runtime>/bin/python3 python/tests/test_sommeil.py"""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

try:
    import pytest

    pytest.importorskip("IPython")
    pytest.importorskip("dill")
except ImportError:  # Python embarqué : pas de pytest
    pytest = None

PKG_PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Noyau:
    """``python -m axecode_kernel`` piloté comme le fait process.rs (une ligne JSON par message)."""

    def __init__(self, dossier):
        env = dict(os.environ, PYTHONPATH=PKG_PARENT, PYTHONUTF8="1")
        self.proc = subprocess.Popen([sys.executable, "-u", "-m", "axecode_kernel"], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=str(dossier), env=env)
        self.lignes = queue.Queue()
        threading.Thread(target=lambda: [self.lignes.put(json.loads(l)) for l in self.proc.stdout], daemon=True).start()
        self.attendre(lambda m: m.get("type") == "ready")
        self.envoyer({"type": "init", "id": "init", "workspace": str(dossier), "modules": {}})
        assert self.attendre(lambda m: m.get("type") == "init_result")["ok"]

    def envoyer(self, message):
        self.proc.stdin.write((json.dumps(message) + "\n").encode())
        self.proc.stdin.flush()

    def attendre(self, accepte, delai=60):
        while True:
            message = self.lignes.get(timeout=delai)
            if accepte(message):
                return message

    def executer(self, ident, code):
        self.envoyer({"type": "exec", "id": ident, "code": code})
        return self.attendre(lambda m: m.get("type") == "done" and m.get("id") == ident)

    def fermer(self):
        self.envoyer({"type": "shutdown"})
        self.proc.wait(timeout=10)


CODE = (
    "x = 41\n"
    "noms = {'a': [1, 2], 'b': 'texte'}\n"
    "def double(v):\n"
    "    return 2 * v\n"
    "class Point:\n"
    "    def __init__(self, x):\n"
    "        self.x = x\n"
    "p = Point(3)\n"
    "import json as j\n"
    "f = open('trace.txt', 'w')\n"
)


def test_un_nouveau_noyau_reprend_les_variables(tmp_path):
    avant = Noyau(tmp_path)
    try:
        assert avant.executer("1", CODE)["error"] is None
        avant.envoyer({"type": "snapshot", "id": "s"})
        instantane = avant.attendre(lambda m: m.get("id") == "s")
        assert instantane["ok"]
        avant.executer("2", "f.close()")
    finally:
        avant.fermer()
    apres = Noyau(tmp_path)
    try:
        assert apres.executer("0", "print('x' in dir())")["stdout"].strip() == "False", "nouveau processus, espace vide"
        apres.envoyer({"type": "restore", "id": "r", "data": instantane["data"]})
        repris = apres.attendre(lambda m: m.get("id") == "r")
        assert {"x", "noms", "double", "Point", "p"} <= set(repris["restored"]), repris
        assert "f" in repris["failed"], "fichier ouvert : perdu"
        fin = apres.executer("3", "print(x + 1, noms['a'], double(4), p.x, j.dumps([1]))")
        assert fin["error"] is None, fin["error"]
        assert fin["stdout"].strip() == "42 [1, 2] 8 3 [1]"
    finally:
        apres.fermer()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as dossier:
        test_un_nouveau_noyau_reprend_les_variables(Path(dossier))
    print("ok : variables reprises par un nouveau noyau")
