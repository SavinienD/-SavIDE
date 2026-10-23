// axe:fr — erreurs du moteur (crates/axecode-core, démon des espaces, commandes Tauri) affichées en
// français. Le texte brut reste tel quel dans l'état : il est comparé ailleurs (Workspace.tsx,
// cloudOnline.ts, agentsApi.ts, remoteItems.ts, offline.rs). Seul l'affichage passe par ici.
// Le détail technique (réseau, HTTP, bibliothèques) est gardé tel quel : il sert au support.
const NB = "\u00a0";

type Traduction = string | ((...groupes: string[]) => string);

// Messages entiers que le Rust garde en anglais parce que le front les reconnaît.
const PHRASES: ReadonlyArray<[RegExp, Traduction]> = [
  [/^a turn is already running for this conversation\.?$/i, "Un tour est déjà en cours pour cette conversation."],
  [
    /^provider `([^`]+)` is not configured or missing credentials\.?$/i,
    (_tout, fournisseur) => `Fournisseur «${NB}${fournisseur}${NB}» non configuré ou identifiants manquants.`,
  ],
  [/^turn cancelled\.?$/i, "Tour annulé."],
];

// Préfixes des erreurs du moteur (« stream error: … ») : le libellé passe en français, le détail reste.
const PREFIXES: ReadonlyArray<[RegExp, string]> = [
  [/^retryable stream error:\s*/i, "Réponse interrompue (nouvel essai possible)"],
  [/^stream error:\s*/i, "Réponse interrompue"],
  [/^network error:\s*/i, "Erreur réseau"],
  [/^auth error:\s*/i, "Authentification refusée"],
  [/^rate limited:\s*/i, "Limite de débit atteinte"],
  [/^context window exceeded:\s*/i, "Fenêtre de contexte dépassée"],
  [/^invalid request:\s*/i, "Requête invalide"],
  [/^decode error:\s*/i, "Réponse illisible"],
  [/^unsupported feature:\s*/i, "Fonction non prise en charge"],
  [/^provider error:\s*/i, "Erreur du fournisseur"],
  [/^protocol error:\s*/i, "Erreur de protocole"],
  [/^io error:\s*/i, "Erreur d'entrée-sortie"],
  [/^journal error:\s*/i, "Erreur du journal de session"],
  [/^runtime error:\s*/i, "Erreur du moteur"],
  [/^session busy:\s*/i, "Session occupée"],
  [/^session not found:\s*/i, "Session introuvable"],
];

function phrase(texte: string): string | null {
  for (const [motif, traduction] of PHRASES) {
    const m = texte.match(motif);
    if (m) return typeof traduction === "string" ? traduction : traduction(...m);
  }
  return null;
}

/** Message d'erreur du moteur tel qu'il s'affiche (inchangé s'il n'est pas reconnu). */
export function erreurMoteurEnFrancais(texte: string): string {
  const brut = texte.trim().replace(/^Error:\s*/, "");
  const entier = phrase(brut);
  if (entier) return entier;
  for (const [motif, libelle] of PREFIXES) {
    const m = brut.match(motif);
    if (!m) continue;
    const detail = brut.slice(m[0].length).trim();
    if (!detail) return libelle;
    return `${libelle}${NB}: ${phrase(detail) ?? detail}`;
  }
  return texte;
}
