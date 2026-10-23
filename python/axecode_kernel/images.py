"""images — generate images and look at image files.

``read(path)`` attaches an image to the result of the current cell so that
you can see it (downscaled to at most 1600 px, re-encoded as JPEG when large).
``generate(prompt, path=None)`` creates an image with the configured image
provider and saves it in the workspace.
"""

from __future__ import annotations

import base64
import io
import mimetypes
import os
from typing import Optional

from axecode_kernel import bridge

__all__ = ["read", "generate", "show"]

MAX_SIDE = 1600
MAX_BYTES = 1_500_000


def _shrink(data: bytes, media_type: str) -> tuple[bytes, str]:
    try:
        from PIL import Image  # optional dependency
    except Exception:
        return data, media_type
    try:
        image = Image.open(io.BytesIO(data))
        if max(image.size) <= MAX_SIDE and len(data) <= MAX_BYTES:
            return data, media_type
        image.thumbnail((MAX_SIDE, MAX_SIDE))
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        out = io.BytesIO()
        image.save(out, format="JPEG", quality=85)
        return out.getvalue(), "image/jpeg"
    except Exception:
        return data, media_type


def read(path: str) -> str:
    """Attach the image at ``path`` to this cell's result (you will see it)."""
    full = path if os.path.isabs(path) else os.path.join(bridge.workspace_root(), path)
    with open(full, "rb") as handle:
        data = handle.read()
    media_type = mimetypes.guess_type(full)[0] or "image/png"
    data, media_type = _shrink(data, media_type)
    bridge.emit_image(media_type, base64.b64encode(data).decode("ascii"), path)
    return f"attached {path} ({len(data)} bytes, {media_type})"


def show(data: bytes, media_type: str = "image/png") -> str:
    """Attach raw image bytes (e.g. a matplotlib PNG) to this cell's result."""
    data, media_type = _shrink(data, media_type)
    bridge.emit_image(media_type, base64.b64encode(data).decode("ascii"), None)
    return f"attached image ({len(data)} bytes)"


def generate(prompt: str, path: Optional[str] = None, size: Optional[str] = None) -> dict:
    """Generate an image from ``prompt``; returns ``{"content", "images"}``."""
    params = {"prompt": prompt}
    if path:
        params["path"] = path
    if size:
        params["size"] = size
    return bridge.call("images.generate", params)
