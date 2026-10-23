// axe:viewers — chunked binary reads through the `viewer_read_bytes` command.
// Large files never travel through JSON: each call returns a raw ArrayBuffer.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/** Size of one IPC round-trip when a viewer needs a whole file. */
export const CHUNK_BYTES = 8 * 1024 * 1024;

export async function readBytes(
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const raw = await invoke<ArrayBuffer | number[]>("viewer_read_bytes", {
    input: { path, offset, length },
  });
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
}

/**
 * Reads a whole file chunk by chunk. Refuses files above `maxBytes` so a
 * viewer can never pull hundreds of megabytes into the webview by mistake.
 */
export async function readAllBytes(
  path: string,
  size: number,
  maxBytes: number,
  onProgress?: (loaded: number) => void,
): Promise<Uint8Array> {
  if (size > maxBytes) {
    throw new Error(
      `Fichier trop volumineux pour cette visionneuse (${formatBytes(size)}, limite ${formatBytes(maxBytes)}).`,
    );
  }
  const out = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const chunk = await readBytes(path, offset, Math.min(CHUNK_BYTES, size - offset));
    if (chunk.length === 0) break;
    out.set(chunk, offset);
    offset += chunk.length;
    onProgress?.(offset);
  }
  return offset === size ? out : out.slice(0, offset);
}

/** Decompressed bytes of one entry of a zip-based file (pptx, epub…). */
export async function readZipEntry(path: string, entry: string): Promise<Uint8Array> {
  const raw = await invoke<ArrayBuffer | number[]>("viewer_zip_read", {
    input: { path, entry },
  });
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
}

export async function readZipText(path: string, entry: string): Promise<string> {
  return new TextDecoder("utf-8").decode(await readZipEntry(path, entry));
}

export type ZipListing = {
  entries: { name: string; size: number; isDir: boolean }[];
  total: number;
  truncated: boolean;
};

export function listZip(path: string): Promise<ZipListing> {
  return invoke<ZipListing>("viewer_zip_list", { input: { path } });
}

/** Resolves `target` relative to the zip entry `base` (OPC/epub links). */
export function resolveZipPath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
};

export function imageMime(name: string): string | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_TYPES[ext] ?? null;
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} Mo`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2).replace(".", ",")} Go`;
}

/**
 * Asset-protocol URL whose path keeps real `/` separators, so relative URLs
 * (`<img src="img/a.png">`) resolve against the file's folder. The asset
 * handler percent-decodes the path and accepts forward slashes on Windows.
 */
export function assetDirUrl(absoluteFilePath: string): string {
  const normalized = absoluteFilePath.replace(/\\/g, "/");
  const dir = normalized.slice(0, normalized.lastIndexOf("/") + 1);
  // Encode each segment but keep the separators. A leading "/" (unix) stays
  // percent-encoded because the asset handler drops the first path char.
  const encoded = dir.split("/").map(encodeURIComponent).join("/");
  return (
    convertFileSrc("") +
    (encoded.startsWith("/") ? `%2F${encoded.slice(1)}` : encoded)
  );
}
