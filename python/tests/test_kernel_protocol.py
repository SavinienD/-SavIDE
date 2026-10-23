import json
import os
import queue
import subprocess
import sys
import threading
import time

import pytest

pytest.importorskip("IPython")

PKG_PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class KernelProcess:
    """Starts ``python -m axecode_kernel`` with piped stdio, like process.rs."""

    def __init__(self, workspace, env=None):
        env = dict(os.environ, PYTHONPATH=PKG_PARENT, PYTHONUTF8="1", **(env or {}))
        self.proc = subprocess.Popen(
            [sys.executable, "-u", "-m", "axecode_kernel"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=str(workspace), env=env,
        )
        self.lines = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        assert self.wait(lambda m: m.get("type") == "ready")
        self.send({"type": "init", "id": "init", "workspace": str(workspace), "modules": {}})
        assert self.wait(lambda m: m.get("type") == "init_result")["ok"]

    def _read(self):
        for raw in self.proc.stdout:
            self.lines.put(json.loads(raw))

    def send(self, message):
        self.proc.stdin.write((json.dumps(message) + "\n").encode())
        self.proc.stdin.flush()

    def wait(self, match, timeout=30):
        while True:
            message = self.lines.get(timeout=timeout)
            if match(message):
                return message

    def run(self, exec_id, code, timeout=30):
        self.send({"type": "exec", "id": exec_id, "code": code})
        return self.wait(lambda m: m.get("type") == "done" and m.get("id") == exec_id, timeout)

    def close(self):
        self.send({"type": "shutdown"})
        self.proc.wait(timeout=10)


@pytest.fixture()
def kernel(tmp_path):
    k = KernelProcess(tmp_path)
    yield k
    k.close()


def test_input_does_not_read_protocol(kernel):
    done = kernel.run("a", "input()")
    assert "EOFError" in done["error"]
    assert kernel.run("b", "print(41 + 1)")["stdout"].strip() == "42"


def test_child_process_gets_empty_stdin(kernel):
    code = (
        "import subprocess, sys\n"
        "r = subprocess.run([sys.executable, '-c', 'import sys; print(repr(sys.stdin.read()))'],"
        " capture_output=True, text=True, timeout=10)\n"
        "print(r.stdout.strip())"
    )
    done = kernel.run("c", code)
    assert done["error"] is None
    assert done["stdout"].strip() == "''"
    assert kernel.run("d", "print('ok')")["stdout"].strip() == "ok"


def test_snapshot_leaves_out_oversized_variables(kernel):
    assert kernel.run("a", "small = 1\nbig = bytes(17 * 1024 * 1024)")["error"] is None
    kernel.send({"type": "snapshot", "id": "s"})
    snapshot = kernel.wait(lambda m: m.get("id") == "s")
    assert len(snapshot["data"]) < 1024 * 1024
    kernel.send({"type": "restore", "id": "r", "data": snapshot["data"]})
    restored = kernel.wait(lambda m: m.get("id") == "r")
    assert restored["restored"] == ["small"]
    assert restored["failed"] == ["big"]


def _snapshot(kernel, snap_id, limit):
    """Asks for a snapshot; fails if the reply takes ``limit`` seconds or more."""
    started = time.monotonic()
    kernel.send({"type": "snapshot", "id": snap_id})
    reply = kernel.wait(lambda m: m.get("id") == snap_id, timeout=limit)
    elapsed = time.monotonic() - started
    assert elapsed < limit, f"snapshot took {elapsed:.1f} s"
    return reply, elapsed


def test_snapshot_leaves_out_live_resources(kernel):
    # SCRAPPING, 20/10/2026: a shell.Session in the namespace made the
    # end-of-turn snapshot hang forever (dill vs the session's reader thread).
    code = (
        "import io, threading\n"
        "s = shell.session()\n"
        "holder = {'inner': s}\n"
        "t = threading.Thread(target=print)\n"
        "f = open('data.txt', 'w')\n"
        "buf = io.BytesIO(b'kept')\n"
        "keep = 7\n"
    )
    assert kernel.run("a", code)["error"] is None
    snapshot, _ = _snapshot(kernel, "s", 5)
    reasons = {item["name"]: item["reason"] for item in snapshot["skipped"]}
    assert "shell.Session" in reasons["s"]
    assert reasons["holder"].startswith("live resource")
    assert "Thread" in reasons["t"]
    assert "file" in reasons["f"]
    assert "buf" not in reasons and "keep" not in reasons
    kernel.send({"type": "restore", "id": "r", "data": snapshot["data"]})
    restored = kernel.wait(lambda m: m.get("id") == "r")
    assert {"keep", "buf"} <= set(restored["restored"])
    assert {"s", "holder", "t", "f"} <= set(restored["failed"])
    assert kernel.run("b", "s.close(); f.close(); print(keep, buf.getvalue())")["stdout"].strip() == "7 b'kept'"


STUCK = (
    "import threading\n"
    "_gate = threading.Event()\n"
    "class Stuck:\n"
    "    def __reduce__(self):\n"
    "        _gate.wait()\n"
    "        return (int, ())\n"
)


def test_snapshot_gives_up_on_a_variable_that_blocks(kernel):
    assert kernel.run("a", STUCK + "stuck = Stuck()\nkeep = 1\n")["error"] is None
    snapshot, elapsed = _snapshot(kernel, "s", 5)
    reasons = {item["name"]: item["reason"] for item in snapshot["skipped"]}
    assert reasons["stuck"] == "timeout"
    assert elapsed >= 1.5
    assert "keep" not in reasons
    kernel.run("b", "_gate.set()")


def test_snapshot_total_budget(tmp_path):
    k = KernelProcess(tmp_path, env={"AXECODE_SNAPSHOT_VARIABLE_SECONDS": "1",
                                     "AXECODE_SNAPSHOT_TOTAL_SECONDS": "1.5"})
    try:
        assert k.run("a", STUCK + "a1 = Stuck()\na2 = Stuck()\na3 = Stuck()\n")["error"] is None
        snapshot, elapsed = _snapshot(k, "s", 4)
        reasons = {item["name"]: item["reason"] for item in snapshot["skipped"]}
        assert reasons["a1"] == "timeout" and reasons["a2"] == "timeout"
        assert reasons["a3"].startswith("timeout: snapshot budget")
        k.run("b", "_gate.set()")
    finally:
        k.close()
