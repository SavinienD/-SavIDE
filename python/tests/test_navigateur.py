"""navigateur : module du noyau qui passe par l'hôte (« navigateur.* »), vers l'onglet de l'IDE."""
import pytest

from axecode_kernel import bridge, navigateur
from axecode_kernel.__main__ import MODULES


@pytest.fixture()
def hote(monkeypatch):
    vus = []
    reponses = {}

    def faux(method, params=None, timeout=None):
        vus.append((method, params))
        r = reponses.get(method)
        if callable(r):
            return r(params)
        if isinstance(r, list):
            return r.pop(0)
        return r if r is not None else {}

    monkeypatch.setattr(bridge, "call", faux)
    navigateur._dernier.update(url=None, lignes=[])
    return vus, reponses


def test_dans_les_modules():
    assert "navigateur" in MODULES
    assert navigateur.__all__ == ["ouvrir", "lire", "cliquer", "remplir", "touche", "attendre", "capture"]


def test_ouvrir(hote):
    vus, rep = hote
    rep["navigateur.ouvrir"] = {"ok": True, "url": "http://localhost:5173/", "titre": "Démo", "chargement": False}
    assert navigateur.ouvrir("localhost:5173") == "Page : Démo — http://localhost:5173/"
    assert vus == [("navigateur.ouvrir", {"url": "localhost:5173"})]


def test_lire_puis_delta(hote):
    vus, rep = hote
    page = {"url": "http://a/", "titre": "A", "lignes": ["# Accueil", "[e1] bouton « Envoyer »"], "tronque": False}
    rep["navigateur.lire"] = [page, dict(page, lignes=["# Accueil", "[e1] bouton « Envoyer » (désactivé)", "Merci"]), dict(page), dict(page, url="http://a/b")]
    assert navigateur.lire() == "Page : A — http://a/\n# Accueil\n[e1] bouton « Envoyer »"
    assert vus[0] == ("navigateur.lire", {"options": {"max_elements": 150}})
    delta = navigateur.lire(delta=True)
    assert delta.splitlines() == [
        "Page : A — http://a/ (changements)",
        "- [e1] bouton « Envoyer »",
        "+ [e1] bouton « Envoyer » (désactivé)",
        "+ Merci",
    ]
    navigateur.lire()
    assert navigateur.lire(delta=True).startswith("Page : A — http://a/b (nouvelle adresse)")


def test_delta_sans_changement_et_partie(hote):
    vus, rep = hote
    page = {"url": "http://a/", "titre": "", "lignes": ["x"], "tronque": True}
    rep["navigateur.lire"] = lambda p: page
    premier = navigateur.lire(selecteur="main", max_elements=20)
    assert premier.endswith("… (page tronquée : lire(selecteur=...) pour une partie)")
    assert vus[0][1] == {"options": {"max_elements": 20, "selecteur": "main"}}
    assert navigateur.lire(delta=True) == "Page : http://a/\n(aucun changement)"


def test_actions(hote):
    vus, rep = hote
    rep["navigateur.cliquer"] = {"ok": True, "element": "bouton « Envoyer »", "url": "http://a/fin", "titre": "Fin"}
    rep["navigateur.remplir"] = {"ok": True, "element": "champ e-mail « E-mail »"}
    rep["navigateur.touche"] = {"ok": True, "focus": "champ « Nom »", "url": "http://a/", "titre": "A"}
    assert navigateur.cliquer("e3") == "Clic : bouton « Envoyer » · Page : Fin — http://a/fin"
    assert navigateur.cliquer("[e4]").startswith("Clic")
    assert navigateur.cliquer(5).startswith("Clic")
    assert navigateur.remplir("e2", "a@b.fr") == "Rempli : champ e-mail « E-mail »"
    assert navigateur.touche("Tab") == "Touche : Tab · Page : A — http://a/ · focus : champ « Nom »"
    assert [v[1] for v in vus] == [{"ref": "e3"}, {"ref": "e4"}, {"ref": "e5"}, {"ref": "e2", "texte": "a@b.fr"}, {"nom": "Tab"}]


def test_attendre(hote, monkeypatch):
    vus, rep = hote
    monkeypatch.setattr(navigateur.time, "sleep", lambda s: None)
    rep["navigateur.trouver"] = [{"trouve": False}, {"trouve": False}, {"trouve": True}]
    assert navigateur.attendre("Bienvenue", timeout=5) is True
    assert len(vus) == 3 and vus[0] == ("navigateur.trouver", {"cible": "Bienvenue"})
    rep["navigateur.trouver"] = lambda p: {"trouve": False}
    assert navigateur.attendre("#absent", timeout=0) is False

    def ferme(p):
        raise bridge.HostError("navigateur.trouver : le navigateur intégré n'est pas ouvert : appelez d'abord navigateur.ouvrir(url)")

    rep["navigateur.trouver"] = ferme
    with pytest.raises(bridge.HostError):
        navigateur.attendre("x", timeout=5)


def test_capture(hote, tmp_path, monkeypatch):
    vus, rep = hote
    monkeypatch.setenv("AXECODE_WORKSPACE", str(tmp_path))
    rep["navigateur.capture"] = lambda p: {"chemin": p["chemin"], "octets": 10}
    assert navigateur.capture("sorties/page.png") == str(tmp_path / "sorties" / "page.png")
    assert vus[-1] == ("navigateur.capture", {"chemin": str(tmp_path / "sorties" / "page.png")})
