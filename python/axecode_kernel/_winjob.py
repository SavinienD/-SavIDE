"""Job Objects Windows (noyau asynchrone, lot D2) : arrêter tout un arbre de
processus, petits-enfants orphelins compris.

- ``contenir_noyau()`` : le noyau se place dans un job « tuer à la fermeture » ;
  quand l'hôte le tue, Windows ferme son dernier handle du job et arrête tout ce
  qu'il a lancé. ``JOB_OBJECT_LIMIT_BREAKAWAY_OK`` laisse sortir un programme
  créé exprès avec ``CREATE_BREAKAWAY_FROM_JOB``.
- ``lancer_dans_job(argv, ...)`` : une commande de fond créée suspendue, placée
  dans son propre job, puis relancée (aucun enfant ne naît hors du job) ;
  ``terminer(job)`` l'arrête avec tous ses descendants.

ctypes seulement ; hors Windows ou en cas d'échec, les fonctions rendent
``None``/``False`` et l'appelant se rabat sur psutil / taskkill.
"""

from __future__ import annotations

import ctypes
import os
import subprocess
from typing import Optional

JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_EXTENDED_LIMIT_INFORMATION = 9
CREATE_SUSPENDED = 0x0000_0004
CREATE_NO_WINDOW = 0x0800_0000

_noyau_job = None  # kept open for the whole life of the kernel


def disponible() -> bool:
    return os.name == "nt"


class _Basic(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.c_uint32), ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t), ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _Io(ctypes.Structure):
    _fields_ = [(n, ctypes.c_uint64) for n in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class _Extended(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _Basic), ("IoInfo", _Io),
        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


_api = None


def _k32():
    global _api
    if _api is None:
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        ntdll = ctypes.WinDLL("ntdll")
        h, b = wintypes.HANDLE, wintypes.BOOL
        k32.CreateJobObjectW.argtypes, k32.CreateJobObjectW.restype = [wintypes.LPVOID, wintypes.LPCWSTR], h
        k32.SetInformationJobObject.argtypes = [h, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
        k32.SetInformationJobObject.restype = b
        k32.AssignProcessToJobObject.argtypes, k32.AssignProcessToJobObject.restype = [h, h], b
        k32.TerminateJobObject.argtypes, k32.TerminateJobObject.restype = [h, wintypes.UINT], b
        k32.CloseHandle.argtypes, k32.CloseHandle.restype = [h], b
        k32.GetCurrentProcess.argtypes, k32.GetCurrentProcess.restype = [], h
        ntdll.NtResumeProcess.argtypes, ntdll.NtResumeProcess.restype = [h], ctypes.c_long
        _api = (k32, ntdll)
    return _api


def creer_job(breakaway_ok: bool = False) -> Optional[int]:
    """Nouveau job « tuer à la fermeture » ; ``None`` en cas d'échec."""
    if not disponible():
        return None
    try:
        k32, _ = _k32()
        job = k32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = _Extended()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | (
            JOB_OBJECT_LIMIT_BREAKAWAY_OK if breakaway_ok else 0)
        if not k32.SetInformationJobObject(job, _EXTENDED_LIMIT_INFORMATION,
                                           ctypes.byref(info), ctypes.sizeof(info)):
            k32.CloseHandle(job)
            return None
        return job
    except Exception:
        return None


def assigner(job, process_handle) -> bool:
    try:
        k32, _ = _k32()
        return bool(k32.AssignProcessToJobObject(job, int(process_handle)))
    except Exception:
        return False


def terminer(job) -> bool:
    """Arrête tous les processus du job."""
    if not job:
        return False
    try:
        k32, _ = _k32()
        return bool(k32.TerminateJobObject(job, 1))
    except Exception:
        return False


def fermer(job) -> None:
    if job:
        try:
            _k32()[0].CloseHandle(job)
        except Exception:
            pass


def contenir_noyau() -> bool:
    """Place le noyau (processus courant) dans un job « tuer à la fermeture »."""
    global _noyau_job
    if _noyau_job is not None or not disponible():
        return _noyau_job is not None
    job = creer_job(breakaway_ok=True)
    if job is None:
        return False
    k32, _ = _k32()
    if not k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()):
        fermer(job)
        return False
    _noyau_job = job
    return True


def lancer_dans_job(argv, **popen) -> "tuple[subprocess.Popen, Optional[int]]":
    """Lance ``argv`` suspendu, le met dans un job neuf, puis le relance.
    Rend ``(processus, job)`` ; ``job`` vaut ``None`` si le confinement a
    échoué (le processus tourne quand même : l'appelant tue alors l'arbre par
    psutil/taskkill)."""
    flags = popen.pop("creationflags", 0) | CREATE_SUSPENDED | CREATE_NO_WINDOW
    proc = subprocess.Popen(argv, creationflags=flags, **popen)
    job = creer_job()
    handle = getattr(proc, "_handle", None)
    if job is not None and (handle is None or not assigner(job, handle)):
        fermer(job)
        job = None
    try:
        _, ntdll = _k32()
        if handle is None or ntdll.NtResumeProcess(int(handle)) != 0:
            raise OSError("NtResumeProcess a échoué")
    except Exception:
        if job is not None:
            terminer(job)
            fermer(job)
        proc.kill()
        raise
    return proc, job
