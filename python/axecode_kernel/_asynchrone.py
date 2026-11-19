"""Noyau asynchrone (réglage ``kernelAsync``, lot D2 ; voir docs/noyau-asynchrone.md).

Éteint par défaut : ``__main__`` garde alors son chemin synchrone d'avant.
Allumé (``AXECODE_KERNEL_ASYNC=1``, posé par l'hôte d'après le réglage), le fil
principal fait tourner UNE boucle asyncio pour toute la vie du noyau :

- chaque cellule est une tâche de cette boucle (``await`` au premier niveau) et
  les tâches qu'elle lance continuent entre deux cellules ;
- ``sys.stdout``/``sys.stderr`` deviennent des aiguilleurs : une écriture va à
  la cellule de son contexte (variable de contexte héritée par les tâches),
  sinon à la cellule en cours ; la sortie d'une cellule déjà finie est gardée
  et rendue au modèle en tête de la cellule suivante ;
- l'interruption distingue la cellule qui exécute du code (``KeyboardInterrupt``)
  de la cellule qui attend un ``await`` (sa tâche est annulée).
"""

from __future__ import annotations

import asyncio
import contextvars
import io
import os
import queue
import signal
import sys
import threading
import time
import traceback
import _thread

from axecode_kernel import bridge

MAX_CAPTURE = 2_000_000
INTERRUPTED = "KeyboardInterrupt : exécution interrompue"
_TRUE = ("1", "true", "yes", "on", "oui")


_STATE: "State | None" = None


def cellule_en_cours() -> bool:
    """Vrai pendant l'exécution d'une cellule (noyau asynchrone)."""
    return _STATE is not None and _STATE.running is not None


def enabled() -> bool:
    """Vrai quand le noyau tourne en mode asynchrone."""
    return os.environ.get("AXECODE_KERNEL_ASYNC", "").strip().lower() in _TRUE


_cell: "contextvars.ContextVar[Cell | None]" = contextvars.ContextVar("axecode_cell", default=None)


class _Buffer:
    def __init__(self) -> None:
        self.parts: list[str] = []
        self.size = 0
        self.total = 0

    def add(self, text: str) -> None:
        self.total += len(text)
        if self.size < MAX_CAPTURE:
            chunk = text[: MAX_CAPTURE - self.size]
            self.parts.append(chunk)
            self.size += len(chunk)

    def value(self) -> str:
        return "".join(self.parts)


class Cell:
    """Sortie d'une cellule ; ``finished`` une fois son résultat rendu."""

    def __init__(self, exec_id: str) -> None:
        self.exec_id = exec_id
        self.finished = False
        self.out = {"stdout": _Buffer(), "stderr": _Buffer()}


class State:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.running: Cell | None = None
        self.cell_task: "asyncio.Task | None" = None
        # exec_id -> {"stdout": _Buffer, "stderr": _Buffer}: written after the
        # cell finished (its background tasks), given to the next cell.
        self.late: dict[str, dict[str, _Buffer]] = {}
        self.lock = threading.Lock()

    def add_late(self, cell: Cell, name: str, text: str) -> None:
        with self.lock:
            slot = self.late.setdefault(cell.exec_id, {"stdout": _Buffer(), "stderr": _Buffer()})
            slot[name].add(text)

    def take_late(self) -> tuple[str, str]:
        with self.lock:
            late, self.late = self.late, {}
        parts = {"stdout": [], "stderr": []}
        for exec_id, slot in late.items():
            for name, buffer in slot.items():
                text = buffer.value()
                if not text:
                    continue
                if not text.endswith("\n"):
                    text += "\n"
                parts[name].append(f"[sortie de fond de la cellule {exec_id}]\n{text}")
        return "".join(parts["stdout"]), "".join(parts["stderr"])


class Router(io.TextIOBase):
    """``sys.stdout``/``sys.stderr`` du mode asynchrone."""

    def __init__(self, state: State, name: str, fallback) -> None:
        self.state = state
        self.name = name
        self.fallback = fallback

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def flush(self) -> None:
        pass

    def write(self, text) -> int:
        if not isinstance(text, str):
            text = str(text)
        if not text:
            return 0
        cell = _cell.get() or self.state.running
        if cell is None:
            # Nothing runs (kernel diagnostics, a thread between cells): the
            # real stream, as in the synchronous kernel.
            try:
                self.fallback.write(text)
                self.fallback.flush()
            except Exception:
                pass
            return len(text)
        if cell.finished:
            self.state.add_late(cell, self.name, text)
        else:
            cell.out[self.name].add(text)
        for start in range(0, len(text), 65536):
            bridge.emit({"type": "stream", "id": cell.exec_id, "name": self.name,
                         "text": text[start:start + 65536]})
        return len(text)


