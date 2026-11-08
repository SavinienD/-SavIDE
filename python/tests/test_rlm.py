"""Appels légers (query, query_lot) et outils des sous-agents."""
import pytest

from axecode_kernel import bridge, rlm


def _faux(monkeypatch, reponse):
    vus = []

    def faux(method, params=None, timeout=None):
        vus.append((method, params))
        r = reponse(method, params) if callable(reponse) else reponse
        if isinstance(r, Exception):
            raise r
        return r

    monkeypatch.setattr(bridge, "call", faux)
    return vus


def test_query_rend_le_texte(monkeypatch):
    vus = _faux(monkeypatch, {"texte": "résumé", "modele": "openai/gpt", "usage": {"output_tokens": 2}, "tronque": False})
    assert rlm.query("long texte", systeme="Résume.", modele="openai/gpt") == "résumé"
    assert vus == [("rlm.query", {"texte": "long texte", "systeme": "Résume.", "modele": "openai/gpt"})]


def test_query_signale_une_reponse_coupee(monkeypatch, capsys):
    vus = _faux(monkeypatch, {"texte": "début", "modele": "m/x", "usage": {}, "tronque": True})
    assert rlm.query("x", plafond=10) == "début"
    assert vus[0][1] == {"texte": "x", "plafond": 10}
    assert "coupée" in capsys.readouterr().err


def test_query_refuse_un_texte_vide():
    with pytest.raises(ValueError):
        rlm.query("  ")


def test_query_lot_garde_l_ordre_et_liste_les_erreurs(monkeypatch, capsys):
    vus = _faux(monkeypatch, [{"texte": "A", "usage": {"input_tokens": 2, "output_tokens": 1}},
                              {"erreur": "refusé"},
                              {"texte": "C", "usage": {"input_tokens": 3, "output_tokens": 1}}])
    r = rlm.query_lot(("a", "b", "c"), systeme="s", parallele=2)
    assert r == ["A", None, "C"]
    assert r.erreurs == [(1, "refusé")]
    assert r.usage == {"input_tokens": 5, "output_tokens": 2}
    assert vus == [("rlm.query_lot", {"textes": ["a", "b", "c"], "systeme": "s", "parallele": 2})]
    assert "1 sur 3" in capsys.readouterr().err


def test_query_lot_tout_en_echec_leve(monkeypatch):
    _faux(monkeypatch, [{"erreur": "quota épuisé"}, {"erreur": "quota épuisé"}])
    with pytest.raises(bridge.HostError, match="quota épuisé"):
        rlm.query_lot(["a", "b"])


def test_query_lot_vide_et_types(monkeypatch):
    vus = _faux(monkeypatch, [])
    assert rlm.query_lot([]) == []
    assert vus == []
    with pytest.raises(TypeError):
        rlm.query_lot("pas une liste")
    with pytest.raises(TypeError):
        rlm.query_lot(["a", 3])
    with pytest.raises(ValueError):
        rlm.query_lot(["a"], parallele=0)


def test_aides_completes():
    for f in (rlm.query, rlm.query_lot):
        assert f.__doc__ and len(f.__doc__) > 300, f.__name__
    assert {"query", "query_lot"} <= set(rlm.__all__)


# ----- R2 à R6 : worktree, arrêt, reprise, statut, course -----------------------

def test_spawn_avec_worktree(monkeypatch):
    vus = _faux(monkeypatch, {"id": "s9", "session_name": "a", "worktree": "/p-sous-agents/a", "branche": "sous-agent/a"})
    h = rlm.spawn("tâche", name="a", worktree=True)
    assert h.id == "s9" and h["branche"] == "sous-agent/a"
    assert vus == [("rlm.spawn", {"prompt": "tâche", "name": "a", "worktree": True})]
    rlm.spawn("tâche", worktree="mon-essai")
    assert vus[-1][1]["worktree"] == "mon-essai"
    rlm.spawn("tâche")
    assert "worktree" not in vus[-1][1]
    with pytest.raises(TypeError):
        rlm.spawn("tâche", worktree=3)


