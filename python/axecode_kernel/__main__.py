"""Entry point: ``python -m axecode_kernel``.

Host → kernel commands (one JSON object per line on stdin)::

    {"type": "init", "workspace": str, "modules": {name: {"enabled": bool,
        "functions": {fn: {"enabled": bool, "description": str}}}},
        "sys_path": [str], "session_id": str}
    {"type": "exec", "id": str, "code": str}
    {"type": "interrupt"}
    {"type": "snapshot", "id": str}            -> snapshot_result {data: b64,
        skipped: [{name, reason}]}  (never hangs: see Kernel.snapshot)
    {"type": "restore", "id": str, "data": b64} -> restore_result {restored, failed,
        skipped: [{name, reason}]}
    {"type": "catalog", "id": str, "all": bool} -> catalog_result {modules}
    {"type": "configure", "id": str, "modules": {...}, "sys_path": [...]}
    {"type": "gc", "id": str, "keep": [str]}    -> gc_result {removed}
    {"type": "shutdown"}
    {"type": "host_result", ...}                 (see bridge.py)

Kernel → host: ``ready``, ``stream``, ``file_change``, ``host_call``,
``done`` (exec result) and the ``*_result`` replies.
"""

from __future__ import annotations

import base64
import gc
import io
import json
import os
import queue
import sys
import threading
import time
import traceback
import _thread

from axecode_kernel import bridge

MAX_CAPTURE = 2_000_000  # chars kept per stream per execution (host truncates further)
# The snapshot goes to the host as one line after every turn: variables over
# these sizes (pickled) are left out of it, like Prime's snapshot caps.
SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024
SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024
# A snapshot must never hang the end of a turn: the conversation would stay
# "running" and Stop would have no effect. Live resources are left out by
# type, each variable gets a time budget and so does the whole snapshot
# (AXECODE_SNAPSHOT_VARIABLE_SECONDS / AXECODE_SNAPSHOT_TOTAL_SECONDS override them).
SNAPSHOT_VARIABLE_SECONDS = 2.0
SNAPSHOT_TOTAL_SECONDS = 20.0

# Tool modules preloaded in the namespace, in prompt order.
MODULES = [
    "files", "shell", "web", "images", "context", "question", "todo", "cua",
    "skills", "mcp", "compact", "rlm", "messages", "harness", "refine",
    "goal", "heartbeat",
]


def _setup_protocol_stream():
    """Keeps private handles on the real stdin/stdout, points fd 1 to stderr
    and fd 0 to the null device.

    Child processes inherit fd 0: on Windows a child that inherits the
    protocol pipe blocks while the reader thread waits on it (git, npm...),
    and anywhere a child or ``input()`` reading it would steal protocol lines.
    Returns the private protocol input stream."""
    fd = os.dup(1)
    out = io.TextIOWrapper(os.fdopen(fd, "wb", buffering=0), encoding="utf-8",
                           newline="\n", write_through=True)
    try:
        os.dup2(2, 1)
    except OSError:
        pass
    bridge.install(out)
    protocol_in = os.dup(0)  # not inheritable (PEP 446)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    sys.stdin = open(os.devnull, "r", encoding="utf-8")  # input() -> EOFError
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    return io.TextIOWrapper(os.fdopen(protocol_in, "rb"), encoding="utf-8")


class _Capture(io.TextIOBase):
    """stdout/stderr replacement: streams to the host and accumulates."""

    def __init__(self, name: str):
        self.name = name
        self.parts: list[str] = []
        self.size = 0
        self.total = 0

    def writable(self) -> bool:
        return True

    def write(self, text) -> int:
        if not isinstance(text, str):
            text = str(text)
        if not text:
            return 0
        self.total += len(text)
        if self.size < MAX_CAPTURE:
            chunk = text[: MAX_CAPTURE - self.size]
            self.parts.append(chunk)
            self.size += len(chunk)
        bridge.emit({"type": "stream", "id": bridge.current_exec_id(),
                     "name": self.name, "text": text[:65536]})
        return len(text)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return False

    def value(self) -> str:
        return "".join(self.parts)


