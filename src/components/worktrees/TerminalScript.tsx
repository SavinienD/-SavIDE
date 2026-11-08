// Worktrees — terminal (xterm) d'un script de worktree : la sortie gardée
// par le backend, puis la suite en direct ; on peut répondre au script tant
// qu'il tourne (le terminal est joignable comme les autres).
import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../lib/ipc";
import { xtermTheme } from "../../axe/themeTargets";
import { MONO_BASE_PX } from "../../axe/zoom";
import { EVENEMENT_SORTIE, worktreesApi, type SortieScript, type TacheWorktree } from "./worktreesApi";

const encodeur = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
const octets = (texte: string) => (encodeur ? encodeur.encode(texte).length : texte.length);

export function TerminalScript({ tache }: { tache: TacheWorktree }) {
  const boite = useRef<HTMLDivElement | null>(null);
  const session = tache.script?.sessionId ?? "";
  const token = tache.script?.token ?? "";
  const enCoursRef = useRef(Boolean(tache.script?.enCours));
  enCoursRef.current = Boolean(tache.script?.enCours);

  useEffect(() => {
    const el = boite.current;
    if (!el || !session || !token) return;
    const styles = getComputedStyle(document.documentElement);
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: false,
      fontFamily: styles.getPropertyValue("--font-mono").trim() || "ui-monospace, Consolas, monospace",
      fontSize: MONO_BASE_PX,
      lineHeight: 1.0,
      scrollback: 5000,
      theme: xtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    let fini = false;
    let fin = -1;
    const attente: SortieScript[] = [];
    const ecrire = (s: SortieScript) => {
      if (fin < 0) {
        attente.push(s);
        return;
      }
      if (s.debut < fin) return; // déjà dans la sortie gardée
      term.write(s.texte);
      fin = s.debut + octets(s.texte);
    };
    const arret = listen<SortieScript>(EVENEMENT_SORTIE, (e) => {
      if (e.payload.id === tache.id) ecrire(e.payload);
    });
    void arret
      .then(() => worktreesApi.sortie(tache.id))
      .then((r) => {
        if (fini) return;
        term.write(r.texte);
        fin = r.fin;
        for (const s of attente.splice(0)) ecrire(s);
      })
      .catch(() => {
        fin = 0;
        for (const s of attente.splice(0)) ecrire(s);
      });
    const ajuster = () => {
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (enCoursRef.current) void api.resizeTerminal(session, token, term.cols, term.rows).catch(() => undefined);
    };
    const observateur = new ResizeObserver(ajuster);
    observateur.observe(el);
    const image = requestAnimationFrame(ajuster);
    // Les cellules changent de taille quand la police mono est chargée : nouvel ajustement.
    void document.fonts?.ready.then(() => {
      if (!fini) ajuster();
    });
    const saisie = term.onData((d) => {
      if (enCoursRef.current) void api.writeTerminal(session, token, d).catch(() => undefined);
    });
    return () => {
      fini = true;
      cancelAnimationFrame(image);
      observateur.disconnect();
      saisie.dispose();
      void arret.then((f) => f()).catch(() => undefined);
      term.dispose();
    };
  }, [tache.id, session, token]);

  return <div className="wt-script" ref={boite} data-en-cours={tache.script?.enCours ? "true" : "false"} />;
}
