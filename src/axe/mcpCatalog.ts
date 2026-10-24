// axe:e7 — catalogue des serveurs MCP courants.
// Chaque entrée décrit un serveur prêt à l'emploi : identifiant, nom, courte
// description, commande d'installation canonique, commande réelle de lancement
// et variables attendues (clé API, dossier, chaîne de connexion…).
import type { McpEnvVar, McpServerConfig } from "../types";

export type McpCatalogVar = {
  // Nom de la variable (clé d'environnement) ou, pour kind "arg", marqueur.
  key: string;
  // Libellé affiché dans le formulaire (français).
  label: string;
  // Saisie masquée (mot de passe) et valeur traitée comme secret.
  secret?: boolean;
  required?: boolean;
  // "env" (défaut) place la valeur dans l'environnement ; "arg" la passe au
  // serveur comme argument de la commande.
  kind?: "env" | "arg";
  placeholder?: string;
  help?: string;
};

export type McpCatalogEntry = {
  id: string;
  name: string;
  description: string;
  // Commande d'installation canonique, affichée comme repère à l'utilisateur.
  install: string;
  // Commande réellement lancée par l'application.
  command: string;
  args: string[];
  vars: McpCatalogVar[];
  note?: string;
};

export type McpCatalogValues = Record<string, string>;

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Dépôts, pull requests, issues et Actions GitHub.",
    install: "npx -y @modelcontextprotocol/server-github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    vars: [
      {
        key: "GITHUB_PERSONAL_ACCESS_TOKEN",
        label: "Jeton d'accès personnel (GITHUB_PERSONAL_ACCESS_TOKEN)",
        secret: true,
        required: true,
        placeholder: "ghp_…",
        help: "Jeton classique ou fine-grained, avec les dépôts souhaités.",
      },
    ],
    note: "Le jeton est stocké localement et n'est jamais affiché.",
  },
  {
    id: "filesystem",
    name: "Système de fichiers",
    description: "Lire et écrire des fichiers dans un dossier autorisé.",
    install: "npx -y @modelcontextprotocol/server-filesystem <dossier>",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    vars: [
      {
        key: "MCP_FILESYSTEM_PATH",
        label: "Dossier autorisé",
        kind: "arg",
        required: true,
        placeholder: "/chemin/vers/le/dossier",
      },
    ],
    note: "Le dossier est transmis au serveur comme argument.",
  },
  {
    id: "playwright",
    name: "Navigateur (Playwright)",
    description: "Automatiser un navigateur pour tester ou extraire des pages.",
    install: "npx -y @playwright/mcp@latest",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    vars: [],
    note: "Aucune clé requise : le navigateur est lancé localement.",
  },
  {
    id: "blender",
    name: "Blender",
    description: "Modélisation 3D : créer et manipuler des objets dans Blender.",
    install: "uvx blender-mcp",
    command: "uvx",
    args: ["blender-mcp"],
    vars: [],
    note: "Nécessite Blender ouvert avec l'addon blender-mcp (port 9876).",
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Exécuter des requêtes SQL sur une base PostgreSQL.",
    install: "npx -y @modelcontextprotocol/server-postgres <connexion>",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    vars: [
      {
        key: "POSTGRES_CONNECTION_STRING",
        label: "Chaîne de connexion",
        kind: "arg",
        secret: true,
        required: true,
        placeholder: "postgresql://utilisateur:motdepasse@hote:5432/base",
        help: "La chaîne contient le mot de passe : elle est masquée.",
      },
    ],
  },
  {
    id: "sqlite",
    name: "SQLite",
    description: "Exécuter des requêtes SQL sur un fichier SQLite.",
    install: "uvx mcp-server-sqlite --db-path <fichier>",
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path"],
    vars: [
      {
        key: "SQLITE_DB_PATH",
        label: "Fichier de base",
        kind: "arg",
        required: true,
        placeholder: "/chemin/vers/base.sqlite",
      },
    ],
    note: "Le serveur ouvre le fichier en lecture/écriture.",
  },
  {
    id: "brave-search", name: "Brave Search", description: "Recherche web via l'API Brave.",
    install: "npx -y @modelcontextprotocol/server-brave-search", command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"],
    vars: [{ key: "BRAVE_API_KEY", label: "Clé API Brave", secret: true, required: true }],
  },
  {
    id: "fetch", name: "Fetch", description: "Lire une page web en Markdown.",
    install: "uvx mcp-server-fetch", command: "uvx", args: ["mcp-server-fetch"],
    vars: [],
  },
  {
    id: "memory", name: "Mémoire (graphe)", description: "Mémoire persistante en graphe de connaissances.",
    install: "npx -y @modelcontextprotocol/server-memory", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"],
    vars: [],
  },
  {
    id: "sequential-thinking", name: "Réflexion séquentielle", description: "Décompose un problème en étapes.",
    install: "npx -y @modelcontextprotocol/server-sequential-thinking", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    vars: [],
  },
  {
    id: "git", name: "Git", description: "Lire et manipuler un dépôt Git local.",
    install: "uvx mcp-server-git", command: "uvx", args: ["mcp-server-git"],
    vars: [],
  },
  {
    id: "time", name: "Heure et fuseaux", description: "Heure courante et conversions de fuseaux.",
    install: "uvx mcp-server-time", command: "uvx", args: ["mcp-server-time"],
    vars: [],
  },
  {
    id: "slack", name: "Slack", description: "Canaux, messages et utilisateurs Slack.",
    install: "npx -y @modelcontextprotocol/server-slack", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"],
    vars: [{ key: "SLACK_BOT_TOKEN", label: "Jeton bot (xoxb-…)", secret: true, required: true }, { key: "SLACK_TEAM_ID", label: "ID de l'espace", secret: false, required: true }],
  },
  {
    id: "gitlab", name: "GitLab", description: "Projets, MR et issues GitLab.",
    install: "npx -y @modelcontextprotocol/server-gitlab", command: "npx", args: ["-y", "@modelcontextprotocol/server-gitlab"],
    vars: [{ key: "GITLAB_PERSONAL_ACCESS_TOKEN", label: "Jeton GitLab", secret: true, required: true }, { key: "GITLAB_API_URL", label: "URL de l'API", secret: false, required: true }],
  },
  {
    id: "google-maps", name: "Google Maps", description: "Adresses, itinéraires, lieux.",
    install: "npx -y @modelcontextprotocol/server-google-maps", command: "npx", args: ["-y", "@modelcontextprotocol/server-google-maps"],
    vars: [{ key: "GOOGLE_MAPS_API_KEY", label: "Clé API", secret: true, required: true }],
  },
  {
    id: "puppeteer", name: "Puppeteer", description: "Piloter un Chrome sans tête.",
    install: "npx -y @modelcontextprotocol/server-puppeteer", command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    vars: [],
  },
  {
    id: "notion", name: "Notion", description: "Pages et bases Notion.",
    install: "npx -y @notionhq/notion-mcp-server", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"],
    vars: [{ key: "NOTION_TOKEN", label: "Jeton d'intégration Notion", secret: true, required: true }],
  },
  {
    id: "linear", name: "Linear", description: "Tickets et cycles Linear.",
    install: "npx -y mcp-remote https://mcp.linear.app/sse", command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/sse"],
    vars: [], note: "Connexion OAuth au premier lancement.",
  },
  {
    id: "sentry", name: "Sentry", description: "Erreurs et incidents Sentry.",
    install: "npx -y @sentry/mcp-server", command: "npx", args: ["-y", "@sentry/mcp-server"],
    vars: [{ key: "SENTRY_ACCESS_TOKEN", label: "Jeton Sentry", secret: true, required: true }],
  },
  {
    id: "stripe", name: "Stripe", description: "Paiements, clients, factures.",
    install: "npx -y @stripe/mcp --tools=all", command: "npx", args: ["-y", "@stripe/mcp", "--tools=all"],
    vars: [{ key: "STRIPE_SECRET_KEY", label: "Clé secrète Stripe", secret: true, required: true }],
  },
  {
    id: "supabase", name: "Supabase", description: "Bases et projets Supabase.",
    install: "npx -y @supabase/mcp-server-supabase", command: "npx", args: ["-y", "@supabase/mcp-server-supabase"],
    vars: [{ key: "SUPABASE_ACCESS_TOKEN", label: "Jeton Supabase", secret: true, required: true }],
  },
  {
    id: "mongodb", name: "MongoDB", description: "Requêtes MongoDB.",
    install: "npx -y mongodb-mcp-server", command: "npx", args: ["-y", "mongodb-mcp-server"],
    vars: [{ key: "MDB_MCP_CONNECTION_STRING", label: "Chaîne de connexion", secret: true, required: true }],
  },
  {
    id: "redis", name: "Redis", description: "Clés et valeurs Redis.",
    install: "npx -y @modelcontextprotocol/server-redis", command: "npx", args: ["-y", "@modelcontextprotocol/server-redis"],
    vars: [{ key: "REDIS_URL", label: "URL Redis", secret: true, required: true }],
  },
  {
    id: "grafana", name: "Grafana", description: "Tableaux, requêtes et alertes (lecture).",
    install: "uvx mcp-grafana", command: "uvx", args: ["mcp-grafana"],
    vars: [{ key: "GRAFANA_URL", label: "URL Grafana", secret: false, required: true }, { key: "GRAFANA_API_KEY", label: "Jeton API Grafana", secret: true, required: true }],
  },
  {
    id: "tickets", name: "Jira", description: "Tickets et utilisateurs Jira.",
    install: "npx -y ticket-mcp-server", command: "npx", args: ["-y", "ticket-mcp-server"],
    vars: [{ key: "TICKETS_SUBDOMAIN", label: "Sous-domaine", secret: false, required: true }, { key: "TICKETS_EMAIL", label: "E-mail", secret: false, required: true }, { key: "TICKETS_API_TOKEN", label: "Jeton API", secret: true, required: true }],
  },
  {
    id: "jira", name: "Jira / Confluence", description: "Tickets Jira et pages Confluence.",
    install: "uvx mcp-atlassian", command: "uvx", args: ["mcp-atlassian"],
    vars: [{ key: "JIRA_URL", label: "URL Jira", secret: false, required: true }, { key: "JIRA_USERNAME", label: "E-mail", secret: false, required: true }, { key: "JIRA_API_TOKEN", label: "Jeton API", secret: true, required: true }],
  },
  {
    id: "docker", name: "Docker", description: "Conteneurs, images et journaux.",
    install: "uvx mcp-server-docker", command: "uvx", args: ["mcp-server-docker"],
    vars: [],
  },
  {
    id: "kubernetes", name: "Kubernetes", description: "Pods, déploiements et journaux.",
    install: "npx -y mcp-server-kubernetes", command: "npx", args: ["-y", "mcp-server-kubernetes"],
    vars: [],
  },
  {
    id: "aws-docs", name: "Documentation AWS", description: "Recherche dans la doc AWS.",
    install: "uvx awslabs.aws-documentation-mcp-server@latest", command: "uvx", args: ["awslabs.aws-documentation-mcp-server@latest"],
    vars: [],
  },
  {
    id: "context7", name: "Context7", description: "Documentation à jour des bibliothèques.",
    install: "npx -y @upstash/context7-mcp", command: "npx", args: ["-y", "@upstash/context7-mcp"],
    vars: [],
  },
  {
    id: "excel", name: "Excel", description: "Lire et écrire des classeurs Excel.",
    install: "npx -y @negokaz/excel-mcp-server", command: "npx", args: ["-y", "@negokaz/excel-mcp-server"],
    vars: [],
  },
  {
    id: "obsidian", name: "Obsidian", description: "Notes d'un coffre Obsidian.",
    install: "npx -y mcp-obsidian CHEMIN_DU_COFFRE", command: "npx", args: ["-y", "mcp-obsidian", "CHEMIN_DU_COFFRE"],
    vars: [], note: "Remplacer CHEMIN_DU_COFFRE.",
  },
];

