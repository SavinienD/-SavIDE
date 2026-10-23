// axe:viewers — EPUB reader (text). Follows container.xml -> OPF -> spine,
// sanitizes each chapter and inlines its images as data URLs. Only the
// chapters are read from the archive (viewer_zip_read), one at a time.

import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { bytesToDataUrl, imageMime, listZip, readZipEntry, readZipText, resolveZipPath } from "./bytes";
import { ViewerError, ViewerLoading } from "./common";
import { DocumentFrame } from "./DocumentFrame";
import { kid, kids, parseXml } from "./pptx";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

type Chapter = { path: string; label: string };
type Book = { title: string; author: string; chapters: Chapter[] };

async function loadBook(path: string): Promise<Book> {
  const names = new Set((await listZip(path)).entries.map((entry) => entry.name));
  if (!names.has("META-INF/container.xml")) throw new Error("META-INF/container.xml introuvable.");
  const container = parseXml(await readZipText(path, "META-INF/container.xml"));
  const rootfile = container.getElementsByTagNameNS("*", "rootfile")[0];
  const opfPath = rootfile?.getAttribute("full-path") ?? "";
  if (!names.has(opfPath)) throw new Error("Fichier OPF introuvable.");
  const opf = parseXml(await readZipText(path, opfPath));
  const pkg = opf.documentElement;
  const metadata = kid(pkg, "metadata");
  const manifest = new Map<string, { href: string; type: string }>();
  for (const item of kids(kid(pkg, "manifest"), "item")) {
    manifest.set(item.getAttribute("id") ?? "", {
      href: resolveZipPath(opfPath, decodeURIComponent(item.getAttribute("href") ?? "")),
      type: item.getAttribute("media-type") ?? "",
    });
  }
  const chapters: Chapter[] = [];
  for (const ref of kids(kid(pkg, "spine"), "itemref")) {
    const item = manifest.get(ref.getAttribute("idref") ?? "");
    if (!item || !names.has(item.href) || !/html|xml/.test(item.type)) continue;
    const file = item.href.split("/").pop() ?? item.href;
    chapters.push({ path: item.href, label: file.replace(/\.(x?html?|xml)$/i, "") });
  }
  return {
    title: kid(metadata, "title")?.textContent?.trim() || "Sans titre",
    author: kid(metadata, "creator")?.textContent?.trim() ?? "",
    chapters,
  };
}

async function loadChapter(path: string, chapter: string): Promise<string> {
  const text = await readZipText(path, chapter);
  let doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
  if (doc.getElementsByTagName("parsererror").length) doc = new DOMParser().parseFromString(text, "text/html");
  const body = doc.getElementsByTagName("body")[0] ?? doc.documentElement;
  // Inline the chapter's images (img, svg <image>) before sanitizing.
  const images = Array.from(body.querySelectorAll("img, image"));
  await Promise.all(
    images.map(async (img) => {
      const attr = img.hasAttribute("src") ? "src" : img.hasAttribute("href") ? "href" : "xlink:href";
      const raw = img.getAttribute(attr) ?? img.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "";
      if (!raw || /^(data|https?):/i.test(raw)) return;
      const target = resolveZipPath(chapter, decodeURIComponent(raw));
      const mime = imageMime(target);
      if (!mime) return;
      try {
        const bytes = await readZipEntry(path, target);
        if (bytes.length > MAX_IMAGE_BYTES) return;
        const replacement = doc.createElement("img");
        replacement.setAttribute("src", bytesToDataUrl(bytes, mime));
        replacement.setAttribute("alt", img.getAttribute("alt") ?? "");
        (img.localName === "image" ? img.closest("svg") ?? img : img).replaceWith(replacement);
      } catch {
        /* missing image: keep the alt text only */
      }
    }),
  );
  return body.innerHTML;
}

export default function EpubViewer({ path, size, name }: { path: string; size: number; name: string }) {
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBook(null);
    setError(null);
    setIndex(0);
    loadBook(path)
      .then((loaded) => !cancelled && setBook(loaded))
      .catch((err) => !cancelled && setError(String(err?.message ?? err)));
    return () => {
      cancelled = true;
    };
  }, [path, size]);

  useEffect(() => {
    const chapter = book?.chapters[index];
    if (!chapter) return;
    let cancelled = false;
    setHtml(null);
    loadChapter(path, chapter.path)
      .then((body) => !cancelled && setHtml(body || "<p><em>Chapitre vide.</em></p>"))
      .catch((err) => !cancelled && setHtml(`<p><em>Chapitre illisible : ${String(err)}</em></p>`));
    return () => {
      cancelled = true;
    };
  }, [book, index, path]);

  if (error) return <ViewerError icon="solar:book-2-linear" title="Impossible de lire ce livre numérique." detail={error} />;
  if (!book) return <ViewerLoading label="Ouverture du livre…" />;
  if (!book.chapters.length) return <ViewerError icon="solar:book-2-linear" title="Aucun chapitre lisible dans ce livre." />;

  const side = (
    <>
      <div className="xv-split__title" title={book.author}>
        {book.title}
      </div>
      {book.chapters.map((chapter, i) => (
        <button
          type="button"
          key={chapter.path}
          className="xv-split__item"
          data-active={i === index ? "true" : "false"}
          onClick={() => setIndex(i)}
          title={chapter.path}
        >
          <span>
            {i + 1}. {chapter.label}
          </span>
        </button>
      ))}
    </>
  );
  return html === null ? (
    <ViewerLoading label="Chargement du chapitre…" />
  ) : (
    <DocumentFrame
      html={html}
      title={name}
      side={side}
      toolbar={
        <>
          <button type="button" className="xv-btn" disabled={index === 0} onClick={() => setIndex((i) => i - 1)} title="Chapitre précédent">
            <Icon icon="solar:alt-arrow-left-linear" width={14} height={14} />
          </button>
          <span className="xv-search__count">
            {index + 1} / {book.chapters.length}
          </span>
          <button
            type="button"
            className="xv-btn"
            disabled={index + 1 >= book.chapters.length}
            onClick={() => setIndex((i) => i + 1)}
            title="Chapitre suivant"
          >
            <Icon icon="solar:alt-arrow-right-linear" width={14} height={14} />
          </button>
          <span className="xv-toolbar__hint">{book.author ? `${book.title} · ${book.author}` : book.title}</span>
        </>
      }
    />
  );
}
