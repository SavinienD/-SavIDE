// axe:parcours-collegue — modèles proposés dans une conversation d'un espace Axe Cloud.
//
// Le tour d'une conversation d'espace part sur le démon de l'espace (VM) : seuls les
// fournisseurs de l'ESPACE comptent, jamais ceux du PC (un collègue n'en a aucun ; ceux de
// L'utilisateur ne sont pas sur la VM). Chaque espace a le fournisseur « axe-cloud » (compteur
// 127.0.0.1:8096, providers.json de l'espace : Claude Opus / Sonnet / Haiku 5.5, relevé le
// 22/10/2026 sur les quatre espaces). Le protocole du service ne liste pas encore ses
// fournisseurs : la liste est celle-ci, plus un autre modèle « axe-cloud » que porterait déjà
// la conversation. Module pur (types seulement) : testé par tests/modelesEspace.test.cjs.
import type { ModelEntry } from "./models";
import type { ModeModelSettings, ModelRef, ThinkingLevel } from "../types";

export const FOURNISSEUR_ESPACE = "axe-cloud";
const LIBELLE_FOURNISSEUR = "Axe Cloud";
const ICONE = "solar:plug-circle-linear";
const AVEC_REFLEXION: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];
const SANS_REFLEXION: readonly ThinkingLevel[] = ["off"];

function entree(nom: string, libelle: string, reflexion: boolean): ModelEntry {
  return {
    value: `${FOURNISSEUR_ESPACE}:${nom}`,
    provider: FOURNISSEUR_ESPACE,
    providerLabel: LIBELLE_FOURNISSEUR,
    label: libelle,
    thinking: reflexion ? AVEC_REFLEXION : SANS_REFLEXION,
    defaultThinking: reflexion ? "medium" : "off",
    icon: ICONE,
  };
}

/** Modèles du fournisseur « axe-cloud » des espaces (providers.json de l'espace). */
export const MODELES_AXE_CLOUD: readonly ModelEntry[] = [
  entree("claude-opus-5-5", "Claude Opus 5.5", true),
  entree("claude-sonnet-5-5", "Claude Sonnet 5.5", true),
  entree("claude-haiku-5-5", "Claude Haiku 5.5", false),
];

/** Modèles proposés dans une conversation d'espace : ceux de l'espace, plus le modèle
 *  « axe-cloud » de la conversation s'il n'est pas (encore) dans la liste. Un modèle d'un
 *  autre fournisseur (par ex. le modèle par défaut du PC) n'est jamais proposé : la
 *  sélection retombe alors sur le premier modèle de l'espace. */
export function modelesEspace(modeleConversation?: ModelRef | null): ModelEntry[] {
  const liste = [...MODELES_AXE_CLOUD];
  const m = modeleConversation;
  if (m && m.provider === FOURNISSEUR_ESPACE && m.name && !liste.some((e) => e.value === `${m.provider}:${m.name}`)) {
    liste.push(entree(m.name, m.name, true));
  }
  return liste;
}

/** axe:parcours-collegue (D10) — actions du compositeur qui passent par le PC (magasin et
 *  fournisseurs du PC : compact_conversation, réécriture depuis un message, src-tauri/src/
 *  turns.rs). Dans une conversation d'espace Axe Cloud elles échouaient (« conversation not
 *  found », « provider `axe-cloud` is not configured… ») : elles y sont désactivées. La
 *  compaction reste automatique dans l'espace (démon : seuil de 95 %, dépassement de contexte). */
export function actionsDuPc(espaceCloud: boolean): { compaction: boolean; reecriture: boolean } {
  return { compaction: !espaceCloud, reecriture: !espaceCloud };
}

export const NOTE_COMPACTION_ESPACE =
  "Dans un espace Axe Cloud, le résumé de la conversation est automatique : il se fait quand la conversation devient trop longue.";

/** Choix du modèle d'une conversation d'espace : le PC d'abord (magasin et registre du PC).
 *  S'il ne connaît pas la conversation (créée par « + » sur la VM : « conversation not
 *  found », D7) ou pas le fournisseur de l'espace (brouillon du PC : « provider `axe-cloud`
 *  is not configured », D8), le modèle est posé sur le service (`sessions.set_model`).
 *  Brouillon pas encore envoyé (« session not found ») : rien à poser, le modèle choisi part
 *  avec le premier message (`sessions.ensure`). Avant, le choix était annulé et l'erreur
 *  affichée dans la conversation. */
export async function preferenceModeleEspace(
  local: () => Promise<ModeModelSettings>,
  service: () => Promise<unknown>,
  choisi: ModelRef,
): Promise<ModeModelSettings> {
  try {
    return await local();
  } catch (err) {
    // « conversation introuvable » : même refus, une fois le Rust du PC francisé (night-ui-fr).
    if (!/conversation (?:not found|introuvable)|provider `[^`]*` is not configured/i.test(String(err))) throw err;
    try {
      await service();
    } catch (errService) {
      if (!/session not found/i.test(String(errService))) throw errService;
    }
    return { act: choisi, plan: choisi, goal: choisi };
  }
}
