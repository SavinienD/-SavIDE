"""Point d'entrée : ``python -m axecode_kernel``.

Commandes hôte → noyau (un objet JSON par ligne sur stdin) ::

    {"type": "init", "workspace": str, "modules": {name: {"enabled": bool,
        "functions": {fn: {"enabled": bool, "description": str}}}},
        "sys_path": [str], "session_id": str}
    {"type": "exec", "id": str, "code": str}
    {"type": "interrupt"}
    {"type": "snapshot", "id": str}            -> snapshot_result {data: b64,
        skipped: [{name, reason}]}  (ne bloque jamais : voir Kernel.snapshot)
    {"type": "restore", "id": str, "data": b64} -> restore_result {restored, failed,
        skipped: [{name, reason}]}
    {"type": "catalog", "id": str, "all": bool} -> catalog_result {modules}
    {"type": "configure", "id": str, "modules": {...}, "sys_path": [...]}
    {"type": "gc", "id": str, "keep": [str]}    -> gc_result {removed}
    {"type": "shutdown"}
    {"type": "host_result", ...}                 (voir bridge.py)

Noyau → hôte : ``ready``, ``stream``, ``file_change``, ``host_call``,
``done`` (résultat d'un exec) et les réponses ``*_result``.
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
    """Garde des poignées privées sur les vrais stdin/stdout, dirige le fd 1
    vers stderr et le fd 0 vers le périphérique nul.

    Les processus enfants héritent du fd 0 : sous Windows, un enfant qui
    hérite du tube du protocole bloque pendant que le fil de lecture l'attend
    (git, npm…), et partout un enfant ou un ``input()`` qui le lirait volerait
    des lignes du protocole. Renvoie le flux d'entrée privé du protocole."""
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
    """Remplaçant de stdout/stderr : diffuse vers l'hôte et accumule."""

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
    """Rencontrée en sérialisant une variable (directement ou imbriquée) : on
    la laisse de côté. BaseException pour qu'aucun ``except Exception`` du
    sérialiseur ne l'avale."""


class _LiveTypes:
    """Objets qui tiennent une ressource du système : processus, fil, fichier,
    tube, socket, boucle d'événements, exécuteur. Les sérialiser n'a pas de
    sens et peut bloquer pour de bon : dill vide et repositionne les fichiers
    et tubes ouverts, et le fil de lecture d'une ``shell.Session`` garde le
    verrou de son tube pendant qu'il attend la sortie (SCRAPPING, 20/10/2026 :
    l'instantané de fin de tour ne revenait jamais)."""

    IN_MEMORY = (io.StringIO, io.BytesIO)

    def __init__(self) -> None:
        import asyncio
        import concurrent.futures
        import socket
        import subprocess

        labels = [
            (subprocess.Popen, "subprocess.Popen (processus vivant)"),
            (threading.Thread, "threading.Thread"),
            (socket.socket, "socket"),
            (asyncio.AbstractEventLoop, "boucle d'événements asyncio"),
            (concurrent.futures.Executor, "exécuteur concurrent.futures"),
            (io.IOBase, "fichier ou tube ouvert"),
        ]
        try:
            from axecode_kernel import shell

            labels.insert(0, (shell.Session, "shell.Session (processus shell vivant)"))
        except Exception:  # pragma: no cover - broken shell module
            pass
        self.labels = labels
        self.types = tuple(kind for kind, _ in labels)

    def reason(self, value) -> "str | None":
        """Pourquoi ``value`` ne doit pas être sérialisée, ou None."""
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
    """Sérialise ``value`` (dill, recurse) dans un fil démon ; renvoie
    ``(blob, None)`` ou ``(None, raison)``. Abandonne après ``timeout``
    secondes : le fil est délaissé (il peut attendre pour toujours un verrou
    tenu par un autre fil) et l'instantané continue sans la variable."""
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
            box["reason"] = f"ressource vivante : {exc}"
        except BaseException as exc:
            box["reason"] = f"non sérialisable : {type(exc).__name__} : {exc}"[:300]

    worker = threading.Thread(target=work, name="axecode-snapshot", daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        return None, "délai dépassé"
    if "blob" in box:
        return box["blob"], None
    return None, box.get("reason") or "non sérialisable"


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
                sys.stderr.write(f"[axecode_kernel] impossible de charger {name} : {exc}\n")
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
                    error = "KeyboardInterrupt : exécution interrompue"
                else:
                    error = f"{type(exc).__name__}: {exc}"
        except KeyboardInterrupt:
            error = "KeyboardInterrupt : exécution interrompue"
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
        """Sérialise les variables de l'utilisateur sans jamais bloquer : les
        ressources vivantes sont laissées de côté, chaque variable a
        SNAPSHOT_VARIABLE_SECONDS et l'instantané entier SNAPSHOT_TOTAL_SECONDS.
        Renvoie ``{"data": b64, "skipped": [{"name", "reason"}]}`` ; ``skipped``
        est aussi gardé dans la charge utile."""
        import dill

        live = _LiveTypes()
        per_variable = _budget("AXECODE_SNAPSHOT_VARIABLE_SECONDS", SNAPSHOT_VARIABLE_SECONDS)
        total_budget = _budget("AXECODE_SNAPSHOT_TOTAL_SECONDS", SNAPSHOT_TOTAL_SECONDS)
        deadline = time.monotonic() + total_budget
        saved, skipped, total = {}, [], 0
        for key, value in self._user_items():
            blob, reason = None, live.reason(value)
            if reason:
                reason = f"ressource vivante : {reason}"
            else:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    reason = f"délai dépassé : budget de {total_budget:g} s de l'instantané épuisé"
                else:
                    blob, reason = _pickle_variable(dill, value, live, min(per_variable, remaining))
            if blob is not None and len(blob) > SNAPSHOT_MAX_VARIABLE_BYTES:
                blob, reason = None, f"trop gros ({len(blob)} octets sérialisés)"
            elif blob is not None and total + len(blob) > SNAPSHOT_MAX_BYTES:
                blob, reason = None, "taille maximale de l'instantané atteinte"
            if blob is None:
                skipped.append({"name": key, "reason": reason or "non sérialisable"})
                continue
            saved[key] = blob
            total += len(blob)
        modules = sorted(
            key for key, value in self.shell.user_ns.items()
            if not key.startswith("_") and key not in self.loaded
            and type(value).__name__ == "module"
        )
        for item in skipped:
            sys.stderr.write(f"[axecode_kernel] l'instantané laisse de côté {item['name']} : {item['reason']}\n")
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
                skipped.append({"name": str(name), "reason": reason or "non enregistré"})
        return {"restored": restored, "failed": failed, "skipped": skipped}

    def collect(self, keep) -> list[str]:
        """Supprime les variables de l'utilisateur absentes de ``keep`` (ramasse-miettes de la compaction)."""
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
    """Lit les lignes de l'hôte ; les résultats de l'hôte et les interruptions
    sont traités sur place pour fonctionner pendant que le fil principal
    exécute le code de l'utilisateur."""
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
    bridge.fail_all("l'hôte a fermé la connexion")
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
            _reply("error", message, ok=False, error=f"commande inconnue {kind}")
    except KeyboardInterrupt:
        _reply(f"{kind}_result", message, ok=False, error="interrompu")
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
