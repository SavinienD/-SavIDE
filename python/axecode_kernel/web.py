"""web — search the web and fetch pages.

``search(query)`` returns ranked results (title, url, snippet) as text;
``fetch(url)`` returns the readable content of a page (HTML converted to
text/markdown). Both go through the IDE's configured web provider.
"""

from __future__ import annotations

from typing import Optional

from axecode_kernel import bridge

__all__ = ["search", "fetch"]


def search(query: str, max_results: Optional[int] = None) -> str:
    """Search the web; returns the provider's formatted results."""
    params = {"query": query}
    if max_results:
        params["max_results"] = int(max_results)
    return bridge.call("web.search", params)["content"]


def fetch(url: str, prompt: Optional[str] = None) -> str:
    """Fetch a URL and return its readable content."""
    params = {"url": url}
    if prompt:
        params["prompt"] = prompt
    return bridge.call("web.fetch", params)["content"]