class _LiveResource(BaseException):
    """Met while pickling a variable (directly or nested): leave it out.
    BaseException so that no ``except Exception`` of the pickler swallows it."""


class _LiveTypes:
    """Objects that hold an OS resource: process, thread, file, pipe, socket,
    event loop, executor. Pickling them is meaningless and can block for good:
    dill flushes and seeks open files and pipes, and the reader thread of a
    ``shell.Session`` holds the lock of its pipe while it waits for output
    (SCRAPPING, 20/10/2026: the end-of-turn snapshot never returned)."""

    IN_MEMORY = (io.StringIO, io.BytesIO)

    def __init__(self) -> None:
        import asyncio
        import concurrent.futures
        import socket
        import subprocess

        labels = [
            (subprocess.Popen, "subprocess.Popen (live process)"),
            (threading.Thread, "threading.Thread"),
            (socket.socket, "socket"),
            (asyncio.AbstractEventLoop, "asyncio event loop"),
            (concurrent.futures.Executor, "concurrent.futures executor"),
            (io.IOBase, "open file or pipe"),
        ]
        try:
            from axecode_kernel import shell

            labels.insert(0, (shell.Session, "shell.Session (live shell process)"))
        except Exception:  # pragma: no cover - broken shell module
            pass
        self.labels = labels
        self.types = tuple(kind for kind, _ in labels)

    def reason(self, value) -> "str | None":
        """Why ``value`` must not be pickled, or None."""
        try:
            if not isinstance(value, self.types) or isinstance(value, self.IN_MEMORY):
                return None
        except Exception:  # odd proxies: let the pickler decide
            return None
        for kind, label in self.labels:
            if isinstance(value, kind):
                return label
        return None


