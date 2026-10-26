"""images — générer des images et regarder des fichiers image.

``read(path)`` joint une image au résultat de la cellule en cours pour que
vous puissiez la voir (réduite à 1600 px au plus, réencodée en JPEG si elle
est lourde). ``generate(prompt, path=None)`` crée une image avec le
fournisseur d'images configuré et l'enregistre à ``path`` (relatif au dossier
de travail, ou absolu ; l'extension est ajoutée si besoin, ``-1``, ``-2``…
s'il y a plusieurs images, sans aucune copie ailleurs), sinon dans le dossier de
données de l'appli (jamais dans le projet).
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
    """Joint l'image ``path`` au résultat de cette cellule (vous la verrez)."""
    full = path if os.path.isabs(path) else os.path.join(bridge.workspace_root(), path)
    with open(full, "rb") as handle:
        data = handle.read()
    media_type = mimetypes.guess_type(full)[0] or "image/png"
    data, media_type = _shrink(data, media_type)
    bridge.emit_image(media_type, base64.b64encode(data).decode("ascii"), path)
    return f"{path} joint ({len(data)} octets, {media_type})"


def show(data: bytes, media_type: str = "image/png") -> str:
    """Joint les octets bruts d'une image (par ex. un PNG matplotlib) au résultat de cette cellule."""
    data, media_type = _shrink(data, media_type)
    bridge.emit_image(media_type, base64.b64encode(data).decode("ascii"), None)
    return f"image jointe ({len(data)} octets)"


def generate(prompt: str, path: Optional[str] = None, size: Optional[str] = None) -> dict:
    """Génère une image d'après ``prompt`` ; renvoie ``{"content", "images"}``."""
    params = {"prompt": prompt}
    if path:
        params["path"] = path
    if size:
        params["size"] = size
    return bridge.call("images.generate", params)
