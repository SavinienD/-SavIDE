// axe:html — document rendu par la visionneuse HTML (iframe srcdoc sandbox).
// - <base> sur le dossier du fichier : images, styles, polices et scripts
//   RELATIFS se chargent depuis le disque (protocole asset de Tauri) ;
// - CSP en tête : aucun accès réseau (ni http(s), ni fetch/XHR/WebSocket,
//   ni formulaire), seulement l'origine asset locale, data: et blob: ;
// - scripts : 'none' par défaut, sinon inline + fichiers locaux.
// L'origine asset vaut http://asset.localhost sous Windows et
// asset://localhost sous macOS / Linux : on la déduit de la base.

function echapperAttribut(valeur: string): string {
  return valeur.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function origineLocale(baseHref: string): string {
  try {
    const url = new URL(baseHref);
    if (url.origin && url.origin !== "null") return url.origin;
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

/** Politique de sécurité du rendu : rien hors des fichiers locaux. */
export function politiqueApercu(baseHref: string, scripts: boolean): string {
  const local = origineLocale(baseHref);
  const src = (...extra: string[]) => [local, ...extra].filter(Boolean).join(" ") || "'none'";
  return [
    "default-src 'none'",
    `img-src ${src("data:", "blob:")}`,
    `media-src ${src("data:", "blob:")}`,
    `style-src ${src("'unsafe-inline'")}`,
    `font-src ${src("data:")}`,
    `script-src ${scripts ? src("'unsafe-inline'") : "'none'"}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** HTML de l'utilisateur + <base> du dossier + CSP, placés avant toute ressource. */
export function documentApercuHtml(html: string, baseHref: string, scripts: boolean): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${echapperAttribut(politiqueApercu(baseHref, scripts))}">`;
  const base = /<base[\s>]/i.test(html) ? "" : `<base href="${echapperAttribut(baseHref)}">`;
  const tete = csp + base;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${tete}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (open) => `${open}<head>${tete}</head>`);
  return `${tete}${html}`;
}
