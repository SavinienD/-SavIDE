// axe:viewers — pdf.js loading: worker, side assets and a range transport
// that pulls byte ranges from Rust, so a 500 MB PDF is never loaded whole.

import {
  GlobalWorkerOptions,
  PDFDataRangeTransport,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { CHUNK_BYTES, readBytes } from "../bytes";

export type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
export { TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";

GlobalWorkerOptions.workerSrc = workerUrl;

/** CMaps, standard fonts and wasm decoders, served by the vite plugin.
 *  Absolute so the pdf.js worker resolves them against the app origin. */
const ASSETS = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
/** Files up to this size are handed to pdf.js in one go. */
const WHOLE_FILE_BYTES = 4 * 1024 * 1024;
/** Bytes sent with the first request of a ranged load. */
const INITIAL_BYTES = 1024 * 1024;
/** pdf.js range granularity. */
const RANGE_CHUNK = 256 * 1024;

class TauriRangeTransport extends PDFDataRangeTransport {
  constructor(
    private readonly path: string,
    length: number,
    initial: Uint8Array,
  ) {
    super(length, initial);
  }

  requestDataRange(begin: number, end: number) {
    void (async () => {
      // pdf.js matches the answer to its request by `begin` and accepts a
      // single chunk per request, so big ranges are read in IPC-sized pieces
      // and delivered once, whole.
      const out = new Uint8Array(end - begin);
      let filled = 0;
      while (begin + filled < end) {
        const piece = await readBytes(
          this.path,
          begin + filled,
          Math.min(CHUNK_BYTES, end - begin - filled),
        );
        if (piece.length === 0) break;
        out.set(piece, filled);
        filled += piece.length;
      }
      this.onDataRange(begin, filled === out.length ? out : out.slice(0, filled));
    })().catch((err) => console.error("[pdf] range read failed", err));
  }
}

export async function openPdf(path: string, size: number): Promise<PDFDocumentProxy> {
  const common = {
    cMapUrl: `${ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    wasmUrl: `${ASSETS}wasm/`,
    iccUrl: `${ASSETS}iccs/`,
    isEvalSupported: false,
    enableXfa: true,
  };
  if (size <= WHOLE_FILE_BYTES) {
    const data = await readBytes(path, 0, size);
    return getDocument({ data, ...common }).promise;
  }
  const initial = await readBytes(path, 0, INITIAL_BYTES);
  const range = new TauriRangeTransport(path, size, initial);
  return getDocument({
    range,
    rangeChunkSize: RANGE_CHUNK,
    disableAutoFetch: true,
    disableStream: true,
    ...common,
  }).promise;
}

/** Occurrences of `needle` (already lower-cased) in `haystack`. */
export function countMatches(haystack: string, needle: string): number {
  if (!needle) return 0;
  const text = haystack.toLowerCase();
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    count += 1;
  }
  return count;
}
