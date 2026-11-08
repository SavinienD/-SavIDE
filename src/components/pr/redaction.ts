// Rédaction par l'IA (appel unique au modèle, sans session ni outils) du message de
// commit et du titre / de la description d'une PR, à partir du contexte préparé par le
// Rust : diff tronqué proprement, fichiers de secrets exclus, valeurs sensibles masquées.
import { appelUnique } from "../../lib/appelUnique";
import { gitApi } from "./gitApi";
import {
  decouperPr,
  nettoyerMessageCommit,
  promptCommit,
  promptPr,
  SYSTEME_COMMIT,
  SYSTEME_PR,
  type ContexteIa,
} from "./consignes";

/** Ce qui n'est pas parti tel quel vers le modèle (affiché sous le texte rédigé). */
export function noteContexte(ctx: ContexteIa): string | null {
  const morceaux: string[] = [];
  if (ctx.tronque) morceaux.push("diff coupé (gros)");
  if (ctx.masques > 0) morceaux.push(`${ctx.masques} valeur(s) sensible(s) masquée(s)`);
  if (ctx.exclus.length) morceaux.push(`non envoyés : ${ctx.exclus.join(", ")}`);
  return morceaux.length ? morceaux.join(" · ") : null;
}

export async function redigerCommit(
  workspacePath: string,
  paths: string[],
): Promise<{ message: string; note: string | null }> {
  const ctx = await gitApi.contexteCommit(workspacePath, paths);
  const reponse = await appelUnique(promptCommit(ctx), { systeme: SYSTEME_COMMIT, plafond: 600 });
  const message = nettoyerMessageCommit(reponse.texte);
  if (!message) throw new Error("Le modèle n'a rien rédigé : réessayez.");
  return { message, note: noteContexte(ctx) };
}

export async function redigerPr(
  workspacePath: string,
  base: string | null,
): Promise<{ titre: string; description: string; note: string | null }> {
  const ctx = await gitApi.contextePr(workspacePath, base);
  const reponse = await appelUnique(promptPr(ctx), { systeme: SYSTEME_PR, plafond: 1500 });
  const { titre, description } = decouperPr(reponse.texte);
  if (!titre) throw new Error("Le modèle n'a rien rédigé : réessayez.");
  return { titre, description, note: noteContexte(ctx) };
}
