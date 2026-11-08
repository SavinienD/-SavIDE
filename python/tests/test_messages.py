"""Lot rlm : messages.send(receiver_role="all")."""
import pytest

from axecode_kernel import bridge, messages


def test_send_all_sans_nom(monkeypatch):
    vus = []

    def faux(method, params=None, timeout=None):
        vus.append((method, params))
        return {"delivered_to": ["a", "b"], "messages": []}

    monkeypatch.setattr(bridge, "call", faux)
    r = messages.send("on arrête tout", receiver_role="all")
    assert r["delivered_to"] == ["a", "b"]
    assert vus == [("messages.send", {"text": "on arrête tout", "receiver_role": "all", "receiver_name": None, "mode": "new"})]
    with pytest.raises(ValueError):
        messages.send("x", receiver_role="tous")
    assert '"all"' in messages.send.__doc__
