// Theme scenes: background (light / dark) x accent, for the colour audit.
// Each scene sets the persisted theme (axe.theme.bg / axe.theme.accent) before
// the app starts, then shows the chat with a queue, the "agents at work" banner
// and a text selection, or the Appearance settings.
export const FONDS_THEME = { sombre: "#0b0b0d", clair: "#f6f6f4" };
export const ACCENTS_THEME = { orange: null, bleu: "#2563eb", violet: "#9333ea", sarcelle: "#0d9488" };

export function scenesTheme({ colonnes, ids, fileAttente }) {
  const scenes = [];
  for (const [nomFond, fond] of Object.entries(FONDS_THEME)) {
    for (const [nomAccent, accent] of Object.entries(ACCENTS_THEME)) {
      const theme = { "axe.theme.bg": fond, ...(accent ? { "axe.theme.accent": accent } : {}) };
      const v = `${nomFond}-${nomAccent}`;
      scenes.push({
        id: `theme-chat-${v}`,
        sim: { tour: "en_cours", sousAgents: 2 },
        stockage: () => ({ ...colonnes([ids(2), ["c-003"]]), ...fileAttente("c-001", 3), ...theme }),
        selectionner: ".chat-body .md p",
        temoins: ["sel:.axe-agents-bandeau", "sel:.todo-strip__queue"],
      });
      scenes.push({
        id: `theme-apparence-${v}`,
        sim: {},
        stockage: () => ({ ...colonnes([ids(1)]), ...theme }),
        reglages: true,
        clics: [".settings-pane__nav-item[data-section='appearance']"],
        temoins: ["sel:.axe-appearance"],
      });
    }
  }
  return scenes;
}
