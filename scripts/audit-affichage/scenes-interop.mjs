// scènes de la reprise (Claude Code, Codex…) : consignes du dossier (Réglages > Harnais),
// import de skills (Claude Code, Codex, adresse), import de serveurs MCP, proposition
// du premier lancement, actions à valider (« Demander avant d'agir ») et réglage par défaut.
import { WS_BANC as WS } from "./constantes.mjs";

const unOnglet = () => ({
  [`axe:v2:onglets-chat:${WS}`]: [{ id: "c-001", titre: "Corriger les défauts d'affichage de la barre de titre" }],
  [`axe:v2:colonnes-chat:${WS}`]: { colonnes: [["c-001"]], focus: 0 },
});
const reglages = (section, ...suite) => ({ stockage: unOnglet, reglages: true, clics: [`.settings-pane__nav-item[data-section='${section}']`, ...suite] });

export const SCENES_INTEROP = [
  // Réglages > Harnais : AGENTS.md lu, CLAUDE.md ignoré (même contenu), .claude/CLAUDE.md absent.
  // (clic par le code : à 800 px le bloc est sous l'en-tête du harnais, qui ne doit pas défiler — défaut connu).
  { id: "interop-consignes", ...reglages("harness", "[data-testid='consignes-dossier'] > summary"),
    temoins: ["compte:.axe-interop__consignes-liste li=3", "sel:.axe-interop__consignes-liste li[data-etat='lu']",
      "sel:.axe-interop__consignes-liste li[data-etat='doublon']", "sel:[data-testid='consignes-dossier'][open] > summary"] },
  // Réglages > Skills > Importer : quatre skills (nouveau, déjà importé, mise à jour, nom pris).
  { id: "interop-skills-import", ...reglages("skills", "[data-action='importer-skills']"), sim: { skillsExternes: true },
    temoins: ["sel:.axe-interop__boite", "compte:.axe-interop__boite .axe-interop__liste > li=4", "sel:.axe-interop__etat[data-etat='mise_a_jour']",
      "clic:[data-action='importer-confirmer']", "clic:.axe-interop__onglets [data-onglet='url']"] },
  { id: "interop-skills-badge", ...reglages("skills"), sim: { skillsExternes: true },
    temoins: ["sel:[data-action='importer-skills'] .axe-interop__badge", "clic:[data-action='importer-skills']"] },
  // Onglet « Depuis une adresse » : aperçu, avertissement « contenu non vérifié », installés.
  { id: "interop-skills-url", ...reglages("skills", "[data-action='importer-skills']", ".axe-interop__onglets [data-onglet='url']"), sim: { skillsExternes: true },
    saisies: [[".axe-interop__url input", "https://github.com/anthropics/skills"]], apresSaisies: ["[data-action='apercu-url']"],
    temoins: ["sel:.axe-interop__boite .axe-harness__banner", "compte:.axe-interop__apercu=2", "clic:[data-action='installer-url']",
      "sel:[data-action='verifier-url']", "sel:[data-action='desinstaller']"] },
  // Réglages > MCP > Importer : six serveurs de quatre outils, doublons signalés, aucun secret affiché.
  { id: "interop-mcp-import", ...reglages("mcp", "[data-action='importer-mcp']"), sim: { mcpExternes: true, mcp: ["fetch"] },
    temoins: ["sel:.axe-interop__boite", "compte:.axe-interop__boite .axe-interop__liste > li=6", "sel:.axe-interop__note[data-genre='doublon']",
      "clic:[data-action='importer-mcp-confirmer']"] },
  // Premier lancement : proposition unique, « Choisir… » ouvre Réglages > MCP sur la boîte d'import.
  { id: "interop-proposition", stockage: unOnglet, sim: { mcpExternes: true, accelerer: true },
    temoins: ["sel:.axe-interop__proposition", "clic:[data-action='proposition-choisir']", "clic:[data-action='proposition-plus-tard']"] },
  { id: "interop-proposition-choisir", stockage: unOnglet, sim: { mcpExternes: true, accelerer: true },
    cliquer: "[data-action='proposition-choisir']", pauseClics: 1200,
    temoins: ["absent:.axe-interop__proposition", "sel:.settings-pane", "sel:.axe-interop__boite"] },
  // Chat : action de l'agent à valider, et une de son sous-agent (une carte, l'autre en une ligne).
  { id: "interop-validation", stockage: unOnglet, sim: { validation: "deux" },
    temoins: ["compte:.axe-validation__carte=1", "clic:.axe-validation__carte [data-action='autoriser']", "clic:.axe-validation__carte [data-action='refuser']",
      "clic:.axe-validation__carte [data-action='toujours']", "clic:[data-action='voir-demande']", "sel:.axe-validation__bouton[data-active='true']"] },
  { id: "interop-validation-refus", stockage: unOnglet, sim: { validation: "un" },
    cliquer: ".axe-validation__carte [data-action='refuser']",
    temoins: ["sel:.axe-validation__refus input", "clic:[data-action='refuser-confirmer']"] },
  { id: "interop-validation-sous-agent", stockage: unOnglet, sim: { validation: "deux" },
    cliquer: "[data-action='voir-demande']",
    temoins: ["compte:.axe-validation__carte=1", "sel:.axe-validation__carte[data-demande='d-2']", "clic:.axe-validation__carte [data-action='autoriser']"] },
  // Réglages > REPL : « Demander avant d'agir » par défaut.
  { id: "interop-validation-defaut", ...reglages("repl"),
    temoins: ["sel:[data-testid='validation-defaut'] input[type='checkbox']", "clic:[data-testid='validation-defaut'] label"] },
];
