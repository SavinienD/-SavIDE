// Sections des Réglages (Ctrl+K y mène, et la recherche dans les Réglages).
// Mêmes identifiants que les boutons du volet (data-section de SettingsPane.tsx) : le test
// tests/paletteAller.test.cjs vérifie qu'ils correspondent. Édition locale : sans les
// sections qui demandent un serveur (Service, Appareils), masquées dans le volet.
import { EDITION_LOCALE } from "../../lib/edition";

/** Sections masquées par l'édition locale (comme dans SettingsPane.tsx). */
export const SECTIONS_MASQUEES: string[] = EDITION_LOCALE ? ["service", "connections"] : [];

export type SectionReglages = { id: string; titre: string; icone: string };

export const SECTIONS_REGLAGES: SectionReglages[] = ([
  { id: "about", titre: "À propos", icone: "solar:info-circle-linear" },
  { id: "appearance", titre: "Apparence", icone: "solar:palette-linear" },
  { id: "editor", titre: "Éditeur", icone: "solar:document-text-linear" },
  { id: "providers", titre: "Fournisseurs", icone: "solar:cloud-check-linear" },
  { id: "mcp", titre: "MCP", icone: "solar:server-square-cloud-linear" },
  { id: "skills", titre: "Skills", icone: "solar:magic-stick-3-linear" },
  { id: "harness", titre: "Harnais", icone: "solar:lightbulb-linear" },
  { id: "repl", titre: "Outils REPL", icone: "solar:code-square-linear" },
  { id: "agentsCli", titre: "Agents CLI", icone: "solar:programming-linear" },
  { id: "commandes", titre: "Commandes", icone: "solar:bookmark-linear" },
  { id: "service", titre: "Service", icone: "solar:server-linear" },
  { id: "connections", titre: "Appareils", icone: "solar:global-linear" },
  { id: "shortcuts", titre: "Raccourcis", icone: "solar:keyboard-linear" },
  { id: "voice", titre: "Dictée vocale", icone: "solar:microphone-3-linear" },
  { id: "navigateur", titre: "Navigateur", icone: "solar:global-linear" },
  { id: "notifications", titre: "Notifications", icone: "solar:bell-linear" },
] as SectionReglages[]).filter((s) => !SECTIONS_MASQUEES.includes(s.id));
