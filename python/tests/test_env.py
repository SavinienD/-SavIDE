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


def test_refresh_user_environment_reads_the_current_user_values():
    env = {"PATH": os.pathsep.join(["/app/bin", "/old"]), "KEEP": "1", "PYTHONPATH": "/pkg",
           "AXECODE_WORKSPACE": "/ws", "GIT_PAGER": "cat", "AXECODE_PROTECTED_ENV": "GIT_PAGER"}
    registry = [
        ("machine", {"Path": "/sys", "SHARED": "machine"}),
        ("user", {"Path": os.pathsep.join(["/user", "/old"]), "SHARED": "user", "NEW_TOKEN": "abc",
                  "PYTHONPATH": "/evil", "AXECODE_WORKSPACE": "/evil", "GIT_PAGER": "less"}),
    ]
    old = os.environ.get("AXECODE_PROTECTED_ENV")
    os.environ["AXECODE_PROTECTED_ENV"] = "GIT_PAGER"
    try:
        changed = _env.refresh_user_environment(lambda: registry, env)
    finally:
        if old is None:
            os.environ.pop("AXECODE_PROTECTED_ENV", None)
        else:
            os.environ["AXECODE_PROTECTED_ENV"] = old
    assert env["NEW_TOKEN"] == "abc" and env["SHARED"] == "user" and env["KEEP"] == "1"
    assert env["PYTHONPATH"] == "/pkg" and env["AXECODE_WORKSPACE"] == "/ws" and env["GIT_PAGER"] == "cat"
    assert env["PATH"].split(os.pathsep) == ["/sys", "/user", "/old", "/app/bin"]
    assert "NEW_TOKEN" in changed and "PATH" in changed


def test_refresh_is_a_no_op_off_windows_and_on_reader_errors():
    env = {"A": "1"}
    def boom():
        raise OSError("no registry")
    assert _env.refresh_user_environment(boom, env) == [] and env == {"A": "1"}
    if not _env.IS_WINDOWS:
        assert _env.refresh_user_environment(None, env) == []


@pytest.mark.skipif(not _env.IS_WINDOWS, reason="registre Windows")
def test_registry_reader_returns_user_scope():
    scopes = dict(_env._read_registry())
    assert "user" in scopes and "machine" in scopes
