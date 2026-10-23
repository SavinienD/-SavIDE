// axe:parcours-collegue — erreur d'un tour d'IA d'un espace Axe Cloud, en français lisible.
//
// Le compteur Axe Cloud (127.0.0.1:8096) répond au format Anthropic
// {"type":"error","error":{"type":"api_error","message":"…"}} ; le client Rust en fait
// « auth error: Anthropic rejected the API key (authentication_error: …). Check the key in
// Settings > Providers. » (401), « retryable stream error: HTTP 503 Service Unavailable:
// api_error: … » (429, 5xx, après les relances), « invalid request: permission_error: … »
// (403)… (crates/axecode-anthropic/src/client.rs, classify_http_error), transmis tels quels
// par le démon de l'espace (turn_error). Ces textes ne sont PAS modifiés (d'autres écrans les
// reconnaissent par motif) : on les explique à l'affichage, avec le statut et le message du
// serveur. `null` : erreur non reconnue, ou conversation hors espace Axe Cloud (texte laissé
// tel quel). Module pur, testé par tests/erreursIA.test.cjs.

const STATUT_DU_TYPE: Record<string, number> = {
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};

/** Statut HTTP et message du serveur contenus dans une erreur brute, s'il y en a. */
export function lireErreurServeur(brut: string): { statut: number | null; message: string } | null {
  let texte = String(brut ?? "").trim();
  // Enveloppe du 401 avec une clé d'API : « … (authentication_error: X). Check the key… ».
  texte = texte.replace(/\)\.?\s*Check the key in Settings > Providers\.?\s*$/i, "");
  const http = /\bHTTP (\d{3})\b/.exec(texte);
  const type = /\b(authentication_error|permission_error|not_found_error|rate_limit_error|api_error|overloaded_error|invalid_request_error):\s*([\s\S]*)$/.exec(texte);
  if (!http && !type) return null;
  const statut = http ? Number(http[1]) : STATUT_DU_TYPE[type![1]] ?? null;
  let message = type ? type[2].trim() : texte.slice(http!.index + http![0].length).replace(/^[^:]*:\s*/, "").trim();
  if (/^\{/.test(message)) {
    try {
      const corps = JSON.parse(message) as { error?: { message?: unknown } };
      if (typeof corps.error?.message === "string") message = corps.error.message;
    } catch {
      /* corps illisible : gardé tel quel */
    }
  }
  return { statut, message };
}

/** Explication en français d'une erreur de tour d'une conversation d'espace Axe Cloud
 *  (null : erreur non reconnue, ou `espaceCloud` faux : le texte brut reste affiché). */
export function expliquerErreurIA(brut: string | null | undefined, espaceCloud: boolean): string | null {
  if (!brut || !espaceCloud) return null;
  const texte = String(brut).replace(/^(runtime error|Error):\s*/i, "").trim();
  // « is not declared » : démon de l'espace sans ce fournisseur (repl/declared.rs).
  const fournisseur = /provider `([^`]+)` is not (?:configured|declared)/i.exec(texte);
  if (fournisseur) {
    return fournisseur[1] === "axe-cloud"
      ? "L'IA n'est pas encore configurée dans votre espace Axe Cloud (fournisseur « axe-cloud » absent). Prévenez l'administrateur."
      : `Ce modèle n'est pas disponible dans votre espace Axe Cloud (fournisseur « ${fournisseur[1]} »). Choisissez un modèle Axe Cloud dans la liste des modèles, puis renvoyez le message.`;
  }
  if (/worker crashed repeatedly|kernel exited|kernel not running|axecode_kernel package not found/i.test(texte)) {
    return "Le moteur de votre espace Axe Cloud s'est arrêté avant de répondre. Renvoyez le message ; si cela recommence, prévenez l'administrateur.";
  }
  if (/error sending request|connection refused|dns error|timed out/i.test(texte) && !/\bHTTP \d{3}\b/.test(texte)) {
    return "Le compteur Axe Cloud ne répond pas : réessayez dans un instant. Si cela dure, prévenez l'administrateur.";
  }
  const serveur = lireErreurServeur(texte);
  if (!serveur) return null;
  const { statut, message } = serveur;
  const code = statut ? ` (erreur ${statut})` : "";
  let titre: string;
  if (statut === 401) titre = `Axe Cloud a refusé la clé de votre espace${code}. Prévenez l'administrateur.`;
  else if (statut === 403) titre = `Axe Cloud refuse l'accès à l'IA${code}.`;
  else if (statut === 429) titre = `Limite d'utilisation de l'IA atteinte${code}.`;
  else if (statut !== null && statut >= 500) titre = `Le service IA d'Axe Cloud est indisponible pour le moment${code}.`;
  else titre = `Axe Cloud a refusé la demande${code}.`;
  return message ? `${titre} Message du serveur : « ${message} »` : titre;
}
