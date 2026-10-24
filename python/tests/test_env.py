import os
import ssl
import sys

import pytest

from axecode_kernel import _env


def test_setup_ssl_points_to_certifi(tmp_path):
    certifi = pytest.importorskip("certifi")
    env = {}
    assert _env.setup_ssl(env) == certifi.where()
    assert env["SSL_CERT_FILE"] == certifi.where()
    # a valid user value is kept
    own = tmp_path / "ca.pem"
    own.write_text("x")
    env = {"SSL_CERT_FILE": str(own)}
    assert _env.setup_ssl(env) == str(own)
    # a stale one is replaced
    env = {"SSL_CERT_FILE": str(tmp_path / "absent.pem")}
    assert _env.setup_ssl(env) == certifi.where()


def test_default_context_loads_certifi(monkeypatch):
    certifi = pytest.importorskip("certifi")
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    _env.setup_ssl()
    assert os.environ["SSL_CERT_FILE"] == certifi.where()
    context = ssl.create_default_context()
    assert context.cert_store_stats()["x509_ca"] > 50
