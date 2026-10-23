"""shell — run commands and keep persistent shell sessions.

``run(cmd)`` executes one command (PowerShell 7 on Windows when available,
bash/sh elsewhere) in the workspace and returns ``{"exit_code", "output"}``.
``session()`` opens a persistent shell (cwd, env and variables survive between
``send`` calls) — useful for long workflows; ``close()`` it when done.
Background/long-running processes: ``start(cmd)`` then ``poll(proc)``.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from typing import Optional

from axecode_kernel import bridge

__all__ = ["run", "session", "Session", "start", "poll", "stop", "default_shell"]

MAX_OUTPUT = 200_000
IS_WINDOWS = sys.platform == "win32"


def default_shell() -> list[str]:
    """The shell used by ``run`` / ``session`` as an argv prefix."""
    explicit = os.environ.get("AXECODE_SHELL")
    if explicit:
        return [explicit]
    if IS_WINDOWS:
        pwsh = shutil.which("pwsh") or shutil.which("powershell")
        if pwsh:
            return [pwsh, "-NoLogo", "-NoProfile", "-NonInteractive"]
        return [os.environ.get("COMSPEC", "cmd.exe")]
    return [shutil.which("bash") or "/bin/sh"]


def _is_powershell(argv: list[str]) -> bool:
    return "pwsh" in os.path.basename(argv[0]).lower() or "powershell" in os.path.basename(argv[0]).lower()


def _clip(text: str) -> str:
    if len(text) <= MAX_OUTPUT:
        return text
    half = MAX_OUTPUT // 2
    return f"{text[:half]}\n[... {len(text) - MAX_OUTPUT} chars omitted ...]\n{text[-half:]}"


def _creationflags() -> int:
    return 0x08000000 if IS_WINDOWS else 0  # CREATE_NO_WINDOW


def run(cmd: str, timeout: Optional[float] = 120, cwd: Optional[str] = None, env: Optional[dict] = None,
        echo: bool = False) -> dict:
    """Run one shell command and return ``{"exit_code", "output", "timed_out"}``.

    stdout and stderr are merged. ``timeout`` in seconds (None = no limit).
    ``echo=True`` also prints the output (streamed in the chat card).
    """
    argv = default_shell()
    if _is_powershell(argv):
        full = argv + ["-Command", f"$ProgressPreference='SilentlyContinue'; {cmd}"]
    elif IS_WINDOWS:
        full = argv + ["/d", "/s", "/c", cmd]
    else:
        full = argv + ["-c", cmd]
    environment = {**os.environ, **(env or {})}
    try:
        proc = subprocess.run(
            full, cwd=cwd or bridge.workspace_root(), env=environment, capture_output=True,
            stdin=subprocess.DEVNULL, timeout=timeout, creationflags=_creationflags(),
        )
        output = (proc.stdout or b"") + (proc.stderr or b"")
        result = {"exit_code": proc.returncode, "output": _clip(output.decode("utf-8", "replace")),
                  "timed_out": False}
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or b"") + (exc.stderr or b"")
        result = {"exit_code": None, "output": _clip(output.decode("utf-8", "replace")), "timed_out": True}
    if echo:
        print(result["output"], end="" if result["output"].endswith("\n") else "\n")
    return result


_NOT_PICKLABLE = (
    "shell.Session is a live shell process: it cannot be pickled or copied "
    "(the end-of-turn snapshot leaves it out; open a new session after a kernel restart)"
)


class Session:
    """A persistent shell process; state survives between ``send`` calls."""

    def __init__(self, cwd: Optional[str] = None):
        self.argv = default_shell()
        self.powershell = _is_powershell(self.argv)
        args = list(self.argv)
        if self.powershell:
            args += ["-Command", "-"]
        self.proc = subprocess.Popen(
            args, cwd=cwd or bridge.workspace_root(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, creationflags=_creationflags(), bufsize=0,
        )
        self._buffer = bytearray()
        self._lock = threading.Lock()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        stream = self.proc.stdout
        while stream is not None:
            chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(1)
            if not chunk:
                break
            with self._lock:
                self._buffer.extend(chunk)

    def _take(self) -> str:
        with self._lock:
            data = bytes(self._buffer)
            self._buffer.clear()
        return data.decode("utf-8", "replace")

    @property
    def alive(self) -> bool:
        return self.proc.poll() is None

    def send(self, cmd: str, timeout: Optional[float] = 120) -> dict:
        """Run ``cmd`` in the session; returns ``{"exit_code", "output", "timed_out"}``."""
        if not self.alive:
            raise RuntimeError("shell session has exited")
        marker = f"__AXECODE_DONE_{uuid.uuid4().hex}__"
        if self.powershell:
            script = (f"{cmd}\n$__c = if ($?) {{ if ($LASTEXITCODE) {{ $LASTEXITCODE }} else {{ 0 }} }} else {{ 1 }}\n"
                      f"Write-Output \"{marker}$__c\"\n")
        elif IS_WINDOWS:
            script = f"{cmd}\r\necho {marker}%ERRORLEVEL%\r\n"
        else:
            script = f"{cmd}\nprintf '\\n{marker}%s\\n' \"$?\"\n"
        assert self.proc.stdin is not None
        self.proc.stdin.write(script.encode("utf-8"))
        self.proc.stdin.flush()
        deadline = None if timeout is None else time.time() + timeout
        collected = ""
        while True:
            collected += self._take()
            index = collected.find(marker)
            if index >= 0 and "\n" in collected[index:]:
                tail = collected[index + len(marker):].split("\n", 1)[0].strip()
                output = collected[:index].rstrip("\r\n")
                try:
                    code: Optional[int] = int(tail)
                except ValueError:
                    code = None
                return {"exit_code": code, "output": _clip(output), "timed_out": False}
            if not self.alive:
                return {"exit_code": self.proc.returncode, "output": _clip(collected), "timed_out": False}
            if deadline is not None and time.time() > deadline:
                with self._lock:
                    self._buffer[:0] = collected.encode("utf-8")
                return {"exit_code": None, "output": _clip(collected), "timed_out": True}
            time.sleep(0.02)

    def read(self) -> str:
        """Return output produced since the last call (for timed-out commands)."""
        return _clip(self._take())

    def close(self) -> None:
        """Terminate the session."""
        if self.alive:
            try:
                self.proc.kill()
            except OSError:
                pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def __repr__(self) -> str:
        return f"<shell.Session pid={self.proc.pid} alive={self.alive}>"

    # Pickling must fail at once: dill would otherwise flush/seek the pipes of
    # the process and wait forever for the lock held by the reader thread.
    def __reduce__(self):
        raise TypeError(_NOT_PICKLABLE)

    def __reduce_ex__(self, protocol):
        raise TypeError(_NOT_PICKLABLE)


def session(cwd: Optional[str] = None) -> Session:
    """Open a persistent shell session (PowerShell on Windows, bash elsewhere)."""
    return Session(cwd)


def start(cmd: str, cwd: Optional[str] = None) -> Session:
    """Start a long-running command in its own session; check it with ``poll``."""
    sess = Session(cwd)
    assert sess.proc.stdin is not None
    sess.proc.stdin.write((cmd + ("\r\n" if IS_WINDOWS else "\n")).encode("utf-8"))
    sess.proc.stdin.flush()
    return sess


def poll(proc: Session) -> dict:
    """New output of a background command and whether it is still running."""
    return {"alive": proc.alive, "output": proc.read()}


def stop(proc: Session) -> None:
    """Stop a background command started with ``start``."""
    proc.close()