export function findMcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id);
}

export function catalogSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "server";
}

/** Construit la configuration MCP réelle attendue par l'application. */
export function buildMcpServerFromCatalog(
  entry: McpCatalogEntry,
  values: McpCatalogValues,
): McpServerConfig {
  const env: McpEnvVar[] = [];
  const args = [...entry.args];

  for (const variable of entry.vars) {
    const raw = (values[variable.key] ?? "").trim();
    if (!raw) continue;
    if (variable.kind === "arg") {
      args.push(raw);
    } else {
      env.push({ key: variable.key, value: raw });
    }
  }

  return {
    id: `mcp_${catalogSlug(entry.id)}`,
    name: entry.name,
    command: entry.command,
    url: null,
    args,
    env,
    headers: [],
    auth: null,
    cwd: null,
    enabled: true,
  };
}

/** Marqueur utilisé pour remplacer un secret dans la configuration affichée. */
export const MCP_SECRET_PLACEHOLDER = "********";

export function isMcpSecretKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  return /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH|CREDENTIAL|DATABASE_URL|CONNECTION_STRING)/.test(
    normalized,
  );
}

export type McpSecretVault = Map<string, string>;

/// Un argument qui ressemble a un secret (chaine de connexion avec
/// identifiants, jeton d'API connu) ne doit jamais s'afficher : PostgreSQL
/// recoit sa chaine de connexion en argument, par exemple.
export function isSecretArg(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(v)) return true;
  if (/^(ghp_|github_pat_|sk-|sk_live_|xox[baprs]-|eyJ)/.test(v)) return true;
  return false;
}