async def execute(kernel, state: State, exec_id: str, code: str) -> dict:
    """Exécute une cellule comme tâche de la boucle ; même réponse ``done`` que
    ``Kernel.execute``."""
    cell = Cell(exec_id)
    _cell.set(cell)  # this task's context: inherited by the tasks it creates
    bridge.set_task_exec_id(exec_id)
    state.running = cell
    bridge.set_exec_id(exec_id)
    kernel._display_value = None
    started = time.time()
    error = None
    shell = kernel.shell
    try:
        preprocessing = None
        try:
            transformed = shell.transform_cell(code)
        except Exception:
            transformed, preprocessing = code, sys.exc_info()
        result = await shell.run_cell_async(
            code, store_history=True, silent=False,
            transformed_cell=transformed, preprocessing_exc_tuple=preprocessing,
        )
        exc = result.error_before_exec or result.error_in_exec
        if exc is not None:
            if isinstance(exc, (KeyboardInterrupt, asyncio.CancelledError)):
                error = INTERRUPTED
            else:
                error = f"{type(exc).__name__}: {exc}"
    except (KeyboardInterrupt, asyncio.CancelledError):
        error = INTERRUPTED
    except BaseException as exc:  # never let the kernel die on user code
        error = f"{type(exc).__name__}: {exc}"
        cell.out["stderr"].add(traceback.format_exc())
    finally:
        cell.finished = True
        if state.running is cell:
            state.running = None
        bridge.set_exec_id(None)
    late_out, late_err = state.take_late()
    images, changes = bridge.take_attachments()
    out, err = cell.out["stdout"], cell.out["stderr"]
    return {
        "type": "done",
        "id": exec_id,
        "stdout": late_out + out.value(),
        "stderr": late_err + err.value(),
        "stdout_total": len(late_out) + out.total,
        "stderr_total": len(late_err) + err.total,
        "value": kernel._display_value,
        "error": error,
        "images": images,
        "file_changes": changes,
        "duration_ms": int((time.time() - started) * 1000),
    }


def _install_sigint(state: State) -> None:
    def handler(signum, frame):
        task = state.cell_task
        if task is None or task.done():
            return
        try:
            current = asyncio.current_task(state.loop)
        except RuntimeError:
            current = None
        if current is task:
            # The cell is executing code: interrupt it where it is.
            raise KeyboardInterrupt
        # The cell waits at an `await` (loop idle) or another task holds the
        # only thread: cancel the cell; a background task blocked in
        # synchronous code gets the interrupt too, or the cancel never runs.
        task.cancel()
        if current is not None:
            raise KeyboardInterrupt

    signal.signal(signal.SIGINT, handler)


def interrupt(state: State) -> None:
    """Appelé par le fil de lecture quand l'hôte demande une interruption."""
    # Same delivery as the synchronous kernel (a code blocked outside Python
    # is left to the host, which kills the kernel after its grace delay).
    _thread.interrupt_main()
    try:
        state.loop.call_soon_threadsafe(lambda: None)  # wake the selector
    except RuntimeError:
        pass


async def _serve(kernel, state: State, inbox: "asyncio.Queue[dict]", handle) -> None:
    while True:
        message = await inbox.get()
        if message.get("type") != "exec":
            try:
                keep_going = handle(kernel, message)
            except KeyboardInterrupt:
                keep_going = True
            if not keep_going:
                return
            continue
        exec_id = str(message.get("id"))
        code = message.get("code") or ""
        task = state.loop.create_task(execute(kernel, state, exec_id, code),
                                      context=contextvars.copy_context())
        state.cell_task = task
        kernel.busy = True
        try:
            reply = await task
        except BaseException as exc:  # interrupt landed outside the cell's code
            reply = {"type": "done", "id": exec_id, "stdout": "", "stderr": "",
                     "stdout_total": 0, "stderr_total": 0, "value": None,
                     "error": INTERRUPTED if isinstance(exc, (KeyboardInterrupt, asyncio.CancelledError))
                     else f"{type(exc).__name__}: {exc}",
                     "images": [], "file_changes": [], "duration_ms": 0}
        finally:
            kernel.busy = False
            state.cell_task = None
        bridge.emit(reply)


def run(kernel, handle) -> int:
    """Boucle principale du mode asynchrone (remplace celle de ``__main__``).
    ``handle(kernel, message)`` traite les commandes autres que ``exec``."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    global _STATE
    state = State(loop)
    _STATE = state
    inbox: "asyncio.Queue[dict]" = asyncio.Queue()

    def put(message: dict) -> None:
        try:
            loop.call_soon_threadsafe(inbox.put_nowait, message)
        except RuntimeError:  # loop closed: the kernel is stopping
            pass

    with kernel._put_lock:
        # Commands that arrived before the loop (init) go first, in order.
        while True:
            try:
                inbox.put_nowait(kernel.commands.get_nowait())
            except queue.Empty:
                break
        kernel._async_put = put
    kernel.interrupt = lambda: interrupt(state)
    kernel.async_state = state
    sys.stdout = Router(state, "stdout", sys.__stderr__ or sys.stderr)
    sys.stderr = Router(state, "stderr", sys.__stderr__ or sys.stderr)
    if os.name == "nt":
        try:
            from axecode_kernel import _winjob

            _winjob.contenir_noyau()
        except Exception:
            traceback.print_exc(file=sys.__stderr__)
    _install_sigint(state)
    serve = loop.create_task(_serve(kernel, state, inbox, handle))
    while not serve.done():
        try:
            loop.run_until_complete(serve)
        except KeyboardInterrupt:
            # Raised in a background task (it dies with it) or between two
            # steps: the loop goes on.
            continue
        except BaseException:
            traceback.print_exc(file=sys.__stderr__)
            break
    try:
        from axecode_kernel import shell

        shell._tuer_commandes()
    except Exception:
        pass
    for task in asyncio.all_tasks(loop):
        task.cancel()
    try:
        loop.run_until_complete(asyncio.sleep(0))
    except BaseException:
        pass
    return 0