def test_worktree_fusionner_liberer(monkeypatch, capsys):
    reponses = {
        "rlm.worktree": {"chemin": "/w", "branche": "sous-agent/a", "fichiers": ["a.txt"], "diff_stat": " a.txt | 2 +-"},
        "rlm.fusionner": {"fusionne": False, "conflits": ["a.txt"], "message": "conflit sur 1 fichier(s) (a.txt) : fusion annulée"},
        "rlm.liberer": {"libere": True, "branche_gardee": True, "message": "worktree supprimé"},
    }
    vus = _faux(monkeypatch, lambda m, p: reponses[m])
    assert rlm.worktree({"id": "s9"})["fichiers"] == ["a.txt"]
    r = rlm.fusionner("s9")
    assert r["fusionne"] is False
    assert "conflit" in capsys.readouterr().err
    rlm.liberer("s9")
    rlm.liberer("s9", garder_branche=False)
    assert vus == [("rlm.worktree", {"id": "s9"}), ("rlm.fusionner", {"id": "s9"}),
                   ("rlm.liberer", {"id": "s9", "garder_branche": True}),
                   ("rlm.liberer", {"id": "s9", "garder_branche": False})]


def test_stop_et_retry(monkeypatch):
    vus = _faux(monkeypatch, lambda m, p: {"statut": "arrêté"} if m == "rlm.stop" else {"id": "s10", "session_name": "a-reprise"})
    assert rlm.stop("s9")["statut"] == "arrêté"
    h = rlm.retry({"id": "s9"}, note="utilise la v2 de l'API")
    assert isinstance(h, rlm.SubAgentHandle) and h.id == "s10"
    assert vus == [("rlm.stop", {"id": "s9"}), ("rlm.retry", {"id": "s9", "note": "utilise la v2 de l'API"})]
    rlm.retry("s9")
    assert vus[-1] == ("rlm.retry", {"id": "s9"})


def test_course_et_comparer(monkeypatch):
    n = iter(range(100))

    def reponse(m, p):
        if m == "rlm.spawn":
            return {"id": f"s{next(n)}", "session_name": p["name"]}
        return [
            {"session_name": "course-claude", "modele": "anthropic/claude", "statut": "réussi", "duree_s": 75,
             "fichiers": ["a.rs", "b.rs"], "diff_stat": "2 files changed, 10 insertions(+)"},
            {"session_name": "course-gpt", "modele": "openai/gpt", "statut": "en cours", "duree_s": 3725,
             "fichiers": [], "diff_stat": ""},
        ]

    vus = _faux(monkeypatch, reponse)
    hs = rlm.course("corrige le bug", modeles=["anthropic/claude", "openai/gpt"])
    assert [h.id for h in hs] == ["s0", "s1"]
    assert vus[0] == ("rlm.spawn", {"prompt": "corrige le bug", "name": "course-claude", "model": "anthropic/claude", "worktree": True})
    assert vus[1][1]["name"] == "course-gpt" and vus[1][1]["model"] == "openai/gpt"
    t = rlm.comparer(hs)
    assert vus[-1] == ("rlm.comparer", {"ids": ["s0", "s1"]})
    assert t[0]["statut"] == "réussi"
    texte = repr(t)
    assert "| course-claude | anthropic/claude | réussi | 1 min 15 s | 2 | 2 files changed" in texte, texte
    assert "1 h 02 min" in texte
    with pytest.raises(ValueError):
        rlm.course("x", modeles=[])


def test_aides_r2_r6():
    for nom in ("stop", "retry", "worktree", "fusionner", "liberer", "course", "comparer"):
        f = getattr(rlm, nom)
        assert nom in rlm.__all__ and f.__doc__ and len(f.__doc__) > 120, nom
    assert "worktree" in rlm.spawn.__doc__ and "STATUT" in rlm.wait.__doc__


def test_aide_de_list_subagents_cite_le_statut():
    doc = rlm.list_subagents.__doc__
    assert "``statut``" in doc and "last_result_ts" in doc and "arrêté" in doc
