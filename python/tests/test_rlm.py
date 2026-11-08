"""Lot rlm : appels légers (query, query_lot) et outils des sous-agents."""
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
