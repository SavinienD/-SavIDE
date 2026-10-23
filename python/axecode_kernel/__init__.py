"""axecode_kernel — the persistent Python REPL that powers Axecode's agent.

The package is started as ``python -m axecode_kernel`` by the Rust worker
(``crates/axecode-repl``). It hosts an IPython ``InteractiveShell`` driven by a
JSON-lines protocol on stdin/stdout:

* Rust → kernel: ``init``, ``exec``, ``interrupt``, ``snapshot``, ``restore``,
  ``catalog``, ``configure``, ``gc``, ``shutdown`` and ``host_result``.
* kernel → Rust: ``ready``, ``stream``, ``file_change``, ``image``, ``done``,
  ``host_call`` and the ``*_result`` replies.

Every public module in this package (``files``, ``shell``, ``web``, ...) is a
tool exposed to the model inside the kernel namespace. Their docstrings are
the documentation shown to the model, so keep them short and precise.
"""

__version__ = "0.1.0"
