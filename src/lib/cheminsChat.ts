// Chemins cités dans le chat : nettoyage, chemin relatif à l'espace et
// chemins à copier (menu du clic droit). Sortis de Workspace pour servir aussi au chat.

/** Windows verbatim prefix (`\\?\C:\…`, `\\?\UNC\srv\share\…`), as built by
 * Rust `canonicalize` on the backend: strip it so chat/tool paths look normal
 * and match the workspace path when resolving a click. */
export function stripVerbatimPath(path: string): string {
  const unc = /^(?:\\\\\?\\|\/\/\?\/)UNC[\\/](.*)$/i.exec(path);
  if (unc) return `\\\\${unc[1]}`;
  return path.replace(/^(?:\\\\\?\\|\/\/\?\/)/i, "");
}

/** Shared cleanup for chat-referenced paths (quotes, line suffixes, verbatim prefix). */
export function cleanChatFilePath(rawPath: string): string {
  return stripVerbatimPath(
    rawPath
      .trim()
      .replace(/^['"`<]+|['"`>,.;:]+$/g, "")
      .replace(/#L\d+(?:C\d+)?$/i, "")
      .replace(/:\d+(?::\d+)?$/, ""),
  );
}

export function chatPathToRelative(rawPath: string, workspacePath: string): string | null {
  let path = cleanChatFilePath(rawPath).replace(/\\/g, "/");

  if (!path || path.includes("://")) return null;

  const root = stripVerbatimPath(workspacePath.replace(/\\/g, "/")).replace(/\/+$/, "");
  const pathKey = path.toLowerCase();
  const rootKey = root.toLowerCase();
  if (pathKey === rootKey) return null;
  if (root && pathKey.startsWith(`${rootKey}/`)) {
    path = path.slice(root.length + 1);
  } else if (/^[a-zA-Z]:\//.test(path) || path.startsWith("//")) {
    // Absolute path outside the workspace: not an editor-relative file.
    return null;
  } else if (path.startsWith("/")) {
    return null;
  }

  path = path.replace(/^\.\//, "");
  if (!path || path.startsWith("../") || path.includes("/../")) return null;

  return path;
}

/** Chemins à copier pour un chemin du chat : complet (racine de l'espace + relatif, ou chemin
 * absolu tel quel) et relatif (null hors de l'espace), avec le séparateur du système. */
export function cheminsACopier(
  rawPath: string,
  workspacePath: string,
  windows: boolean,
): { complet: string; relatif: string | null } {
  const sep = (p: string) => (windows ? p.replace(/\//g, "\\") : p);
  const relatif = workspacePath ? chatPathToRelative(rawPath, workspacePath) : null;
  if (relatif) {
    const racine = stripVerbatimPath(workspacePath).replace(/[\\/]+$/, "");
    return { complet: sep(`${racine}/${relatif}`), relatif: sep(relatif) };
  }
  return { complet: sep(cleanChatFilePath(rawPath)), relatif: null };
}
