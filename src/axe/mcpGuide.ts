/**
 * mcp-guide — Réglages > MCP : ajout guidé d'un serveur personnalisé (programme local
 * « stdio » ou serveur distant HTTP), état lisible de chaque serveur et erreurs expliquées.
 */
import type { McpEnvVar, McpServerConfig } from "../types";
import { catalogSlug } from "./mcpCatalog";

export type ModeServeurPerso = "stdio" | "http";

export type SaisieServeurPerso = {
  mode: ModeServeurPerso;
  nom: string;
  /** Ligne de commande complète (stdio), ex. « npx -y @scope/serveur --option ». */
  commande: string;
  /** Variables d'environnement, une par ligne : CLE=valeur (stdio). */
  env: string;
  /** Adresse du serveur distant (http). */
  url: string;
  /** Jeton facultatif (http) ; vide = connexion par le navigateur si le serveur la gère. */
  jeton: string;
};

export const SAISIE_PERSO_VIDE: SaisieServeurPerso = { mode: "stdio", nom: "", commande: "", env: "", url: "", jeton: "" };

/** Découpe une ligne de commande : espaces, guillemets simples ou doubles (sans échappement). */
export function decouperLigneCommande(ligne: string): string[] {
  const parties: string[] = [];
  let courant = "";
  let guillemet: string | null = null;
  let entame = false;
  for (const c of ligne) {
    if (guillemet) {
      if (c === guillemet) guillemet = null;
      else courant += c;
    } else if (c === '"' || c === "'") {
      guillemet = c;
      entame = true;
    } else if (/\s/.test(c)) {
      if (entame || courant) parties.push(courant);
      courant = "";
      entame = false;
    } else {
      courant += c;
    }
  }
  if (entame || courant) parties.push(courant);
  return parties;
}

function lignesEnv(texte: string): { vars: McpEnvVar[]; erreur: string | null } {
  const vars: McpEnvVar[] = [];
  for (const brute of texte.split(/\r?\n/)) {
    const ligne = brute.trim();
    if (!ligne || ligne.startsWith("#")) continue;
    const i = ligne.indexOf("=");
    const cle = i > 0 ? ligne.slice(0, i).trim() : "";
    if (!cle || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(cle)) {
      return { vars, erreur: `Variable « ${ligne.slice(0, 40)} » : écrivez CLE=valeur, une par ligne.` };
    }
    vars.push({ key: cle, value: ligne.slice(i + 1).trim() });
  }
  return { vars, erreur: null };
}

/** Message d'erreur de la saisie, ou null si elle est complète. */
export function validerServeurPerso(saisie: SaisieServeurPerso): string | null {
  if (!saisie.nom.trim()) return "Donnez un nom au serveur.";
  if (saisie.mode === "stdio") {
    if (decouperLigneCommande(saisie.commande).length === 0) return "Indiquez la commande qui lance le serveur.";
    return lignesEnv(saisie.env).erreur;
  }
  const url = saisie.url.trim();
  if (!url) return "Indiquez l'adresse du serveur (souvent https://…/mcp).";
  let lue: URL;
  try {
    lue = new URL(url);
  } catch {
    return "Adresse illisible : écrivez-la en entier, par exemple https://exemple.fr/mcp.";
  }
  if (lue.protocol !== "https:" && lue.protocol !== "http:") return "L'adresse doit commencer par https:// (ou http:// en local).";
  return null;
}

/** Configuration réelle d'un serveur personnalisé, avec un identifiant libre parmi `idsExistants`. */
export function construireServeurPerso(saisie: SaisieServeurPerso, idsExistants: string[]): McpServerConfig {
  const pris = new Set(idsExistants);
  const base = `mcp_${catalogSlug(saisie.nom.trim())}`;
  let id = base;
  for (let n = 2; pris.has(id); n++) id = `${base}_${n}`;
  const commun = { id, name: saisie.nom.trim(), headers: [], cwd: null, enabled: true };
  if (saisie.mode === "http") {
    const jeton = saisie.jeton.trim();
    return {
      ...commun,
      command: "",
      url: saisie.url.trim(),
      args: [],
      env: [],
      auth: jeton ? { type: "bearer", token: jeton, scopes: [] } : null,
    };
  }
  const [command = "", ...args] = decouperLigneCommande(saisie.commande);
  return { ...commun, command, url: null, args, env: lignesEnv(saisie.env).vars, auth: null };
}

// ---- État et erreurs ------------------------------------------------------------

export type SondeMcp = {
  ok: boolean;
  tools: unknown[];
  authRequired?: boolean;
  error?: string | null;
};

