"""agents_cli : module du noyau qui passe par l'hôte (« agents_cli.* »)."""
import pytest

from axecode_kernel import agents_cli, bridge
from axecode_kernel.__main__ import MODULES


def test_agents_cli_dans_les_modules():
    assert "agents_cli" in MODULES


def test_lancer_attendre_resultat_arreter(monkeypatch):
    vus = []
    etats = iter([
        {"id": "t1", "statut": "en_cours", "fini": False, "code_sortie": None},
        {"id": "t1", "statut": "termine", "fini": True, "code_sortie": 0},
    ])

    def faux(method, params):
        vus.append((method, params))
        if method == "agents_cli.lancer":
            return {"id": "t1", "cli": "claude", "dossier": "/p/x", "journal": "/d/t1/journal.log", "branche": "agent/claude-1"}
        if method == "agents_cli.statut":
            return next(etats)
        if method == "agents_cli.resultat":
            return {"id": "t1", "statut": "termine", "texte": "fini", "journal": "/d/t1/journal.log"}
        return {"id": params.get("id"), "statut": "arrete"}

    monkeypatch.setattr(bridge, "call", faux)
    monkeypatch.setattr(agents_cli, "_PAS", 0.01)
    p = agents_cli.lancer("claude", "Corrige le test", dossier="sous", worktree=True, modele="opus")
    assert p.id == "t1" and p.branche == "agent/claude-1"
    assert "claude t1" in repr(p)
    assert agents_cli.attendre(p, timeout=5)["statut"] == "termine"
    assert agents_cli.resultat(p)["texte"] == "fini"
    assert agents_cli.arreter("t1")["statut"] == "arrete"
    assert vus[0] == ("agents_cli.lancer", {"cli": "claude", "prompt": "Corrige le test", "worktree": True, "dossier": "sous", "modele": "opus"})
    assert [m for m, _ in vus[1:]] == ["agents_cli.statut", "agents_cli.statut", "agents_cli.resultat", "agents_cli.arreter"]


def test_attendre_rend_la_main_au_delai(monkeypatch):
    monkeypatch.setattr(bridge, "call", lambda m, p: {"id": p["id"], "statut": "en_cours", "fini": False})
    debut = __import__("time").monotonic()
    assert agents_cli.attendre({"id": "t2"}, timeout=0.2)["fini"] is False
    assert __import__("time").monotonic() - debut < 2


def test_entrees_refusees():
    with pytest.raises(ValueError):
        agents_cli.lancer("claude", "   ")
    with pytest.raises(ValueError):
        agents_cli.resultat(None)
