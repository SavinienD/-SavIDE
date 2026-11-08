// automatisations — automatisations simulées pour le banc (RPC `automatisations.*`) :
// scène « automatisations » = "plusieurs" (4 automatisations, historiques, une en cours, une
// en pause, un nom très long) ou "aucune". Données en français, comme sur le poste.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { WS } from "./donnees";

const HEURE = 3_600_000;
const JOUR = 24 * HEURE;

function demainA(h: number, m = 0): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function execution(id: string, statut: string, il_y_a_h: number, duree_s: number, resume: string, extra: any = {}): any {
  const debut = Date.now() - il_y_a_h * HEURE;
  const fini = statut !== "en_cours" && statut !== "verification";
  return {
    id, declencheur: "horaire", prevueMs: debut, debutMs: debut, statut, resume: fini ? resume : undefined,
    finMs: fini ? debut + duree_s * 1000 : undefined, sessionId: fini || statut === "en_cours" ? `auto-s-${id}` : undefined, ...extra,
  };
}

function liste(): any[] {
  const modele = { provider: "anthropic", name: "claude-opus-5-5" };
  const base = (id: string, nom: string, horaire: any, horaireTexte: string, extra: any = {}) => ({
    id, nom, dossier: WS, prompt: "Trie les tickets ouverts du support par client et par urgence, sans rien modifier, puis résume.",
    modele, horaire, horaireTexte, memeConversation: false, active: true, rattrapage: true, creeMs: Date.now() - 30 * JOUR,
    modifieMs: Date.now() - 2 * JOUR, prochaineMs: demainA(8), historique: [], enCours: false, ...extra,
  });
  return [
    base("a-tickets", "Tri des tickets du support du matin", { type: "hebdomadaire", jours: [1, 2, 3, 4, 5], heure: "08:00" }, "Du lundi au vendredi à 8 h", {
      verification: "git pull --ff-only",
      historique: [
        execution("x1", "reussie", 2, 184, "12 tickets ouverts : 3 urgents (deux pannes de messagerie, un accès VPN), 9 en attente de réponse client. Aucun ticket modifié."),
        execution("x2", "sautee", 26, 2, "Vérification en échec (code 1) — fatal: unable to access 'https://git.exemple.org/support/tickets.git/': Could not resolve host"),
        execution("x3", "echouee", 50, 41, "retryable stream error: HTTP 529 Overloaded: le service du modèle est surchargé, réessayez plus tard."),
        execution("x4", "reussie", 74, 203, "9 tickets ouverts, 1 urgent (accès VPN). Rapport DMARC reçu et classé."),
        execution("x5", "reussie", 98, 167, "14 tickets ouverts, aucun urgent.", { declencheur: "rattrapage", manquees: 2 }),
      ],
    }),
    base("a-quotas", "Veille des quotas des abonnements", { type: "intervalle", heures: 2, minute: 0 }, "Toutes les 2 heures (0 h, 2 h, 4 h…)", {
      enCours: true, prochaineMs: Date.now() + 1.5 * HEURE, memeConversation: true,
      historique: [execution("x6", "en_cours", 0.1, 0, ""), execution("x7", "reussie", 2.1, 48, "Quotas : Claude Max 41 %, ChatGPT Plus 12 %. Rien à signaler.")],
    }),
    base("a-factures", "Rapprochement des factures d'hébergement d'octobre avec l'export comptable des deux cabinets clients", { type: "quotidien", heure: "07:30" }, "Tous les jours à 7 h 30", {
      prochaineMs: demainA(7, 30), modele: { provider: "openai", name: "gpt-5.5" },
      historique: [execution("x8", "reussie", 27, 312, "Toutes les lignes rapprochées sauf 2 (écart de 0,40 € sur la facture FR-2026-10-1187).")],
    }),
    base("a-harnais", "Sauvegarde du harnais", { type: "cron", expression: "0 22 * * 0" }, "Cron « 0 22 * * 0 »", {
      active: false, prochaineMs: undefined, historique: [execution("x9", "arretee", 170, 12, "Arrêtée depuis l'écran des automatisations.")],
    }),
  ];
}

function texteHoraire(h: any): string {
  if (!h) return "";
  if (h.type === "quotidien") return `Tous les jours à ${String(h.heure).replace(/^0?(\d+):00$/, "$1 h").replace(/^0?(\d+):(\d\d)$/, "$1 h $2")}`;
  if (h.type === "hebdomadaire") return "Les jours cochés à " + h.heure;
  if (h.type === "intervalle") return `Toutes les ${h.heures} heures`;
  if (h.type === "cron") {
    if (String(h.expression).trim().split(/\s+/).length !== 5) throw new Error("protocol error: Expression cron : 5 champs attendus (minute heure jour mois jour-de-semaine), par exemple « 0 8 * * 1-5 ».");
    return `Cron « ${String(h.expression).trim()} »`;
  }
  return "";
}

export function simulationAutomatisations(scene: Record<string, unknown>) {
  let automatisations: any[] = scene.automatisations === "aucune" ? [] : liste();
  const modele = (m: any) => (typeof m === "string" && m.includes("/") ? { provider: m.split("/")[0], name: m.split("/").slice(1).join("/") } : m);
  return (methode: string, p: any): any => {
    switch (methode) {
      case "automatisations.lister":
        return { automatisations, maintenantMs: Date.now() };
      case "automatisations.apercu":
        return { texte: texteHoraire(p?.horaire), prochaines: [demainA(8), demainA(8) + JOUR, demainA(8) + 2 * JOUR] };
      case "automatisations.creer": {
        const a = { id: `a-${automatisations.length + 1}`, ...p, modele: modele(p.modele), horaireTexte: texteHoraire(p.horaire), historique: [], enCours: false, creeMs: Date.now(), modifieMs: Date.now(), prochaineMs: demainA(8) };
        automatisations = [...automatisations, a];
        return a;
      }
      case "automatisations.modifier":
        automatisations = automatisations.map((a) => (a.id === p.id ? { ...a, ...p, modele: p.modele ? modele(p.modele) : a.modele, horaireTexte: p.horaire ? texteHoraire(p.horaire) : a.horaireTexte } : a));
        return automatisations.find((a) => a.id === p.id);
      case "automatisations.supprimer":
        automatisations = automatisations.filter((a) => a.id !== p.id);
        return { ok: true };
      case "automatisations.lancer": {
        const x = execution(`m-${Date.now()}`, "en_cours", 0, 0, "", { declencheur: "manuel" });
        automatisations = automatisations.map((a) => (a.id === p.id ? { ...a, enCours: true, historique: [x, ...a.historique] } : a));
        return x;
      }
      case "automatisations.arreter":
        return { ok: true };
      case "sessions.tree": {
        const id = String(p?.sessionId ?? "");
        const message = (role: string, text: string) => ({ role, parts: [{ type: "text", text }] });
        const entries = [
          { id: "e1", ts: Date.now() - 200_000, kind: "message", message: message("user", "Trie les tickets ouverts du support par client et par urgence, sans rien modifier, puis résume.") },
          { id: "e2", parent: "e1", ts: Date.now() - 20_000, kind: "message", message: message("assistant", "12 tickets ouverts : 3 urgents (deux pannes de messagerie, un accès VPN), 9 en attente de réponse client. Aucun ticket modifié.") },
        ];
        return { sessionId: id, leaf: "e2", entries, branches: [] };
      }
      default:
        return undefined;
    }
  };
}

