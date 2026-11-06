// plusieurs abonnements au même fournisseur (deux comptes Claude, deux comptes
// ChatGPT) : le compte principal garde l'identifiant « anthropic » (ancienne connexion, rien à
// refaire) ; chaque compte ajouté a le sien, « anthropic~2 », « anthropic~3 »… Les modèles d'un
// compte ajouté sont ceux du fournisseur, sous un groupe à part (e-mail en sous-titre).
// Partie pure testée par tests/comptesModeles.test.cjs.
import type { ModelEntry } from "./models";

export const SEPARATEUR_COMPTE = "~";

/** Compte connecté d'un fournisseur (commande `list_provider_accounts`). */
export type CompteModele = {
  providerId: string;
  base: string;
  email?: string | null;
  plan?: string | null;
  connected?: boolean;
};

export function baseDuFournisseur(provider: string): string {
  const i = provider.indexOf(SEPARATEUR_COMPTE);
  return i < 0 ? provider : provider.slice(0, i);
}

/** Modèles du catalogue + ceux des comptes ajoutés, rangés après leur fournisseur ; l'e-mail de
 *  chaque compte en sous-titre dès qu'un fournisseur a plusieurs comptes. */
export function modelesAvecComptes(
  catalogue: readonly ModelEntry[],
  configures: readonly string[],
  comptes: readonly CompteModele[] = [],
): ModelEntry[] {
  const emails = new Map(comptes.map((c) => [c.providerId, (c.email ?? "").trim()]));
  const ajoutes = [...new Set(configures)]
    .filter((p) => p.includes(SEPARATEUR_COMPTE))
    .sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
  const bases = new Set(ajoutes.map(baseDuFournisseur));
  const sortie: ModelEntry[] = [];
  const etiquette = (provider: string): Partial<ModelEntry> => {
    const email = emails.get(provider);
    return bases.has(baseDuFournisseur(provider)) && email ? { accountLabel: email } : {};
  };
  for (let i = 0; i < catalogue.length; i += 1) {
    const m = catalogue[i];
    sortie.push({ ...m, ...etiquette(m.provider) });
    const dernier = i === catalogue.length - 1 || catalogue[i + 1].provider !== m.provider;
    if (!dernier || !bases.has(m.provider)) continue;
    const modeles = catalogue.filter((x) => x.provider === m.provider);
    for (const compte of ajoutes.filter((p) => baseDuFournisseur(p) === m.provider)) {
      for (const x of modeles) {
        sortie.push({
          ...x,
          value: `${compte}:${x.value.slice(m.provider.length + 1)}`,
          provider: compte,
          accountLabel: emails.get(compte) || `Compte ${compte.slice(compte.indexOf(SEPARATEUR_COMPTE) + 1)}`,
        });
      }
    }
  }
  return sortie;
}
