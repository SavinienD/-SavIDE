// axe:fr — résumés d'outils envoyés par le moteur (Rust, agent/tool_summary.rs) avec « tool_ready ».
// Ils sont en anglais, y compris depuis un espace Axe Cloud encore en 0.1.56 : on les traduit
// à la réception, outil par outil. Le texte libre (description bash écrite par le modèle, JSON des
// arguments) n'est jamais touché. Les fonctions qui reconnaissent un résumé (sous-agent, skill)
// acceptent l'anglais et le français.
import { canonicalToolName } from "../../lib/tools";

const NB = "\u00a0";
type Remplacement = string | ((sous: string, ...groupes: string[]) => string);
type Regle = [RegExp, Remplacement];

const ACTIONS_TACHE: Record<string, string> = {
  create: "création",
  update: "mise à jour",
  claim: "prise en charge",
  delete: "suppression",
  list: "liste",
  get: "lecture",
};
const ETATS_TACHE: Record<string, string> = {
  pending: "en attente",
  in_progress: "en cours",
  completed: "terminée",
  done: "terminée",
  blocked: "bloquée",
  deleted: "supprimée",
};

// Pour chaque outil, la première règle qui s'applique gagne (les plus précises d'abord).
const REGLES: Record<string, Regle[]> = {
  bash_input: [
    [/^Stop (\S+) session (\d+)$/, "Arrêter la session $1 $2"],
    [/^Send input to (\S+) session (\d+)$/, "Saisie dans la session $1 $2"],
    [/^Poll (\S+) session (\d+)$/, "Lire la session $1 $2"],
  ],
  read: [[/^Read ([\s\S]+)$/, "Lire $1"]],
  grep: [
    [/^Grep in workspace$/, "Grep dans l'espace de travail"],
    [/^Grep in ([\s\S]+)$/, "Grep dans $1"],
  ],
  glob: [
    [/^Glob ([\s\S]+?) in workspace$/, "Glob $1 dans l'espace de travail"],
    [/^Glob ([\s\S]+?) in ([\s\S]+)$/, "Glob $1 dans $2"],
  ],
  edit_file: [
    [/^Edit files · (\d+) files · (\d+) replacements$/, "Modifier des fichiers · $1 fichiers · $2 remplacements"],
    [/^Edit files · (\d+) files$/, "Modifier des fichiers · $1 fichiers"],
    [/^Edit file · (\d+) replacements$/, "Modifier un fichier · $1 remplacements"],
    [/^Edit file$/, "Modifier un fichier"],
    [/^Edit ([\s\S]+) · (\d+) replacements$/, "Modifier $1 · $2 remplacements"],
    [/^Edit ([\s\S]+)$/, "Modifier $1"],
  ],
  write_file: [
    [/^Write file$/, "Écrire un fichier"],
    [/^Write ([\s\S]+)$/, "Écrire $1"],
  ],
  clean_context: [
    [/^Clean context · (\d+) results$/, "Nettoyer le contexte · $1 résultats"],
    [/^Clean context$/, "Nettoyer le contexte"],
  ],
  update_goal: [[/^Goal finished$/, "Objectif terminé"]],
  create_image: [
    [/^Create image: ([\s\S]*)$/, `Créer une image${NB}: $1`],
    [/^Create image$/, "Créer une image"],
  ],
  todo_list: [
    [/^Close todo_list$/, "Fermer la liste de tâches"],
    [/^Update todo_list$/, "Mettre à jour la liste de tâches"],
  ],
  load_mcp_tool: [
    [/^Load MCP tool$/, "Charger un outil MCP"],
    [/^Load ([\s\S]+) · ([\s\S]+)$/, "Charger $1 · $2"],
  ],
  skill: [
    [/^Load skill · ([\s\S]+)$/, "Skill · $1"],
    [/^Load skill$/, "Charger un skill"],
  ],
  subagent: [
    [/^Sub-agent · /, "Sous-agent · "],
    [/^Sub-agent$/, "Sous-agent"],
  ],
  team_run: [
    [/^Agent Swarm · restart @/, "Essaim d'agents · relance de @"],
    [/^Agent Swarm\b/, "Essaim d'agents"],
  ],
  team_create: [
    [/^Create Agent Swarm$/, "Créer un essaim d'agents"],
    [/^Agent Swarm\b/, "Essaim d'agents"],
  ],
  agent: [[/^Agent teammate$/, "Équipier"]],
  send_message: [[/^Send Agent Swarm message$/, "Message à l'essaim d'agents"]],
  task_create: [
    [/^Create task$/, "Créer une tâche"],
    [/^Task · create · /, "Tâche · création · "],
  ],
  context_compaction: [[/^Compact context$/, "Compacter le contexte"]],
  task_list: [
    [/^Task list$/, "Liste des tâches"],
    [/^Task · (\w+)/, (_s, action) => `Tâche · ${ACTIONS_TACHE[action] ?? action}`],
  ],
  task_update: [
    [/^Update task$/, "Mettre à jour la tâche"],
    [/^Task · (#\S+) · (\S+)$/, (_s, id, etat) => `Tâche · ${id} · ${ETATS_TACHE[etat] ?? etat}`],
    [/^Task · /, "Tâche · "],
  ],
  team_status: [[/^Agent Swarm status$/, "État de l'essaim d'agents"]],
  team_stop: [[/^Stop Agent Swarm$/, "Arrêter l'essaim d'agents"]],
  web_search: [
    [/^Search web: ([\s\S]*)$/, `Recherche web${NB}: $1`],
    [/^Search web$/, "Recherche web"],
  ],
  web_fetch: [
    [/^Fetch URL$/, "Lire une URL"],
    [/^Fetch ([\s\S]+)$/, "Lire $1"],
  ],
};

/** Résumé d'outil du moteur, affiché en français (inchangé s'il n'est pas reconnu). */
export function resumeOutilEnFrancais(nomOutil: string, resume: string): string {
  if (!resume) return resume;
  const cle = nomOutil.startsWith("subagent_") ? "subagent" : canonicalToolName(nomOutil);
  for (const [motif, remplacement] of REGLES[cle] ?? []) {
    if (!motif.test(resume)) continue;
    return typeof remplacement === "string" ? resume.replace(motif, remplacement) : resume.replace(motif, remplacement);
  }
  return resume;
}
