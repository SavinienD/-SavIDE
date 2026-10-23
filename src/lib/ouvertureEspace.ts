// axe:parcours-collegue (D5) — liste des conversations à l'ouverture d'un espace Axe Cloud.
//
// `open_cloud_workspace` (src-tauri/src/workspace.rs) construit la liste depuis le magasin du
// PC : les conversations de l'espace (par ex. « test », créée par « + » sur la VM) n'y étaient
// pas. La liste de l'espace (sessions.list) la remplace ; le brouillon du PC (conversation
// active, pas encore envoyée sur l'espace) reste en tête, pour que la conversation affichée
// soit toujours dans la liste. Service injoignable : liste du PC, comme avant.
// Module pur, testé par tests/ouvertureEspace.test.cjs.
import type { ConversationSummary, WorkspaceBootstrap } from "../types";

export async function ouvertureEspace(
  bootstrap: WorkspaceBootstrap,
  lireListe: () => Promise<ConversationSummary[]>,
): Promise<WorkspaceBootstrap> {
  let liste: ConversationSummary[];
  try {
    liste = await lireListe();
  } catch {
    return bootstrap;
  }
  const brouillon = bootstrap.activeConversation;
  if (!brouillon || liste.some((c) => c.id === brouillon.id)) {
    return { ...bootstrap, conversations: liste };
  }
  const resume = bootstrap.conversations.find((c) => c.id === brouillon.id) ?? {
    id: brouillon.id,
    title: brouillon.title,
    updatedAtMs: 0,
  };
  return { ...bootstrap, conversations: [resume, ...liste] };
}
