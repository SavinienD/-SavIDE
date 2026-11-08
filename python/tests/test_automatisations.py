"""automatisations : module du noyau qui passe par l'hôte (« automatisations.* »)."""
import pytest

from axecode_kernel import automatisations, bridge
from axecode_kernel.__main__ import MODULES

EXECUTION = {
    "id": "x1", "statut": "reussie", "declencheur": "horaire", "prevueMs": 1792990000000,
    "debutMs": 1792990000000, "finMs": 1792990065000, "resume": "Fait.", "sessionId": "s1",
}
FICHE = {
    "id": "a1", "nom": "Rapport", "dossier": "/p", "horaireTexte": "Tous les jours à 8 h", "active": True,
    "prochaineMs": 1793000000000, "enCours": False, "modele": {"provider": "anthropic", "name": "claude"},
    "memeConversation": False, "historique": [EXECUTION],
}


def _hote(monkeypatch, reponses):
    vus = []

    def faux(method, params=None):
        vus.append((method, params))
        return reponses.get(method)

    monkeypatch.setattr(bridge, "call", faux)
    return vus


def test_dans_les_modules_du_noyau():
    assert "automatisations" in MODULES


def test_horaires_lisibles():
    h = automatisations._horaire
    assert h("08:00") == {"type": "quotidien", "heure": "08:00"}
    assert h({"jours": [1, 5], "heure": "8:30"}) == {"type": "hebdomadaire", "jours": [1, 5], "heure": "8:30"}
    assert h({"heures": 2}) == {"type": "intervalle", "heures": 2, "minute": 0}
    assert h("cron:0 8 * * 1-5") == {"type": "cron", "expression": "0 8 * * 1-5"}
    assert h("0 8 * * 1-5") == {"type": "cron", "expression": "0 8 * * 1-5"}
    assert h("@daily") == {"type": "cron", "expression": "@daily"}
    assert h({"cron": "0 22 * * 0"}) == {"type": "cron", "expression": "0 22 * * 0"}
    assert h({"type": "quotidien", "heure": "07:00"}) == {"type": "quotidien", "heure": "07:00"}
    with pytest.raises(ValueError, match="horaire illisible"):
        h(12)


def test_creer_envoie_les_champs_et_rend_une_fiche_courte(monkeypatch):
    vus = _hote(monkeypatch, {"automatisations.creer": FICHE})
    fiche = automatisations.creer("Rapport", "Fais le point.", "08:00", verification="git pull --ff-only")
    assert vus == [("automatisations.creer", {
        "nom": "Rapport", "prompt": "Fais le point.", "horaire": {"type": "quotidien", "heure": "08:00"},
        "memeConversation": False, "active": True, "rattrapage": True, "verification": "git pull --ff-only",
    })]
    assert fiche["horaire"] == "Tous les jours à 8 h"
    assert fiche["modele"] == "anthropic/claude"
    assert fiche["derniere"]["statut"] == "reussie"
    assert fiche["derniere"]["duree_s"] == 65
    assert fiche["derniere"]["session_id"] == "s1"
    assert "historique" not in fiche


def test_lister_modifier_lancer_historique(monkeypatch):
    vus = _hote(monkeypatch, {
        "automatisations.lister": {"automatisations": [FICHE], "maintenantMs": 1},
        "automatisations.modifier": FICHE,
        "automatisations.lancer": {"id": "x2", "statut": "en_cours", "declencheur": "manuel", "debutMs": 1, "sessionId": "s2"},
        "automatisations.historique": [dict(EXECUTION, nom="Rapport", automatisationId="a1")],
        "automatisations.supprimer": {"ok": True},
    })
    assert [a["nom"] for a in automatisations.lister()] == ["Rapport"]
    automatisations.modifier("a1", active=False, horaire={"jours": [1], "heure": "08:00"}, meme_conversation=True, verification=None)
    assert vus[-1] == ("automatisations.modifier", {
        "id": "a1", "active": False, "horaire": {"type": "hebdomadaire", "jours": [1], "heure": "08:00"},
        "memeConversation": True, "verification": "",
    })
    lancee = automatisations.lancer("a1")
    assert lancee["statut"] == "en_cours" and lancee["declencheur"] == "manuel"
    lignes = automatisations.historique("a1", limite=5)
    assert vus[-1] == ("automatisations.historique", {"limite": 5, "id": "a1"})
    assert lignes[0]["automatisation"] == "Rapport" and lignes[0]["resume"] == "Fait."
    assert automatisations.supprimer("a1") == {"ok": True}


def test_modifier_refuse_un_champ_inconnu(monkeypatch):
    _hote(monkeypatch, {})
    with pytest.raises(TypeError, match="champ inconnu couleur"):
        automatisations.modifier("a1", couleur="bleu")

