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


def test_prepend_python_puts_the_kernel_python_first(tmp_path):
    exe = tmp_path / "rt" / "bin" / "python3"
    other = os.pathsep.join(["/usr/bin", str(exe.parent), "/bin"])
    env = {"PATH": other}
    path = _env.prepend_python(env, str(exe)).split(os.pathsep)
    assert path[0] == str(exe.parent)
    assert path.count(str(exe.parent)) == 1
    assert "/usr/bin" in path and "/bin" in path


def test_shell_python_and_pip_are_the_kernel_python(workspace):
    _env.prepend_python()
    from axecode_kernel import shell

    out = shell.run("python -c \"import sys; print(sys.executable)\"; python -m pip --version", timeout=60)
    lines = out["output"].strip().splitlines()
    assert os.path.realpath(lines[0]) == os.path.realpath(sys.executable)
    # pip --version names the site-packages of the interpreter it installs into
    assert os.path.realpath(sys.prefix) in os.path.realpath(lines[-1].split(" from ")[1].split(" (")[0])
