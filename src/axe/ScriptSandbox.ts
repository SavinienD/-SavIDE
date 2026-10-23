// axe:e4 — sandbox par ticket.
//
// Chaque exécution reçoit un ticket (affiché dans le panneau « Exécutions »).
// Production : `systemd-run --scope --uid=savide-bac --pipe` (utilisateur isolé,
// sans accès au dépôt). Dev : `node --eval` dans un dossier temporaire, avec le
// modèle de permissions de Node (--permission) qui refuse tout accès disque.
// Le lanceur est injecté : ce module reste importable côté navigateur.

export type Ticket = {
  id: string;
  script: string;
  etat: "en_cours" | "fini" | "erreur";
  debut: number;
  fin?: number;
  resultat?: unknown;
  erreur?: string;
};

export type Lanceur = (
  commande: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export type ModeSandbox = "systemd" | "dev";

/** Le code exécuté : la source d'une fonction async, son résultat sur stdout en JSON. */
export function programme(source: string): string {
  return `Promise.resolve((${source})()).then(r=>{process.stdout.write(JSON.stringify({ok:true,r:r===undefined?null:r}))},e=>{process.stdout.write(JSON.stringify({ok:false,e:String(e&&e.message||e)}));process.exitCode=1})`;
}

export function commandePour(mode: ModeSandbox, code: string, uid = "savide-bac"): [string, string[]] {
  if (mode === "systemd")
    return ["systemd-run", ["--scope", `--uid=${uid}`, "--pipe", "--quiet", "node", "--experimental-permission", "--eval", code]];
  return ["node", ["--experimental-permission", "--eval", code]];
}

let compteur = 0;
export function nouveauTicket(): string {
  compteur += 1;
  return `t-${Date.now().toString(36)}-${compteur}`;
}

export class ScriptSandbox {
  readonly tickets = new Map<string, Ticket>();
  private abonnes = new Set<(t: Ticket) => void>();

  constructor(
    private lanceur: Lanceur,
    private mode: ModeSandbox = "dev",
    private dossier?: string,
    private timeoutMs = 30_000,
  ) {}

  surChangement(f: (t: Ticket) => void): () => void {
    this.abonnes.add(f);
    return () => this.abonnes.delete(f);
  }

  private publier(t: Ticket) {
    this.tickets.set(t.id, t);
    for (const f of this.abonnes) f(t);
  }

  /** Lance la source ; renvoie aussitôt le ticket et la promesse du résultat. */
  lancer(script: string, source: string): { ticket: string; termine: Promise<Ticket> } {
    const id = nouveauTicket();
    this.publier({ id, script, etat: "en_cours", debut: Date.now() });
    const [cmd, args] = commandePour(this.mode, programme(source));
    const termine = this.lanceur(cmd, args, { cwd: this.dossier, timeoutMs: this.timeoutMs })
      .then(({ code, stdout, stderr }) => {
        let t: Ticket;
        try {
          const v = JSON.parse(stdout.trim().split("\n").pop() || "") as { ok: boolean; r?: unknown; e?: string };
          t = v.ok
            ? { id, script, etat: "fini", debut: this.tickets.get(id)!.debut, fin: Date.now(), resultat: v.r }
            : { id, script, etat: "erreur", debut: this.tickets.get(id)!.debut, fin: Date.now(), erreur: v.e };
        } catch {
          t = { id, script, etat: "erreur", debut: this.tickets.get(id)!.debut, fin: Date.now(),
            erreur: (stderr || `code ${code}`).slice(0, 2000) };
        }
        this.publier(t);
        return t;
      })
      .catch((err) => {
        const t: Ticket = { id, script, etat: "erreur", debut: this.tickets.get(id)!.debut, fin: Date.now(),
          erreur: err instanceof Error ? err.message : String(err) };
        this.publier(t);
        return t;
      });
    return { ticket: id, termine };
  }
}
