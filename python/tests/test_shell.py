import pickle
import sys
import threading

import pytest

from axecode_kernel import shell


def test_run_success_and_exit_code(workspace):
    result = shell.run("echo hello")
    assert result["exit_code"] == 0
    assert "hello" in result["output"]
    failing = shell.run("exit 3")
    assert failing["exit_code"] == 3


def test_run_uses_workspace_cwd(workspace):
    (workspace / "marker.txt").write_text("x", encoding="utf-8")
    listing = shell.run("ls" if sys.platform != "win32" else "Get-ChildItem -Name")
    assert "marker.txt" in listing["output"]


def test_run_timeout(workspace):
    cmd = "Start-Sleep -Seconds 5" if sys.platform == "win32" else "sleep 5"
    result = shell.run(cmd, timeout=0.5)
    assert result["timed_out"] is True


def test_session_keeps_state(workspace):
    with shell.session() as sess:
        if sess.powershell:
            sess.send("$x = 41")
            out = sess.send("$x + 1")
        else:
            sess.send("x=41")
            out = sess.send("echo $((x + 1))")
        assert out["exit_code"] == 0
        assert out["output"].strip().endswith("42")
        bad = sess.send("exit 0" if False else ("cmd /c exit 2" if sess.powershell else "false"))
        assert bad["exit_code"] not in (0, None)


def test_session_refuses_pickling_at_once(workspace):
    dill = pytest.importorskip("dill")
    with shell.session() as sess:
        errors = []

        def attempt():
            for dumps in (pickle.dumps, lambda obj: dill.dumps(obj, recurse=True)):
                try:
                    dumps(sess)
                    errors.append("pickled")
                except TypeError as exc:
                    errors.append(str(exc))

        worker = threading.Thread(target=attempt, daemon=True)
        worker.start()
        worker.join(5)
        assert not worker.is_alive(), "pickling a shell.Session hangs"
        assert len(errors) == 2 and all("processus shell vivant" in e for e in errors), errors
