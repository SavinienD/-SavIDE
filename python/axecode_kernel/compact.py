"""compact — compact this session's context.

``run(directive=None)`` asks for a compaction before the next model call:
the history is summarised (honouring the optional ``directive``), the full
journal stays available through ``context``, and kernel variables are kept.
Use it when the context grows large or before a long new phase of work.
"""

from __future__ import annotations

from typing import Optional

from axecode_kernel import bridge

__all__ = ["run"]


def run(directive: Optional[str] = None) -> str:
    """Schedule a compaction (applied before the next model call)."""
    result = bridge.call("compact.request", {"directive": directive})
    return result.get("note", "compaction scheduled")
