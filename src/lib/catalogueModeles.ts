// catalogue des fournisseurs intégrés : la liste en dur (MODELS) est complétée
// par les modèles que l'API du fournisseur annonce (GET /v1/models avec le compte connecté ou la
// clé), relue au démarrage puis une fois par jour par le moteur (commande `catalogue_modeles`).
// Sans doublon : un modèle déjà connu garde ses réglages ; une version datée d'un modèle connu
// (claude-opus-5-5-20261001, gpt-6-sol-2026-10-01) n'est pas ajoutée. Partie pure testée par
// tests/catalogueModeles.test.cjs.
import type { ModelEntry } from "./models";

export type ModeleDecouvert = { id: string; label?: string | null };
export type CatalogueDecouvert = {
  fetchedAtMs?: number | null;
  fournisseurs?: Record<string, readonly ModeleDecouvert[]>;
};

/** Fournisseurs intégrés dont le catalogue est complété. */
export const FOURNISSEURS_CATALOGUE = ["anthropic", "openai"] as const;

const DATE_FIN = /^(.*?)-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/** Modèle de conversation utilisable par le chat (pas d'embeddings, de voix, d'images…). */
export function modeleDeChat(provider: string, id: string): boolean {
  const v = id.trim().toLowerCase();
  if (provider === "anthropic") return v.startsWith("claude-");
  if (provider === "openai") {
    if (!/^(gpt-|o\d|codex)/.test(v)) return false;
    return !/(embedding|tts|whisper|dall-e|audio|realtime|transcribe|image|search|moderation|instruct|preview-\d)/.test(v);
  }
  return false;
}

function majuscule(mot: string): string {
  return mot ? mot.charAt(0).toUpperCase() + mot.slice(1) : mot;
}

/** Nom affiché : celui de l'API (sans « Claude » devant, comme la liste en dur), sinon tiré de
 *  l'identifiant (« claude-opus-6-1 » → « Opus 6.1 », « gpt-6-nova » → « GPT-6 Nova »). */
export function libelleModele(provider: string, id: string, label?: string | null): string {
  const l = (label ?? "").trim();
  if (l && l !== id) return provider === "anthropic" ? l.replace(/^Claude\s+/i, "") : l;
  if (provider === "anthropic") {
    const mots = id.replace(/^claude-/, "").split("-");
    const nom = mots.filter((m) => !/^\d+$/.test(m)).map(majuscule).join(" ");
    const version = mots.filter((m) => /^\d+$/.test(m)).join(".");
    return [nom, version].filter(Boolean).join(" ") || id;
  }
  if (provider === "openai" && id.startsWith("gpt-")) {
    const [, version, ...reste] = id.split("-");
    return [`GPT-${version ?? ""}`, ...reste.map(majuscule)].join(" ").trim();
  }
  return id;
}

/** MODELS + modèles découverts (après ceux du même fournisseur), sans doublon. */
export function completerCatalogue(base: readonly ModelEntry[], catalogue: CatalogueDecouvert | null | undefined): ModelEntry[] {
  const sortie = [...base];
  for (const provider of FOURNISSEURS_CATALOGUE) {
    const trouves = catalogue?.fournisseurs?.[provider] ?? [];
    const connus = base.filter((m) => m.provider === provider);
    const modele = connus[0];
    if (!trouves.length || !modele) continue;
    const ids = new Set(connus.map((m) => m.value.slice(provider.length + 1)));
    const annonces = new Set(trouves.map((m) => m.id.trim()));
    const ajouts: ModelEntry[] = [];
    for (const t of trouves) {
      const id = t.id.trim();
      if (!id || ids.has(id) || !modeleDeChat(provider, id)) continue;
      const date = DATE_FIN.exec(id);
      if (date && (ids.has(date[1]) || annonces.has(date[1]))) continue;
      ids.add(id);
      ajouts.push({
        value: `${provider}:${id}`,
        provider,
        label: libelleModele(provider, id, t.label),
        thinking: modele.thinking,
        defaultThinking: modele.defaultThinking,
        ...(modele.supportsFast ? { supportsFast: true } : {}),
      });
    }
    if (!ajouts.length) continue;
    const apres = sortie.map((m) => m.provider).lastIndexOf(provider);
    sortie.splice(apres + 1, 0, ...ajouts);
  }
  return sortie;
}
