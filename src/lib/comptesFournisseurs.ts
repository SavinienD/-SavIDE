// Compte connecté d'un fournisseur (Réglages > Fournisseurs) : e-mail et offre.
//
// Claude (abonnement OAuth) : e-mail et offre du profil Anthropic ; OpenAI : jeton ChatGPT ;
// Google : userinfo et niveau Gemini. Une clé d'API n'a pas de compte : rien à montrer.
// Partie pure testée par tests/comptesFournisseurs.test.cjs.

export type CompteFournisseur = { email: string | null; offre: string | null };

type StatutAvecCompte = {
  connected?: boolean;
  email?: string | null;
  planType?: string | null;
  userTier?: string | null;
} | null | undefined;

/** Offre lisible : « plus » → « Plus », « free-tier » → « Free tier » ; un libellé déjà écrit reste tel quel. */
export function libelleOffre(brut: string | null | undefined): string | null {
  const texte = (brut ?? "").trim();
  if (!texte) return null;
  if (texte !== texte.toLowerCase()) return texte;
  const mots = texte.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return mots.charAt(0).toUpperCase() + mots.slice(1);
}

/** E-mail et offre du compte connecté (null si non connecté ou inconnu). */
export function compteConnecte(statut: StatutAvecCompte): CompteFournisseur {
  if (!statut?.connected) return { email: null, offre: null };
  const email = (statut.email ?? "").trim();
  const offre = libelleOffre(statut.planType ?? statut.userTier ?? null);
  return { email: email.includes("@") ? email : null, offre: offre && offre !== email ? offre : null };
}