/** Commande affichable : les arguments secrets sont remplaces par des etoiles. */
export function redactCommand(parts: string[]): string {
  return parts
    .map((part) => (isSecretArg(part) ? MCP_SECRET_PLACEHOLDER : part))
    .join(" ")
    .trim();
}

export function mcpVaultId(
  serverId: string,
  scope: "env" | "header" | "auth" | "arg",
  key: string,
): string {
  return `${serverId}\u0000${scope}\u0000${key}`;
}

/** Releve les valeurs secrètes connues pour permettre le masquage/restore. */
export function collectMcpSecrets(
  settings: { servers: McpServerConfig[] },
  vault: McpSecretVault = new Map(),
): McpSecretVault {
  for (const server of settings.servers) {
    server.args.forEach((arg, index) => {
      if (isSecretArg(arg)) {
        vault.set(mcpVaultId(server.id, "arg", String(index)), arg);
      }
    });
    for (const item of server.env) {
      if (
        isMcpSecretKey(item.key) &&
        item.value &&
        item.value !== MCP_SECRET_PLACEHOLDER
      ) {
        vault.set(mcpVaultId(server.id, "env", item.key), item.value);
      }
    }
    for (const item of server.headers) {
      if (item.value && item.value !== MCP_SECRET_PLACEHOLDER) {
        vault.set(mcpVaultId(server.id, "header", item.key), item.value);
      }
    }
    if (
      server.auth?.token &&
      server.auth.token !== MCP_SECRET_PLACEHOLDER
    ) {
      vault.set(mcpVaultId(server.id, "auth", "token"), server.auth.token);
    }
  }
  return vault;
}

