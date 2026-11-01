// Liens d'une conversation (barre des liens de l'en-tête du chat) : chemins de fichiers, URL et
// liens Markdown des messages, fichiers cités par les outils. Sans doublons, plus récents d'abord.
// Module pur (sans React) : testé par tests/liensConversation.test.cjs.
import { decouperLiens } from "../components/chat/liensChat";
import { cleanChatFilePath } from "./cheminsChat";

export type TypeLien = "url" | "image" | "video" | "pdf" | "code" | "autre";
export type LienConversation = { valeur: string; genre: "fichier" | "url"; type: TypeLien; nom: string };

type BlocTexte = { kind: string; text?: string; argsRaw?: string; argsPretty?: string; fileChanges?: { relativePath: string }[] };

const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "tif", "tiff"]);
const VIDEOS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v", "wmv"]);
const CODE = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs",
  "rb", "php", "sh", "bash", "zsh", "ps1", "sql", "css", "scss", "html", "vue", "svelte", "json", "toml", "yaml", "yml",
  "xml", "ini", "conf", "config", "lock", "env",
]);

export const LIBELLES_TYPES: Record<TypeLien, string> = {
  url: "URL", image: "Images", video: "Vidéos", pdf: "PDF", code: "Code", autre: "Autres",
};
export const ORDRE_TYPES: TypeLien[] = ["url", "code", "image", "video", "pdf", "autre"];

function extension(chemin: string): string {
  const base = chemin.split(/[\\/]/).pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function typeDeLien(valeur: string, genre: "fichier" | "url"): TypeLien {
  const chemin = genre === "url" ? valeur.replace(/[?#].*$/, "").replace(/^https?:\/\/[^/]+/i, "") : cleanChatFilePath(valeur);
  const ext = extension(chemin);
  if (IMAGES.has(ext)) return "image";
  if (VIDEOS.has(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (genre === "url") return "url";
  return CODE.has(ext) ? "code" : "autre";
}

function nomDe(valeur: string, genre: "fichier" | "url"): string {
  if (genre === "url") return valeur.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return cleanChatFilePath(valeur);
}

const CLES_CHEMIN = ["path", "file_path", "filePath", "file", "paths", "files", "target", "destination"];

function cheminsDesArguments(brut: string | undefined): string[] {
  if (!brut) return [];
  let args: unknown;
  try {
    args = JSON.parse(brut);
  } catch {
    return [];
  }
  if (!args || typeof args !== "object") return [];
  const out: string[] = [];
  for (const cle of CLES_CHEMIN) {
    const v = (args as Record<string, unknown>)[cle];
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && x.trim() && !x.includes("\n")) out.push(x.trim());
  }
  return out;
}

/** Tous les liens de la conversation, sans doublons (même fichier à une autre ligne compris),
 * du plus récent au plus ancien. */
export function liensDeConversation(blocs: readonly BlocTexte[]): LienConversation[] {
  const vus = new Set<string>();
  const out: LienConversation[] = [];
  const ajouter = (valeur: string, genre: "fichier" | "url") => {
    const propre = genre === "url" ? valeur : cleanChatFilePath(valeur);
    if (!propre) return;
    const cle = genre === "url" ? `u:${propre}` : `f:${propre.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()}`;
    if (vus.has(cle)) return;
    vus.add(cle);
    out.push({ valeur: genre === "url" ? valeur : propre, genre, type: typeDeLien(propre, genre), nom: nomDe(propre, genre) });
  };
  for (let i = blocs.length - 1; i >= 0; i -= 1) {
    const b = blocs[i];
    const trouves: { valeur: string; genre: "fichier" | "url" }[] = [];
    if ((b.kind === "assistant-text" || b.kind === "user-text") && b.text) {
      for (const s of decouperLiens(b.text)) if (s.genre !== "texte") trouves.push({ valeur: s.texte, genre: s.genre });
    } else if (b.kind === "tool") {
      for (const c of cheminsDesArguments(b.argsRaw ?? b.argsPretty)) trouves.push({ valeur: c, genre: /^https?:\/\//i.test(c) ? "url" : "fichier" });
      for (const f of b.fileChanges ?? []) trouves.push({ valeur: f.relativePath, genre: "fichier" });
    }
    // Dans un bloc : le dernier lien cité est le plus récent.
    for (let j = trouves.length - 1; j >= 0; j -= 1) ajouter(trouves[j].valeur, trouves[j].genre);
  }
  return out;
}
