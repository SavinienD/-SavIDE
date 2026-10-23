// axe:viewers — renders untrusted document HTML (docx, epub, pptx text,
// notebook outputs) safely: the markup is sanitized, then shown in an iframe
// sandboxed WITHOUT scripts. `allow-same-origin` only lets this component
// style the page, intercept links (opened in the system browser) and run the
// search highlighting; the document itself can never execute code. A CSP
// also blocks any network fetch (tracking pixels, remote fonts).

import { useEffect, useMemo, useRef } from "react";
import { api } from "../../lib/ipc";

const DROP_TAGS =
  "script,iframe,frame,frameset,object,embed,applet,link,meta,base,form,input,button,select,textarea,noscript,template,style,svg script,portal";
const URL_ATTRS = ["href", "src", "xlink:href", "poster", "srcset", "action", "formaction", "background"];
const SAFE_URL = /^(https?:|mailto:|#|data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);|blob:)/i;

/** Allow-list sanitizer working on an inert DOMParser document. */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(DROP_TAGS).forEach((node) => node.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || name === "srcdoc") {
        el.removeAttribute(attr.name);
      } else if (URL_ATTRS.includes(name)) {
        const value = attr.value.trim();
        if (name === "srcset" || !SAFE_URL.test(value)) el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

function themeCss(): string {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const bg = v("--editor-bg", v("--bg-0", "#0b0b0d"));
  return `
    :root { color-scheme: dark; }
    html, body { margin: 0; background: ${bg}; color: ${v("--text-1", "#d4d4d8")}; }
    body { font: 14px/1.65 ${v("--font-ui", "system-ui, sans-serif")}; padding: 28px 40px 48px;
      max-width: 860px; margin: 0 auto; word-wrap: break-word; }
    h1, h2, h3, h4, h5, h6 { color: ${v("--text-0", "#fafafa")}; line-height: 1.3; margin: 1.4em 0 .5em; }
    a { color: ${v("--accent", "#fc610b")}; }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; margin: 12px 0; font-size: 13px; }
    th, td { border: 1px solid ${v("--line", "#2a2a2e")}; padding: 4px 8px; text-align: left; vertical-align: top; }
    th { background: ${v("--bg-2", "#18181b")}; color: ${v("--text-0", "#fafafa")}; }
    pre, code { font-family: ${v("--font-mono", "ui-monospace, monospace")}; font-size: 12.5px; }
    pre { background: ${v("--bg-2", "#18181b")}; padding: 10px 12px; border-radius: 8px; overflow: auto; }
    blockquote { margin: 0; padding-left: 14px; border-left: 3px solid ${v("--line", "#2a2a2e")}; color: ${v("--text-2", "#a1a1aa")}; }
    hr { border: 0; border-top: 1px solid ${v("--line", "#2a2a2e")}; margin: 24px 0; }
    mark.xv-hit { background: rgba(252, 97, 11, .35); color: inherit; border-radius: 2px; }
    mark.xv-hit[data-current="true"] { background: rgba(252, 97, 11, .8); color: #fff; }
  `;
}

export function buildFrameDoc(bodyHtml: string, extraCss = ""): string {
  const csp =
    "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${themeCss()}${extraCss}</style></head><body>${sanitizeHtml(bodyHtml)}</body></html>`;
}

/** Highlights `needle` (lower-cased) in the document; returns the marks. */
export function highlightDocument(doc: Document, needle: string): HTMLElement[] {
  doc.querySelectorAll("mark.xv-hit").forEach((mark) => {
    mark.replaceWith(doc.createTextNode(mark.textContent ?? ""));
  });
  doc.body.normalize();
  if (!needle) return [];
  const marks: HTMLElement[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  for (const node of nodes) {
    const text = node.data;
    const lower = text.toLowerCase();
    let at = lower.indexOf(needle);
    if (at < 0) continue;
    const fragment = doc.createDocumentFragment();
    let last = 0;
    while (at >= 0) {
      fragment.append(text.slice(last, at));
      const mark = doc.createElement("mark");
      mark.className = "xv-hit";
      mark.textContent = text.slice(at, at + needle.length);
      fragment.append(mark);
      marks.push(mark);
      last = at + needle.length;
      at = lower.indexOf(needle, last);
    }
    fragment.append(text.slice(last));
    node.replaceWith(fragment);
  }
  return marks;
}

type Props = {
  html: string;
  title: string;
  extraCss?: string;
  onReady?: (doc: Document) => void;
};

export function SafeFrame({ html, title, extraCss, onReady }: Props) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const srcDoc = useMemo(() => buildFrameDoc(html, extraCss), [html, extraCss]);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const handleLoad = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      doc.addEventListener("click", (event) => {
        const anchor = (event.target as Element | null)?.closest?.("a");
        if (!anchor) return;
        event.preventDefault();
        const href = anchor.getAttribute("href") ?? "";
        if (href.startsWith("#")) {
          doc.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: "start" });
        } else if (/^(https?:|mailto:)/i.test(href)) {
          if (event.ctrlKey || event.metaKey) void api.openExternalUrl(href);
        } else if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
          if (event.ctrlKey || event.metaKey) {
            const base = doc.querySelector("base")?.href || "";
            try {
              const resolved = new URL(href, base || window.location.href);
              onReadyRef.current?.(doc);
              window.parent.dispatchEvent(new CustomEvent("axe:viewer-open-path", { detail: { path: resolved.href } }));
            } catch { /* ignore malformed links */ }
          }
        }
      });
      onReadyRef.current?.(doc);
    };
    frame.addEventListener("load", handleLoad);
    return () => frame.removeEventListener("load", handleLoad);
  }, []);

  return (
    <iframe
      ref={ref}
      className="xv-doc__frame"
      title={title}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
    />
  );
}