/** Remplace les valeurs secrètes par le marqueur (copie, ne mut pas l'entrée). */
export function redactMcpSecrets(
  settings: { servers: McpServerConfig[] },
  _vault: McpSecretVault,
): { servers: McpServerConfig[] } {
  return {
    servers: settings.servers.map((server) => ({
      ...server,
      args: server.args.map((arg) =>
        isSecretArg(arg) ? MCP_SECRET_PLACEHOLDER : arg,
      ),
      env: server.env.map((item) =>
        isMcpSecretKey(item.key)
          ? { ...item, value: MCP_SECRET_PLACEHOLDER }
          : item,
      ),
      headers: server.headers.map((item) =>
        item.value ? { ...item, value: MCP_SECRET_PLACEHOLDER } : item,
      ),
      auth: server.auth?.token
        ? { ...server.auth, token: MCP_SECRET_PLACEHOLDER }
        : server.auth,
    })),
  };
}

/** Réinjecte les valeurs secrètes stockées quand le marqueur est présent. */
export function restoreMcpSecrets(
  settings: { servers: McpServerConfig[] },
  vault: McpSecretVault,
): { servers: McpServerConfig[] } {
  return {
    servers: settings.servers.map((server) => ({
      ...server,
      args: server.args.map((arg, index) => {
        const id = mcpVaultId(server.id, "arg", String(index));
        if (vault.has(id) && arg === MCP_SECRET_PLACEHOLDER) {
          return vault.get(id)!;
        }
        return arg;
      }),
      env: server.env.map((item) => {
        const id = mcpVaultId(server.id, "env", item.key);
        if (vault.has(id) && item.value === MCP_SECRET_PLACEHOLDER) {
          return { ...item, value: vault.get(id)! };
        }
        return item;
      }),
      headers: server.headers.map((item) => {
        const id = mcpVaultId(server.id, "header", item.key);
        if (vault.has(id) && item.value === MCP_SECRET_PLACEHOLDER) {
          return { ...item, value: vault.get(id)! };
        }
        return item;
      }),
      auth:
        server.auth &&
        vault.has(mcpVaultId(server.id, "auth", "token")) &&
        server.auth.token === MCP_SECRET_PLACEHOLDER
          ? {
              ...server.auth,
              token: vault.get(mcpVaultId(server.id, "auth", "token"))!,
            }
          : server.auth,
    })),
  };
}

// axe:mcp-supprimer — Réglages > MCP « Supprimer » : liste sans le serveur, serveur
// à sélectionner ensuite (le suivant, sinon le précédent, sinon aucun) et secrets
// gardés pour ce serveur oubliés du coffre.
export function retirerServeurMcp(
  settings: { servers: McpServerConfig[] },
  serverId: string,
  vault?: McpSecretVault,
): { servers: McpServerConfig[]; selection: string | null } {
  const index = settings.servers.findIndex((server) => server.id === serverId);
  if (index < 0) {
    return { servers: settings.servers, selection: settings.servers[0]?.id ?? null };
  }
  const servers = settings.servers.filter((server) => server.id !== serverId);
  if (vault) {
    const prefixe = `${serverId}\u0000`;
    for (const cle of [...vault.keys()]) if (cle.startsWith(prefixe)) vault.delete(cle);
  }
  const voisin = servers[index] ?? servers[index - 1] ?? null;
  return { servers, selection: voisin ? voisin.id : null };
}
