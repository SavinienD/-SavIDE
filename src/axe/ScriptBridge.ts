// axe:e4 — passerelle temps réel avec le daemon (ws://localhost:8090/prime).
//
// Protocole : le daemon envoie {type:'run', script, args} ; on répond
// {type:'result', script, outcome, error?}. Reconnexion avec délai croissant.
import type { ScriptRegistry } from "./ScriptRegistry";

// Plan E4 §3.3 : la passerelle vit sous /ws/passerelle (rôle dev pour l'app).
export const URL_PONT = "ws://localhost:8090/ws/passerelle?role=dev";

export type MessageRun = { type: "run"; script: string; args?: unknown; id?: string };
export type MessageResult = {
  type: "result";
  script: string;
  outcome: unknown;
  error?: string;
  id?: string;
};

type WsLike = {
  send(data: string): void;
  close(): void;
  onopen: ((e?: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
};

export type Executeur = (script: string, args: unknown) => Promise<unknown>;

export class ScriptBridge {
  private ws: WsLike | null = null;
  private arrete = false;
  private essais = 0;
  private minuterie: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private executer: Executeur,
    private url: string = URL_PONT,
    private fabrique: (url: string) => WsLike = (u) => new WebSocket(u) as unknown as WsLike,
  ) {}

  static depuisRegistre(registre: ScriptRegistry, url?: string) {
    return new ScriptBridge((script) => registre.run(script), url);
  }

  connecter(): void {
    this.arrete = false;
    const ws = this.fabrique(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.essais = 0;
    };
    ws.onmessage = (e) => void this.recevoir(ws, e.data);
    ws.onclose = () => this.planifier();
    ws.onerror = () => {
      /* onclose suit : c'est lui qui replanifie */
    };
  }

  private planifier(): void {
    if (this.arrete) return;
    const delai = Math.min(30_000, 500 * 2 ** this.essais++);
    this.minuterie = setTimeout(() => this.connecter(), delai);
  }

  private async recevoir(ws: WsLike, data: unknown): Promise<void> {
    let msg: MessageRun;
    try {
      msg = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return; // message illisible : ignoré, jamais de plantage du pont
    }
    if (!msg || msg.type !== "run" || typeof msg.script !== "string") return;
    const reponse: MessageResult = { type: "result", script: msg.script, outcome: null };
    if (msg.id) reponse.id = msg.id;
    try {
      reponse.outcome = await this.executer(msg.script, msg.args);
    } catch (err) {
      reponse.error = err instanceof Error ? err.message : String(err);
    }
    ws.send(JSON.stringify(reponse));
  }

  fermer(): void {
    this.arrete = true;
    if (this.minuterie) clearTimeout(this.minuterie);
    this.ws?.close();
    this.ws = null;
  }
}
