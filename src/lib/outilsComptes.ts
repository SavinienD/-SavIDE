// Quel compte servent la recherche web et les images du REPL (web.*, images.*).
// Même règle que le service (crates/axecode-app/src/openai_compte.rs) :
// clé API OpenAI saisie d'abord sauf si la case « Utiliser l'abonnement ChatGPT » est cochée
// (elle l'est d'office quand on connecte ChatGPT), sinon abonnement ChatGPT connecté, sinon rien
// (images : message qui dit quoi connecter ; recherche web : Exa, gratuit).

export type RouteOpenAi = "cle" | "abonnement" | "aucun";

export function routeOpenAi(o: { cle?: string | null; connecte: boolean; forcerAbonnement?: boolean }): RouteOpenAi {
  const cle = (o.cle ?? "").trim() !== "";
  if (o.connecte && (o.forcerAbonnement || !cle)) return "abonnement";
  return cle ? "cle" : "aucun";
}

export const A_CONNECTER =
  "Connectez ChatGPT dans Réglages > Fournisseurs > OpenAI (l'abonnement est alors utilisé) ou saisissez une clé API OpenAI ci-dessous.";

/// Phrase affichée sous « Recherche web » (fournisseur auto, exa ou linkup).
export function libelleRecherche(fournisseur: string, route: RouteOpenAi): string {
  if (fournisseur === "linkup") return "LinkUp, avec la clé ci-dessous.";
  if (fournisseur === "exa") return "Exa (gratuit, sans compte).";
  if (route === "cle") return "Utilisé maintenant : OpenAI avec la clé API (outil web_search). Exa si OpenAI ne répond pas.";
  if (route === "abonnement") return "Utilisé maintenant : abonnement ChatGPT du compte connecté (outil web_search). Exa si OpenAI ne répond pas.";
  return "Utilisé maintenant : Exa (gratuit). Connectez ChatGPT ou saisissez une clé API OpenAI pour la recherche OpenAI.";
}

/// Phrase affichée sous « GPT Image 2 ».
export function libelleImages(route: RouteOpenAi): string {
  if (route === "cle") return "Utilisé maintenant : clé API OpenAI.";
  if (route === "abonnement") return "Utilisé maintenant : abonnement ChatGPT du compte connecté.";
  return "Aucun compte : " + A_CONNECTER;
}
