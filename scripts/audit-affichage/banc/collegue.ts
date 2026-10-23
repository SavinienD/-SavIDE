// Scène « collegue » du banc : un collègue (Camille) connecté à Axe Cloud, AUCUN
// fournisseur d'IA sur son PC ; son espace sur la VM a le fournisseur « axe-cloud »
// (compteur 127.0.0.1:8096, clé axk_ personnelle). Données tirées de son espace
// réel (lecture seule, 22/10) : providers.json = axe-cloud (Opus, Sonnet, Haiku
// 5.5), conversation « test » créée avec axe-cloud/claude-opus-5-5.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as D from "./donnees";

export const CONNEXION = "axe-cloud";
export const RACINE = "/home/collegue/work";
export const WS_CLOUD = `axe-cloud://${CONNEXION}${RACINE}`;
export const MODELE_ESPACE = { provider: "axe-cloud", name: "claude-opus-5-5" };
/** Modèle par défaut d'un PC sans fournisseur (src-tauri/src/lib.rs : google). */
export const MODELE_PC = { provider: "google", name: "gemini-3.8-flash", effort: "medium" };
const ID_TEST = "8b198dda-26f1-4b30-8062-0e4beb705686";
const ID_LOCALE = "c-cloud-accueil";

function meta(id: string, nom: string, modele: any, i: number) {
  return {
    id, name: nom, workspaceId: RACINE, model: modele, status: "idle", parentId: null,
    createdAtMs: D.T0 - i * 60_000, updatedAtMs: D.T0 - i * 30_000, children: [], entryCount: 1, archived: false,
  };
}

function conversation(id: string, titre: string, modele: any) {
  return {
    id, workspaceId: WS_CLOUD, title: titre, model: modele,
    modeModelSettings: { act: modele, plan: modele, goal: modele },
    systemPrompt: "", planWorkflow: { status: "idle" }, goalWorkflow: { status: "idle" }, history: [],
  };
}

/** Commandes simulées de la scène (remplacent celles de la scène par défaut). */
export function simulationCollegue(scene: any, base: Record<string, (a: any, brut: any) => unknown>) {
  // Espace vide (le collègue crée « test » avec « + ») ou déjà doté de « test ».
  const sessions = scene.espaceVide ? [] : [meta(ID_TEST, "test", MODELE_ESPACE, 0)];
  const envois: any[] = [];
  const historiques: Record<string, any[]> = {};
  (window as any).__bancEnvois = envois;
  const daemonBase = base.daemon_call;
  return {
    cloud_state: () => ({
      connected: true, base: "https://cloud.exemple.invalid", email: "collegue@exemple.invalid",
      role: "membre", expireLe: "2026-11-21T08:00:00Z", poste: "PC-COLLEGUE", connectionId: CONNEXION,
    }),
    connections_list: () => ({
      active: CONNEXION,
      connections: [
        { id: "local", name: "Ce PC", kind: "local" },
        { id: CONNEXION, name: "Axe Cloud", kind: "remote", url: "wss://cloud.exemple.invalid/ws", hasToken: true },
      ],
    }),
    connections_state: () => ({ local: "connected", [CONNEXION]: "connected" }),
    open_cloud_workspace: () => ({
      workspace: { path: WS_CLOUD, name: "work" },
      // Liste et conversation active viennent du magasin LOCAL du PC (src-tauri/src/workspace.rs :
      // bootstrap_workspace sur la clé axe-cloud://…) : une conversation d'accueil, modèle par défaut du PC.
      conversations: [{ id: ID_LOCALE, title: "Nouvelle conversation", updatedAtMs: D.T0 }],
      activeConversation: conversation(ID_LOCALE, "Nouvelle conversation", MODELE_PC),
      modeModelSettings: { act: MODELE_PC, plan: MODELE_PC, goal: MODELE_PC },
    }),
    // Magasin et registre du PC (src-tauri/src/conversations.rs:247-259) : il ne connaît que la
    // conversation d'accueil, et exige que le fournisseur choisi soit installé SUR LE PC.
    set_conversation_model_preference: (a: any) => {
      if (a.conversationId !== ID_LOCALE) throw "conversation introuvable";
      const duPc = scene.fournisseur === false ? [] : ["anthropic", "openai"];
      if (!duPc.includes(a.model?.provider)) throw `provider \`${a.model?.provider}\` is not configured or missing credentials`;
      return { act: a.model, plan: a.model, goal: a.model };
    },
    // Compaction et réécriture passent par le magasin et les fournisseurs du PC
    // (src-tauri/src/turns.rs:75-102 et 483-516) : refusées pour une conversation d'espace.
    compact_conversation: (a: any) => {
      if (a.conversationId !== ID_LOCALE) throw "conversation introuvable";
      throw `provider \`${a.model?.provider}\` is not configured or missing credentials`;
    },
    send_message: (a: any) => {
      if (a.rewriteFromHistoryIndex != null && a.conversationId !== ID_LOCALE) throw "conversation introuvable";
      envois.push(a);
      // Le démon de l'espace journalise le message : sessions.history le rendra.
      (historiques[a.conversationId] ??= []).push({ role: "user", parts: [{ type: "text", text: a.text }] });
      if (typeof scene.erreurEnvoi === "string") throw scene.erreurEnvoi;
      return null;
    },
    daemon_call: (a: any, brut: any) => {
      const p = a.params ?? {};
      ((window as any).__bancDaemon ??= []).push(a.method + (Object.keys(p).length ? JSON.stringify(p) : ""));
      switch (a.method) {
        case "fs.root":
          return { path: RACINE, name: "work" };
        case "fs.list":
          return ["clients", "notes"].map((name) => ({ name, kind: "directory" }));
        case "sessions.list":
          return p.archived ? [] : sessions;
        case "sessions.get":
          return sessions.find((s) => s.id === p.sessionId) ?? null;
        case "sessions.history":
          return historiques[p.sessionId] ?? [];
        case "sessions.tree": {
          // Journal de la session : sur le démon de l'ESPACE seulement ; le démon du PC ne la
          // connaît pas (avant D11, /tree lisait le PC : « session not found »).
          if (a.connection !== CONNEXION) throw `session not found: ${p.sessionId}`;
          const entries = (historiques[p.sessionId] ?? []).map((message: any, i: number) => ({
            id: `e-${i + 1}`, parent: i ? `e-${i}` : undefined, ts: D.T0 + i * 1000, kind: "message", message,
          }));
          return { sessionId: p.sessionId, leaf: entries.length ? entries[entries.length - 1].id : undefined, entries, branches: [] };
        }
        case "sessions.create": {
          const m = meta(`s-${sessions.length + 1}`, p.name ?? "Nouvelle conversation", p.model, 0);
          sessions.unshift(m);
          return m;
        }
        case "skills.list":
        case "harness.list":
          return [];
        case "sessions.set_model":
          // Brouillon du PC pas encore envoyé : la session n'existe pas sur l'espace.
          if (!sessions.some((s) => s.id === p.sessionId)) throw `session not found: ${p.sessionId}`;
          return { ok: true };
        default:
          return daemonBase ? daemonBase(a, brut) : null;
      }
    },
  };
}
