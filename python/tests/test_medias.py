"""web.search, images.generate(provider=...), videos.generate, providers()."""
import inspect

from axecode_kernel import bridge, images, videos, web
from axecode_kernel.__main__ import MODULES


def _faux(monkeypatch, reponse):
    vus = []

    def faux(method, params):
        vus.append((method, params))
        return reponse

    monkeypatch.setattr(bridge, "call", faux)
    return vus


def test_videos_dans_les_modules_apres_images():
    assert MODULES.index("videos") == MODULES.index("images") + 1


def test_web_search_envoie_max_results_et_fetch_n_envoie_pas_prompt(monkeypatch):
    vus = _faux(monkeypatch, {"content": "r"})
    assert web.search("rust", max_results=3) == "r"
    assert web.fetch("https://example.com", prompt="ignoré") == "r"
    assert vus == [("web.search", {"query": "rust", "max_results": 3}),
                   ("web.fetch", {"url": "https://example.com"})]


def test_images_generate_transmet_fournisseur_et_options(monkeypatch):
    vus = _faux(monkeypatch, {"content": "ok", "images": [{"path": "/d/a.png", "mediaType": "image/png"}]})
    out = images.generate("un chat", path="sorties/chat", provider="fal", aspect_ratio="16:9", n=2)
    assert out["images"][0]["path"] == "/d/a.png"
    assert vus == [("images.generate", {"prompt": "un chat", "path": "sorties/chat", "provider": "fal",
                                        "aspect_ratio": "16:9", "n": 2})]


def test_videos_generate_renvoie_le_chemin(monkeypatch):
    vus = _faux(monkeypatch, {"content": "ok", "images": [{"path": "/w/clip.mp4", "mediaType": "video/mp4"}]})
    assert videos.generate("une course", path="clip", duration=5) == "/w/clip.mp4"
    assert vus == [("videos.generate", {"prompt": "une course", "path": "clip", "duration": 5})]


def test_videos_generate_sans_fichier_leve(monkeypatch):
    _faux(monkeypatch, {"content": "rien", "images": []})
    try:
        videos.generate("x")
    except RuntimeError as err:
        assert "rien" in str(err)
    else:
        raise AssertionError("aurait dû lever")


def test_providers_passent_par_l_hote(monkeypatch):
    vus = _faux(monkeypatch, [{"name": "fal", "kind": "video"}])
    assert videos.providers() == images.providers() == [{"name": "fal", "kind": "video"}]
    assert vus == [("media.providers", {}), ("media.providers", {})]


def test_aides_disent_d_ou_vient_le_fournisseur():
    for module, mots in ((web, ["Automatique", "abonnement ChatGPT", "Exa", "requests"]),
                         (images, ["abonnement", "API personnalisée", "providers()"]),
                         (videos, ["API", "personnalisées", "suivi", "chemin"])):
        doc = inspect.getdoc(module)
        for mot in mots:
            assert mot in doc, (module.__name__, mot)
