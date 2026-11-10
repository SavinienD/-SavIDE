// Terminal plein écran simulé : chaque taille reçue (spawn_terminal / resize_terminal)
// redessine un cadre qui couvre toute la surface, comme un programme plein écran (tmux,
// vim) le fait à chaque changement de taille du PTY : coins, bords et barre d'état en
// couleurs pleines, repérables pixel par pixel sur une capture.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { emit } from "@tauri-apps/api/event";

export const COULEURS_CADRE = {
  hautGauche: [255, 0, 0], hautDroite: [0, 255, 0], basGauche: [0, 0, 255], basDroite: [255, 0, 255],
  haut: [255, 128, 0], gauche: [0, 255, 255], droite: [255, 255, 0], barre: [0, 160, 0],
} as const;

const fond = ([r, g, b]: readonly number[]) => `\x1b[48;2;${r};${g};${b}m`;
const aller = (ligne: number, col: number) => `\x1b[${ligne};${col}H`;

export function dessinerCadre(cols: number, rows: number, ecranAlterne = true): string {
  const c = COULEURS_CADRE;
  let s = (ecranAlterne ? "\x1b[?1049h" : "") + "\x1b[?25l\x1b[0m\x1b[2J\x1b[H";
  // Ligne du haut.
  s += aller(1, 1) + fond(c.hautGauche) + " " + fond(c.haut) + " ".repeat(Math.max(0, cols - 2)) + fond(c.hautDroite) + " ";
  // Bords gauche et droit, texte au milieu.
  for (let l = 2; l <= rows - 1; l += 1) {
    s += aller(l, 1) + fond(c.gauche) + " " + "\x1b[0m";
    if (l === 2) s += `cadre ${cols}x${rows}`.slice(0, Math.max(0, cols - 2));
    s += aller(l, cols) + fond(c.droite) + " ";
  }
  // Dernière ligne : barre d'état (comme tmux), coins en couleur.
  const texte = ` [0] 0:bash*  ${cols}x${rows}`;
  const milieu = (texte + " ".repeat(Math.max(0, cols - 2))).slice(0, Math.max(0, cols - 2));
  s += aller(rows, 1) + fond(c.basGauche) + " " + fond(c.barre) + "\x1b[30m" + milieu + fond(c.basDroite) + " ";
  return s + "\x1b[0m";
}

export function simulationTerminalCadre(scene: Record<string, unknown>) {
  const tailles: Record<string, { cols: number; rows: number; n: number }> = ((window as any).__bancCadre ??= {});
  const dessiner = (a: any) => {
    const sessionId = String(a?.sessionId ?? "");
    const token = String(a?.token ?? "");
    const cols = Number(a?.cols ?? 80), rows = Number(a?.rows ?? 24);
    const premier = !tailles[sessionId];
    tailles[sessionId] = { cols, rows, n: (tailles[sessionId]?.n ?? 0) + 1 };
    // « cadreNormal » : écran normal avec un long historique (barre de défilement présente).
    const historique = scene.cadreNormal && premier
      ? Array.from({ length: 300 }, (_, i) => `ligne ${i + 1} de l'historique`).join("\r\n") + "\r\n" : "";
    // Comme un vrai programme sur SIGWINCH : il relit la taille ACTUELLE du PTY au moment
    // de redessiner (plusieurs changements rapprochés donnent le dernier cadre).
    window.setTimeout(() => {
      const t = tailles[sessionId];
      const data = historique + dessinerCadre(t.cols, t.rows, !scene.cadreNormal);
      void emit("terminal-data", { sessionId, token, data });
    }, 20);
  };
  if (!scene.cadre) return {} as Record<string, (a: any, brut: any) => unknown>;
  return {
    spawn_terminal: (a: any) => { dessiner(a); return { sessionId: String(a?.sessionId ?? "") }; },
    resize_terminal: (a: any) => { dessiner(a); return null; },
    write_terminal: () => null,
  } as Record<string, (a: any, brut: any) => unknown>;
}