def _budget(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


def _pickle_variable(dill, value, live: _LiveTypes, timeout: float):
    """Pickles ``value`` (dill, recurse) in a daemon thread; returns
    ``(blob, None)`` or ``(None, reason)``. Gives up after ``timeout`` seconds:
    the thread is abandoned (it may wait for good on a lock held by another
    thread) and the snapshot goes on without the variable."""
    box: dict = {}

    def refuse_live(obj):
        # Called by the pickler for every object, nested ones included.
        reason = live.reason(obj)
        if reason:
            raise _LiveResource(reason)
        return None

    def work() -> None:
        try:
            buffer = io.BytesIO()
            pickler = dill.Pickler(buffer, dill.settings["protocol"], recurse=True)
            pickler.persistent_id = refuse_live
            pickler.dump(value)
            box["blob"] = buffer.getvalue()
        except _LiveResource as exc:
            box["reason"] = f"live resource: {exc}"
        except BaseException as exc:
            box["reason"] = f"not picklable: {type(exc).__name__}: {exc}"[:300]

    worker = threading.Thread(target=work, name="axecode-snapshot", daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        return None, "timeout"
    if "blob" in box:
        return box["blob"], None
    return None, box.get("reason") or "not picklable"


class Kernel:
    def __init__(self) -> None:
        from IPython.core.interactiveshell import InteractiveShell

        try:
            self.shell = InteractiveShell.instance(colors="NoColor")
        except Exception:  # pragma: no cover - older/newer IPython
            self.shell = InteractiveShell.instance()
        for attr, value in (("colors", "NoColor"), ("autocall", 0), ("automagic", True)):
            try:
                setattr(self.shell, attr, value)
            except Exception:
                pass
        try:
            self.shell.run_line_magic("xmode", "Plain")
        except Exception:
            pass
        self._display_value: str | None = None
        hook = self.shell.displayhook
        hook.write_output_prompt = lambda: None

        def _write_format_data(format_dict, md_dict=None):
            self._display_value = format_dict.get("text/plain")

        hook.write_format_data = _write_format_data
        self.config: dict = {"modules": {}}
        self.loaded: list[str] = []
        self.commands: "queue.Queue[dict]" = queue.Queue()
        self.busy = False
        self.base_names: set[str] = set()

    # ----- modules ---------------------------------------------------------

    def _module_conf(self, name: str) -> dict:
        return (self.config.get("modules") or {}).get(name) or {}

    def _enabled(self, name: str) -> bool:
        return self._module_conf(name).get("enabled", True) is not False

    def load_modules(self) -> list[str]:
        import importlib

        ns = self.shell.user_ns
        for name in list(self.loaded):
            ns.pop(name, None)
        self.loaded = []
        for name in MODULES:
            if not self._enabled(name):
                continue
            try:
                module = importlib.import_module(f"axecode_kernel.{name}")
            except Exception as exc:  # module missing or broken: skip, report
                sys.stderr.write(f"[axecode_kernel] cannot load {name}: {exc}\n")
                continue
            functions = self._module_conf(name).get("functions") or {}
            for fn_name, fn_conf in functions.items():
                if not isinstance(fn_conf, dict) or not hasattr(module, fn_name):
                    continue
                if fn_conf.get("enabled", True) is False:
                    try:
                        delattr(module, fn_name)
                    except Exception:
                        pass
                elif fn_conf.get("description"):
                    try:
                        getattr(module, fn_name).__doc__ = fn_conf["description"]
                    except Exception:
                        pass
            ns[name] = module
            self.loaded.append(name)
        self.base_names = set(ns.keys())
        return self.loaded

    def apply_sys_path(self, paths) -> None:
        for path in paths or []:
            if path and path not in sys.path:
                sys.path.insert(0, path)

    # ----- execution -------------------------------------------------------

    def execute(self, exec_id: str, code: str) -> dict:
        out, err = _Capture("stdout"), _Capture("stderr")
        saved = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = out, err
        bridge.set_exec_id(exec_id)
        self._display_value = None
        started = time.time()
        error = None
        try:
            result = self.shell.run_cell(code, store_history=True, silent=False)
            exc = result.error_before_exec or result.error_in_exec
            if exc is not None:
                if isinstance(exc, KeyboardInterrupt):
                    error = "KeyboardInterrupt: execution interrupted"
                else:
                    error = f"{type(exc).__name__}: {exc}"
        except KeyboardInterrupt:
            error = "KeyboardInterrupt: execution interrupted"
        except BaseException as exc:  # never let the kernel die on user code
            error = f"{type(exc).__name__}: {exc}"
            err.write(traceback.format_exc())
        finally:
            sys.stdout, sys.stderr = saved
            bridge.set_exec_id(None)
        images, changes = bridge.take_attachments()
        return {
            "type": "done",
            "id": exec_id,
            "stdout": out.value(),
            "stderr": err.value(),
            "stdout_total": out.total,
            "stderr_total": err.total,
            "value": self._display_value,
            "error": error,
            "images": images,
            "file_changes": changes,
            "duration_ms": int((time.time() - started) * 1000),
        }

    # ----- catalog ---------------------------------------------------------

    def catalog(self, include_disabled: bool) -> list[dict]:
        import importlib
        import inspect

        modules = []
        for name in MODULES:
            enabled = self._enabled(name)
            if not enabled and not include_disabled:
                continue
            try:
                module = importlib.import_module(f"axecode_kernel.{name}")
            except Exception:
                continue
            exported = getattr(module, "__all__", None) or [
                n for n, v in vars(module).items()
                if not n.startswith("_") and callable(v)
                and getattr(v, "__module__", None) == module.__name__
            ]
            functions = []
            fn_conf = self._module_conf(name).get("functions") or {}
            for fn_name in exported:
                fn = getattr(module, fn_name, None)
                conf = fn_conf.get(fn_name) or {}
                if fn is None and conf.get("enabled", True) is not False:
                    continue
                try:
                    signature = f"{fn_name}{inspect.signature(fn)}" if fn else fn_name
                except (TypeError, ValueError):
                    signature = fn_name
                doc = conf.get("description") or inspect.getdoc(fn) or ""
                functions.append({
                    "name": fn_name,
                    "signature": signature,
                    "doc": doc,
                    "default_doc": (inspect.getdoc(fn) if fn else "") or "",
                    "enabled": conf.get("enabled", True) is not False,
                })
            modules.append({
                "name": name,
                "doc": self._module_conf(name).get("description") or inspect.getdoc(module) or "",
                "default_doc": inspect.getdoc(module) or "",
                "enabled": enabled,
                "functions": functions,
            })
        return modules

    # ----- snapshot / gc ---------------------------------------------------

    def _user_items(self):
        import types

        ns = self.shell.user_ns
        hidden = set(getattr(self.shell, "user_ns_hidden", {}) or {})
        for key, value in list(ns.items()):
            if key.startswith("_") or key in hidden or key in self.loaded:
                continue
            if key in ("In", "Out", "exit", "quit", "get_ipython"):
                continue
            if isinstance(value, types.ModuleType):
                continue
            yield key, value

    def snapshot(self) -> dict:
        """Pickles the user variables and never hangs: live resources are left
        out, each variable gets SNAPSHOT_VARIABLE_SECONDS and the whole
        snapshot SNAPSHOT_TOTAL_SECONDS. Returns ``{"data": b64, "skipped":
        [{"name", "reason"}]}``; ``skipped`` is also kept in the payload."""
        import dill

        live = _LiveTypes()
        per_variable = _budget("AXECODE_SNAPSHOT_VARIABLE_SECONDS", SNAPSHOT_VARIABLE_SECONDS)
        total_budget = _budget("AXECODE_SNAPSHOT_TOTAL_SECONDS", SNAPSHOT_TOTAL_SECONDS)
        deadline = time.monotonic() + total_budget
        saved, skipped, total = {}, [], 0
        for key, value in self._user_items():
            blob, reason = None, live.reason(value)
            if reason:
                reason = f"live resource: {reason}"
            else:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    reason = f"timeout: snapshot budget of {total_budget:g} s spent"
                else:
                    blob, reason = _pickle_variable(dill, value, live, min(per_variable, remaining))
            if blob is not None and len(blob) > SNAPSHOT_MAX_VARIABLE_BYTES:
                blob, reason = None, f"too large ({len(blob)} bytes pickled)"
            elif blob is not None and total + len(blob) > SNAPSHOT_MAX_BYTES:
                blob, reason = None, "snapshot size limit reached"
            if blob is None:
                skipped.append({"name": key, "reason": reason or "not picklable"})
                continue
            saved[key] = blob
            total += len(blob)
        modules = sorted(
            key for key, value in self.shell.user_ns.items()
            if not key.startswith("_") and key not in self.loaded
            and type(value).__name__ == "module"
        )
        for item in skipped:
            sys.stderr.write(f"[axecode_kernel] snapshot leaves out {item['name']}: {item['reason']}\n")
        payload = {"vars": saved, "modules": {k: self.shell.user_ns[k].__name__ for k in modules},
                   "skipped": skipped}
        return {"data": base64.b64encode(dill.dumps(payload)).decode("ascii"), "skipped": skipped}

    def restore(self, data: str) -> dict:
        import dill
        import importlib

        payload = dill.loads(base64.b64decode(data))
        ns = self.shell.user_ns
        restored, failed = [], []
        for alias, module_name in (payload.get("modules") or {}).items():
            try:
                ns[alias] = importlib.import_module(module_name)
            except Exception:
                failed.append(alias)
        for key, blob in (payload.get("vars") or {}).items():
            try:
                ns[key] = dill.loads(blob)
                restored.append(key)
            except Exception:
                failed.append(key)
        # Names left out of the snapshot (live resources, too big, not
        # picklable, timeout) are lost too.
        skipped = []
        for item in payload.get("skipped") or []:
            if isinstance(item, dict):
                name, reason = item.get("name"), item.get("reason")
            else:  # snapshots made before reasons were recorded
                name, reason = item, None
            if name:
                failed.append(str(name))
                skipped.append({"name": str(name), "reason": reason or "not saved"})
        return {"restored": restored, "failed": failed, "skipped": skipped}

    def collect(self, keep) -> list[str]:
        """Drops user variables not listed in ``keep`` (compaction collector)."""
        keep = set(keep or [])
        removed = []
        for key, _ in list(self._user_items()):
            if key not in keep:
                self.shell.user_ns.pop(key, None)
                removed.append(key)
        try:
            self.shell.history_manager.output_hist.clear()
            self.shell.user_ns.get("Out", {}).clear()
        except Exception:
            pass
        gc.collect()
        return removed


def _reader(kernel: Kernel, stream) -> None:
    """Reads host lines; host results and interrupts are handled inline so
    that they work while the main thread is executing user code."""
    for raw in stream:
        raw = raw.strip()
        if not raw:
            continue
        try:
            message = json.loads(raw)
        except ValueError:
            continue
        kind = message.get("type")
        if kind == "host_result":
            bridge.resolve(message)
        elif kind == "interrupt":
            if kernel.busy:
                _thread.interrupt_main()
        else:
            kernel.commands.put(message)
    bridge.fail_all("host closed the connection")
    kernel.commands.put({"type": "shutdown"})


def _reply(kind: str, message: dict, **fields) -> None:
    bridge.emit({"type": kind, "id": message.get("id"), **fields})


def _handle(kernel: Kernel, message: dict) -> bool:
    kind = message.get("type")
    try:
        if kind == "exec":
            kernel.busy = True
            try:
                bridge.emit(kernel.execute(str(message.get("id")), message.get("code") or ""))
            finally:
                kernel.busy = False
        elif kind in ("init", "configure"):
            if message.get("workspace"):
                os.environ["AXECODE_WORKSPACE"] = message["workspace"]
                try:
                    os.chdir(message["workspace"])
                except OSError:
                    pass
            if message.get("session_id"):
                os.environ["AXECODE_SESSION_ID"] = message["session_id"]
            if "modules" in message:
                kernel.config["modules"] = message.get("modules") or {}
            kernel.apply_sys_path(message.get("sys_path"))
            loaded = kernel.load_modules()
            _reply(f"{kind}_result", message, ok=True, modules=loaded)
        elif kind == "catalog":
            _reply("catalog_result", message, ok=True,
                   modules=kernel.catalog(bool(message.get("all"))))
        elif kind == "snapshot":
            _reply("snapshot_result", message, ok=True, **kernel.snapshot())
        elif kind == "restore":
            _reply("restore_result", message, ok=True, **kernel.restore(message.get("data") or ""))
        elif kind == "gc":
            _reply("gc_result", message, ok=True, removed=kernel.collect(message.get("keep")))
        elif kind == "shutdown":
            return False
        else:
            _reply("error", message, ok=False, error=f"unknown command {kind}")
    except KeyboardInterrupt:
        _reply(f"{kind}_result", message, ok=False, error="interrupted")
    except BaseException as exc:
        _reply(f"{kind}_result", message, ok=False, error=f"{type(exc).__name__}: {exc}")
    return True


def main() -> int:
    protocol_in = _setup_protocol_stream()
    pkg_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if pkg_parent not in sys.path:
        sys.path.insert(0, pkg_parent)
    kernel = Kernel()
    threading.Thread(target=_reader, args=(kernel, protocol_in), daemon=True).start()
    import IPython

    bridge.emit({"type": "ready", "pid": os.getpid(), "python": sys.version.split()[0],
                 "ipython": IPython.__version__})
    while True:
        try:
            message = kernel.commands.get()
            if not _handle(kernel, message):
                break
        except KeyboardInterrupt:
            # Interrupt arrived between two commands: ignore.
            continue
    return 0


if __name__ == "__main__":
    sys.exit(main())
