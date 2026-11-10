// Point d'accès d'un fournisseur à abonnement saisi comme fournisseur « personnalisé » (clé API) :
// api.openai.com (ChatGPT), l'API Gemini de Google, api.anthropic.com (Claude). L'écran propose
// alors la connexion par abonnement (carte du fournisseur, OAuth) : ses modèles passent par
// l'abonnement, sans clé API ; la clé reste possible.

export type AbonnementPropose = {
  /** data-fournisseur de la carte de connexion (Réglages > Fournisseurs). */
  carte: "openai" | "google" | "anthropic";
  /** Nom de l'abonnement montré à l'utilisateur. */
  nom: string;
};

const HOTES: [RegExp, AbonnementPropose][] = [
  [/(^|\.)openai\.com$/, { carte: "openai", nom: "ChatGPT" }],
  [/(^|\.)chatgpt\.com$/, { carte: "openai", nom: "ChatGPT" }],
  [/^generativelanguage\.googleapis\.com$/, { carte: "google", nom: "Google Gemini" }],
  [/(^|\.)gemini\.google\.com$/, { carte: "google", nom: "Google Gemini" }],
  [/^api\.anthropic\.com$/, { carte: "anthropic", nom: "Claude" }],
];

/** Hôte d'une adresse saisie (avec ou sans schéma, port, chemin). */
export function hoteAdresse(adresse: string): string {
  const brut = adresse.trim();
  const reste = brut.includes("://") ? brut.slice(brut.indexOf("://") + 3) : brut;
  const hote = reste.split(/[/?#]/)[0] ?? "";
  return hote.slice(hote.lastIndexOf("@") + 1).split(":")[0].toLowerCase().replace(/\.$/, "");
}

/** L'abonnement à proposer pour cette adresse, ou null (autre fournisseur, serveur local…). */
export function abonnementPourAdresse(adresse: string): AbonnementPropose | null {
  const hote = hoteAdresse(adresse);
  if (!hote) return null;
  for (const [motif, abonnement] of HOTES) {
    if (motif.test(hote)) return abonnement;
  }
  return null;
}

/** Ouvre la connexion par abonnement : carte du fournisseur montrée, bouton « Connecter » pressé
 *  s'il est là (sinon le compte est déjà connecté : la carte est seulement montrée). */
export function connecterAbonnement(carte: AbonnementPropose["carte"], racine: ParentNode = document): boolean {
  const section = racine.querySelector<HTMLElement>(`.settings-pane__provider-card[data-fournisseur="${carte}"]`);
  if (!section) return false;
  section.scrollIntoView?.({ block: "center", behavior: "smooth" });
  const bouton = section.querySelector<HTMLButtonElement>('.settings-pane__provider-actions button[data-primary="true"]');
  if (bouton && !bouton.disabled) bouton.click();
  return true;
}
