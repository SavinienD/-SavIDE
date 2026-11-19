"""Noyau asynchrone (réglage kernelAsync, lot D2) : boucle permanente, sortie
rendue à sa cellule, interruption, commandes de fond de ``shell.start``."""

import json
import os
import sys
import threading
import time

import pytest

from test_kernel_protocol import KernelProcess

pytest.importorskip("IPython")

INTERRUPTED = "KeyboardInterrupt : exécution interrompue"


class HostKernel(KernelProcess):
    """Noyau asynchrone dont l'hôte simulé répond aux appels ``guet.*``."""

    def __init__(self, workspace):
        self.calls = []
        self._send_lock = threading.Lock()
        self._n = 0
        super().__init__(workspace, env={"AXECODE_KERNEL_ASYNC": "1"})

    def _read(self):
        for raw in self.proc.stdout:
            message = json.loads(raw)
            if message.get("type") == "host_call":
                self.calls.append((message["method"], message.get("params") or {}))
                result = {}
                if message["method"] == "guet.fond":
                    self._n += 1
                    result = {"id": f"g{self._n}"}
                self.send({"type": "host_result", "call_id": message["call_id"], "ok": True, "result": result})
                continue
            self.lines.put(message)

    def send(self, message):
        with self._send_lock:
            super().send(message)

    def methods(self, gid):
        return [m for m, p in self.calls if p.get("id") == gid]


@pytest.fixture()
def akernel(tmp_path):
    k = HostKernel(tmp_path)
    yield k
    k.close()


def test_ready_announces_async(tmp_path):
    k = KernelProcess(tmp_path, env={"AXECODE_KERNEL_ASYNC": "1"})
    try:
        assert k.run("a", "print(type(sys.stdout).__name__ if 'sys' in dir() else __import__('sys').stdout.__class__.__name__)")["stdout"].strip() == "Router"
    finally:
        k.close()


def test_tasks_keep_running_between_cells(akernel):
    code = (
        "import asyncio\nticks = []\n"
        "async def tick():\n    while True:\n        ticks.append(1)\n        await asyncio.sleep(0.05)\n"
        "t = asyncio.create_task(tick())\nawait asyncio.sleep(0)"
    )
    assert akernel.run("a", code)["error"] is None
    time.sleep(0.6)
    done = akernel.run("b", "print(len(ticks) >= 5, t.done())")
    assert done["stdout"].strip() == "True False", done


def test_late_output_goes_back_to_its_cell(akernel):
    code = (
        "import asyncio\n"
        "async def later():\n    await asyncio.sleep(0.3)\n    print('tard')\n"
        "bg = asyncio.create_task(later())\nprint('tout de suite')"
    )
    first = akernel.run("a", code)
    assert first["stdout"] == "tout de suite\n"
    stream = akernel.wait(lambda m: m.get("type") == "stream" and "tard" in m.get("text", ""), timeout=5)
    assert stream["id"] == "a"
    second = akernel.run("b", "print('b')")
    assert second["stdout"] == "[sortie de fond de la cellule a]\ntard\nb\n", second


def test_interrupt_cancels_an_awaiting_cell(akernel):
    akernel.run("a", "import asyncio\nticks = []\nasync def tick():\n    while True:\n        ticks.append(1)\n        await asyncio.sleep(0.05)\nt = asyncio.create_task(tick())")
    akernel.send({"type": "exec", "id": "w", "code": "await asyncio.sleep(30)"})
    time.sleep(0.5)
    started = time.monotonic()
    akernel.send({"type": "interrupt"})
    done = akernel.wait(lambda m: m.get("type") == "done" and m.get("id") == "w", timeout=10)
    assert done["error"] == INTERRUPTED, done
    assert time.monotonic() - started < 5
    assert akernel.run("b", "print(t.done())")["stdout"].strip() == "False"


def test_interrupt_stops_running_code(akernel):
    akernel.send({"type": "exec", "id": "s", "code": "import time\nwhile True:\n    time.sleep(0.01)"})
    time.sleep(0.5)
    akernel.send({"type": "interrupt"})
    done = akernel.wait(lambda m: m.get("type") == "done" and m.get("id") == "s", timeout=10)
    assert done["error"] == INTERRUPTED, done
    assert akernel.run("b", "print('ok')")["stdout"].strip() == "ok"


def _wait_for(predicate, timeout=10):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.05)
    return False


@pytest.mark.skipif(sys.platform == "win32", reason="commandes bash")
def test_background_command_wakes_the_session(akernel):
    done = akernel.run("a", "h = shell.start('echo un; sleep 0.3; echo deux; exit 3')\nprint(type(h).__name__, h.alive)")
    assert done["stdout"].strip() == "Commande True", done
    assert _wait_for(lambda: "guet.signaler" in akernel.methods("g1"))
    params = [p for m, p in akernel.calls if m == "guet.signaler"][0]
    assert params["code"] == 3 and "deux" in params["sortie"], params
    fond = [p for m, p in akernel.calls if m == "guet.fond"][0]
    assert fond["cmd"].startswith("echo un")
    # Read after the wake-up was sent: it is withdrawn.
    out = akernel.run("b", "r = h.poll()\nprint(r['alive'], r['exit_code'], h.tail(1))")["stdout"]
    assert out.strip() == "False 3 deux", out
    assert akernel.methods("g1") == ["guet.signaler", "guet.annuler"]


@pytest.mark.skipif(sys.platform == "win32", reason="commandes bash")
def test_awaited_command_does_not_wake(akernel):
    out = akernel.run("a", "h = shell.start('sleep 0.2; echo fin')\nr = await h\nprint(r['exit_code'], r['output'].strip(), h.wait(1))")
    assert out["stdout"].strip() == "0 fin 0", out
    assert _wait_for(lambda: "guet.annuler" in akernel.methods("g1"))
    assert "guet.signaler" not in akernel.methods("g1")
    # Old API on the new handle.
    out = akernel.run("b", "h2 = shell.start('echo x')\nprint(h2.wait(5), shell.poll(h2)['alive'])")
    assert out["stdout"].strip() == "0 False", out


@pytest.mark.skipif(sys.platform == "win32", reason="commandes bash")
def test_kill_stops_the_whole_tree(akernel, tmp_path):
    code = (
        "h = shell.start('sleep 30 & echo $! > enfant.pid; wait')\n"
        "import time, os\n"
        "for _ in range(100):\n"
        "    if os.path.exists('enfant.pid') and open('enfant.pid').read().strip(): break\n"
        "    time.sleep(0.05)\n"
        "enfant = int(open('enfant.pid').read())\n"
        "h.kill()\nprint(h.wait(5) is not None)"
    )
    out = akernel.run("a", code)
    assert out["stdout"].strip() == "True", out
    pid = int((tmp_path / "enfant.pid").read_text())
    assert _wait_for(lambda: not _alive(pid), 5)
    assert _wait_for(lambda: "guet.annuler" in akernel.methods("g1"))
    assert "guet.signaler" not in akernel.methods("g1")


def _alive(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split()[2] != "Z"
    except OSError:
        return False