export type EtatMcp = { ton: "off" | "pending" | "ok" | "auth" | "error"; libelle: string };

/** État affiché dans la liste des serveurs. */
export function etatServeurMcp(serveur: { enabled: boolean }, sonde: SondeMcp | null | undefined, verification: boolean): EtatMcp {
  if (!serveur.enabled) return { ton: "off", libelle: "Désactivé" };
  if (!sonde) return { ton: "pending", libelle: verification ? "Vérification…" : "En attente" };
  if (sonde.ok) {
    const n = sonde.tools.length;
    return { ton: "ok", libelle: `Connecté · ${n} outil${n > 1 ? "s" : ""}` };
  }
  if (sonde.authRequired) return { ton: "auth", libelle: "Connexion requise" };
  return { ton: "error", libelle: "Erreur" };
}

/** Masque ce qui ressemble à un secret dans un journal (jetons, clés, mots de passe d'URL). */
export function masquerSecrets(texte: string): string {
  return texte
    .replace(/(bearer\s+)[^\s"',;]+/gi, "$1****")
    .replace(/([?&](?:token|access_token|api[_-]?key|key|secret|password|auth)=)[^&\s"']+/gi, "$1****")
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1****@")
    .replace(/\b(ghp_|gho_|github_pat_|glpat-|sk-|sk_live_|xox[abposr]-|AKIA|AIza|eyJ)[A-Za-z0-9_\-.]{4,}/g, "$1****")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s"',;]+/gi, "$1****");
}

export type ErreurExpliquee = { titre: string; conseil: string; journal: string };

/** Erreur brute d'un serveur -> titre et conseil en français ; le journal (masqué) reste consultable. */
export function expliquerErreurMcp(
  erreur: string | null | undefined,
  contexte: { transport: string; authRequired?: boolean },
): ErreurExpliquee | null {
  if (!erreur && !contexte.authRequired) return null;
  const brut = erreur ?? "";
  const journal = masquerSecrets(brut);
  const e = brut.toLowerCase();
  const avec = (titre: string, conseil: string): ErreurExpliquee => ({ titre, conseil, journal });
  if (contexte.authRequired || /\b401\b|unauthori[sz]ed|authentication required|invalid_token/.test(e)) {
    return avec(
      "Connexion requise",
      "Ce serveur demande une autorisation : « Se connecter » ouvre le navigateur (si le serveur le permet), sinon ajoutez un jeton.",
    );
  }
  const spawn = /unable to spawn `([^`]+)`/.exec(brut);
  if (spawn || /no such file or directory|os error 2|enoent|cannot find the file|introuvable/.test(e)) {
    const cmd = spawn?.[1] ?? "la commande";
    const aide =
      cmd === "npx" || cmd === "node"
        ? "Installez Node.js (il fournit npx), puis relancez « Tester »."
        : cmd === "uvx" || cmd === "uv"
          ? "Installez uv (il fournit uvx), puis relancez « Tester »."
          : "Installez le programme ou indiquez son chemin complet dans la commande.";
    return avec(`Commande introuvable : ${cmd}`, aide);
  }
  if (/timed out|timeout|délai/.test(e)) {
    return avec(
      "Le serveur ne répond pas",
      "Il démarre peut-être lentement (premier téléchargement par npx ou uvx) : relancez « Tester » dans un instant.",
    );
  }
  if (/closed stdout|exit status|exited|broken pipe/.test(e)) {
    return avec(
      "Le serveur s'est arrêté au démarrage",
      "Le journal ci-dessous montre sa dernière sortie : souvent une clé manquante ou un argument invalide.",
    );
  }
  if (/\b403\b|forbidden/.test(e)) return avec("Accès refusé", "Le compte ou le jeton n'a pas les droits nécessaires sur ce serveur.");
  if (/\b404\b|not found/.test(e)) return avec("Adresse introuvable", "Vérifiez l'adresse du serveur (elle finit souvent par /mcp).");
  if (/connection refused|error sending request|dns|failed to lookup|connect|network/.test(e)) {
    return avec("Serveur injoignable", "Vérifiez l'adresse et la connexion réseau (VPN, pare-feu).");
  }
  if (/invalid json|invalid mcp/.test(e)) {
    return avec("Réponse illisible", "Le programme écrit autre chose que du MCP sur sa sortie : vérifiez la commande et ses options.");
  }
  if (/\b5\d\d\b/.test(e)) return avec("Erreur du serveur distant", "Le serveur a rencontré une erreur : réessayez plus tard.");
  return avec("Erreur du serveur", "Détail dans le journal ci-dessous.");
}
