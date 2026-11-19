"""shell — lancer des commandes et garder des sessions shell persistantes.

``run(cmd)`` exécute une commande (PowerShell 7 sous Windows s'il est présent,
bash/sh ailleurs) dans le dossier de travail et renvoie ``{"exit_code", "output"}``.
``session()`` ouvre un shell persistant (dossier courant, environnement et
variables survivent d'un appel ``send`` à l'autre) — utile pour les longs
enchaînements ; fermez-le avec ``close()`` à la fin.
Processus longs ou en arrière-plan : ``start(cmd)`` puis ``poll(proc)``.
Dans ces shells, ``python`` et ``pip`` sont le Python du noyau (en tête du
PATH) : ``pip install x`` rend ``x`` importable dans le noyau.
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
    """Le shell utilisé par ``run`` / ``session``, sous forme de début d'argv."""
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
    return f"{text[:half]}\n[… {len(text) - MAX_OUTPUT} caractères omis …]\n{text[-half:]}"


def _creationflags() -> int:
    return 0x08000000 if IS_WINDOWS else 0  # CREATE_NO_WINDOW


def run(cmd: str, timeout: Optional[float] = 120, cwd: Optional[str] = None, env: Optional[dict] = None,
        echo: bool = False) -> dict:
    """Exécute une commande shell et renvoie ``{"exit_code", "output", "timed_out"}``.

    stdout et stderr sont fusionnés. ``timeout`` en secondes (``None`` = sans limite).
    ``echo=True`` affiche aussi la sortie (diffusée dans la carte de la conversation).
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
    "shell.Session est un processus shell vivant : il ne peut être ni sérialisé ni copié "
    "(l'instantané de fin de tour le laisse de côté ; ouvrez une nouvelle session après "
    "un redémarrage du noyau)"
)


class Session:
    """Un processus shell persistant ; son état survit d'un appel ``send`` à l'autre."""

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
        """Exécute ``cmd`` dans la session ; renvoie ``{"exit_code", "output", "timed_out"}``."""
        if not self.alive:
            raise RuntimeError("la session shell est terminée")
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
        """Renvoie la sortie produite depuis le dernier appel (pour les commandes qui ont dépassé leur délai)."""
        return _clip(self._take())

    def close(self) -> None:
        """Termine la session."""
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
    """Ouvre une session shell persistante (PowerShell sous Windows, bash ailleurs)."""
    return Session(cwd)


def start(cmd: str, cwd: Optional[str] = None) -> Session:
    """Lance une commande longue dans sa propre session ; suivez-la avec ``poll``."""
    from axecode_kernel import _asynchrone

    if _asynchrone.enabled():
        # Noyau asynchrone : une poignée (tail, poll, kill, wait, await) et un
        # réveil de la session à la fin (voir Commande).
        return Commande(cmd, cwd)
    sess = Session(cwd)
    assert sess.proc.stdin is not None
    sess.proc.stdin.write((cmd + ("\r\n" if IS_WINDOWS else "\n")).encode("utf-8"))
    sess.proc.stdin.flush()
    return sess


def poll(proc: Session) -> dict:
    """Nouvelle sortie d'une commande en arrière-plan, et si elle tourne encore."""
    return {"alive": proc.alive, "output": proc.read()}


def stop(proc: Session) -> None:
    """Arrête une commande en arrière-plan lancée avec ``start``."""
    proc.close()


# ----- commandes de fond du noyau asynchrone (lot D2) -------------------------

_BUFFER_MAX = 1_000_000  # bytes of output kept per background command (the end)
_commandes: "set[Commande]" = set()
_commandes_lock = threading.Lock()


def _argv(cmd: str) -> list[str]:
    argv = default_shell()
    if _is_powershell(argv):
        return argv + ["-Command", f"$ProgressPreference='SilentlyContinue'; {cmd}"]
    if IS_WINDOWS:
        return argv + ["/d", "/s", "/c", cmd]
    return argv + ["-c", cmd]


def _tuer_arbre(pid: int, grace: float = 2.0) -> None:
    """Arrête ``pid`` et ses descendants (psutil ; taskkill en secours)."""
    try:
        import psutil

        root = psutil.Process(pid)
        procs = root.children(recursive=True) + [root]
    except Exception:
        procs = []
    if procs:
        for p in procs:
            try:
                p.terminate()
            except Exception:
                pass
        try:
            _, vivants = psutil.wait_procs(procs, timeout=grace)
        except Exception:
            vivants = procs
        for p in vivants:
            try:
                p.kill()
            except Exception:
                pass
        return
    if IS_WINDOWS:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], stdin=subprocess.DEVNULL,
                       capture_output=True, creationflags=_creationflags())
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass


class Commande(Session):
    """Commande de fond lancée par ``shell.start`` (noyau asynchrone).

    ``tail(n)``, ``poll()``, ``output()``, ``kill()``, ``wait(timeout)`` et
    ``await h`` ; ``shell.poll(h)`` / ``shell.stop(h)`` marchent aussi. À sa fin,
    la session est réveillée (guet de genre ``fond``), sauf si le résultat a
    déjà été lu (``wait``, ``await``, ``poll``/``tail``/``output`` après la fin)
    ou si la commande a été tuée par ``kill``.
    """

    def __init__(self, cmd: str, cwd: Optional[str] = None, message: Optional[str] = None):
        self.cmd = cmd
        self.argv = default_shell()
        self.powershell = _is_powershell(self.argv)
        self._buffer = bytearray()
        self._debut = 0  # absolute offset of _buffer[0]
        self._lu = 0  # absolute offset read by read()/poll()
        self._lock = threading.Lock()
        self._etat = threading.Lock()
        self._fini = threading.Event()
        self.exit_code: Optional[int] = None
        self._consomme = False
        self._tue = False
        self._signale = False
        self._job = None
        self.guet_id: Optional[str] = None
        options = dict(cwd=cwd or bridge.workspace_root(), stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
        if IS_WINDOWS:
            from axecode_kernel import _winjob

            self.proc, self._job = _winjob.lancer_dans_job(_argv(cmd), **options)
        else:
            self.proc = subprocess.Popen(_argv(cmd), **options)
        with _commandes_lock:
            _commandes.add(self)
        if not bridge.standalone():
            try:
                reponse = bridge.call("guet.fond", {"cmd": cmd, "message": message, "pid": self.proc.pid},
                                      timeout=30)
                self.guet_id = (reponse or {}).get("id")
            except Exception as exc:
                sys.stderr.write(f"[shell.start] pas de réveil à la fin de la commande : {exc}\n")
        self._pompe = threading.Thread(target=self._pump, name="axecode-commande", daemon=True)
        self._pompe.start()
        threading.Thread(target=self._veille, name="axecode-commande-fin", daemon=True).start()

    # -- sortie --
    def _pump(self) -> None:
        stream = self.proc.stdout
        while stream is not None:
            try:
                chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
            except (OSError, ValueError):
                break
            if not chunk:
                break
            with self._lock:
                self._buffer.extend(chunk)
                exces = len(self._buffer) - _BUFFER_MAX
                if exces > 0:
                    del self._buffer[:exces]
                    self._debut += exces

    def _veille(self) -> None:
        code = self.proc.wait()
        self._pompe.join(2.0)  # a grandchild may keep the pipe open
        self.exit_code = code
        self._fini.set()
        with _commandes_lock:
            _commandes.discard(self)
        if self._job is not None:
            from axecode_kernel import _winjob

            _winjob.fermer(self._job)  # kill-on-close: leftovers die with it
            self._job = None
        self._signaler()

    def _signaler(self) -> None:
        if self.guet_id is None or bridge.standalone():
            return
        from axecode_kernel import _asynchrone

        # The wake-up waits for the cell in progress: a cell that reads the
        # result (wait, await, poll) must win, and the message is delivered
        # at the end of the turn anyway.
        while _asynchrone.cellule_en_cours():
            time.sleep(0.1)
        with self._etat:
            signaler = not (self._consomme or self._tue)
            self._signale = signaler
        sortie = "\n".join(self._texte(0).splitlines()[-40:])[-3000:]
        try:
            if signaler:
                bridge.call("guet.signaler", {"id": self.guet_id, "code": self.exit_code,
                                               "sortie": sortie}, timeout=30)
            else:
                bridge.call("guet.annuler", {"id": self.guet_id}, timeout=30)
        except Exception:
            pass

    def _consommer(self) -> None:
        """Le résultat final a été lu : pas (ou plus) de réveil."""
        if not self._fini.is_set():
            return
        with self._etat:
            if self._consomme:
                return
            self._consomme = True
            retirer = self._signale
        if retirer and self.guet_id and not bridge.standalone():
            try:
                bridge.call("guet.annuler", {"id": self.guet_id}, timeout=30)
            except Exception:
                pass

    def _texte(self, depuis: int) -> str:
        with self._lock:
            start = max(depuis, self._debut) - self._debut
            return bytes(self._buffer[start:]).decode("utf-8", "replace")

    def output(self) -> str:
        """Toute la sortie gardée (le dernier Mo)."""
        self._consommer()
        return _clip(self._texte(0))

    def tail(self, n: int = 50) -> str:
        """Les ``n`` dernières lignes de la sortie."""
        self._consommer()
        return "\n".join(self._texte(0).splitlines()[-max(1, int(n)):])

    def read(self) -> str:
        """Sortie produite depuis le dernier ``read``/``poll``."""
        with self._lock:
            fin = self._debut + len(self._buffer)
        text = self._texte(self._lu)
        self._lu = fin
        self._consommer()
        return _clip(text)

    def poll(self) -> dict:
        """``{"alive", "exit_code", "output"}`` (sortie nouvelle depuis le dernier appel)."""
        alive = not self._fini.is_set()
        return {"alive": alive, "exit_code": None if alive else self.exit_code, "output": self.read()}

    # -- vie --
    @property
    def alive(self) -> bool:
        return not self._fini.is_set()

    def wait(self, timeout: Optional[float] = None) -> Optional[int]:
        """Attend la fin (``timeout`` secondes au plus) ; rend le code de sortie ou ``None``."""
        if not self._fini.wait(timeout):
            return None
        self._consommer()
        return self.exit_code

    def __await__(self):
        return self._attendre().__await__()

    async def _attendre(self) -> dict:
        import asyncio

        while not self._fini.is_set():
            await asyncio.sleep(0.05)
        self._consommer()
        return {"exit_code": self.exit_code, "output": self.output()}

    def kill(self) -> None:
        """Arrête la commande et tous ses descendants (pas de réveil)."""
        with self._etat:
            if not self._fini.is_set():
                self._tue = True
        if self._job is not None:
            from axecode_kernel import _winjob

            if _winjob.terminer(self._job):
                return
        if self.proc.poll() is None:
            _tuer_arbre(self.proc.pid)

    def close(self) -> None:
        self.kill()

    def send(self, cmd: str, timeout: Optional[float] = 120) -> dict:
        raise RuntimeError("shell.Commande n'accepte pas send() : utilisez shell.session()")

    def __repr__(self) -> str:
        etat = "en cours" if self.alive else f"finie, code {self.exit_code}"
        return f"<shell.Commande pid={self.proc.pid} {etat} : {self.cmd[:60]!r}>"


def _annoncer_mode_asynchrone() -> None:
    """Noyau asynchrone : le catalogue montre la poignée de ``start``."""
    from axecode_kernel import _asynchrone

    if not _asynchrone.enabled():
        return
    if "Commande" not in __all__:
        __all__.insert(__all__.index("start"), "Commande")
    start.__doc__ = (
        "Lance une commande de fond et rend une poignée ``Commande`` : ``h.tail(n)``, ``h.poll()``, "
        "``h.output()``, ``h.kill()`` (tout l'arbre), ``h.wait(timeout)`` ou ``await h``. "
        "À sa fin, la session est réveillée par un message <guet> (sauf si tu as déjà lu le "
        "résultat ou tué la commande) : inutile de boucler pour l'attendre."
    )


_annoncer_mode_asynchrone()


def _tuer_commandes() -> None:
    """Arrêt du noyau : toutes les commandes de fond meurent avec lui."""
    with _commandes_lock:
        restantes = list(_commandes)
    for commande in restantes:
        try:
            commande.kill()
        except Exception:
            pass

