import { cloudRpc } from "./ipc";

/// axe:v2-l6 — etat de joignabilite du service pour un espace cloud.
export type CloudStatus = "online" | "offline" | "unknown";

type CloudListener = (status: CloudStatus) => void;

const statusByConnection = new Map<string, CloudStatus>();
const listenersByConnection = new Map<string, Set<CloudListener>>();
const probeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const probeAttempts = new Map<string, number>();
const nextProbeAtMs = new Map<string, number>();

const OFFLINE_FIRST_DELAY_MS = 15_000;
const OFFLINE_DELAY_STEP_MS = 5_000;
const OFFLINE_MAX_DELAY_MS = 60_000;
const ONLINE_CHECK_DELAY_MS = 60_000;

/// Message unique des ecritures que le service n'a vraiment pas pu recevoir :
/// court, sans jargon, sans vocabulaire de synchronisation.
export const CLOUD_OFFLINE_WRITE_MESSAGE =
  "Le service ne répond pas : cette modification n'a pas pu être envoyée.";

export class CloudOfflineError extends Error {
  constructor(message: string = CLOUD_OFFLINE_WRITE_MESSAGE) {
    super(message);
    this.name = "CloudOfflineError";
  }
}

export function getCloudStatus(connection: string): CloudStatus {
  return statusByConnection.get(connection) ?? "unknown";
}

export function isCloudOffline(connection: string): boolean {
  return getCloudStatus(connection) === "offline";
}

export function subscribeCloudStatus(
  connection: string,
  listener: CloudListener,
): () => void {
  let listeners = listenersByConnection.get(connection);
  if (!listeners) {
    listeners = new Set();
    listenersByConnection.set(connection, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) {
      listenersByConnection.delete(connection);
    }
  };
}

function notify(connection: string, status: CloudStatus): void {
  const listeners = listenersByConnection.get(connection);
  if (!listeners) return;
  for (const listener of Array.from(listeners)) {
    try {
      listener(status);
    } catch {
      // un abonne fautif ne doit pas casser la detection.
    }
  }
}

function clearProbeTimer(connection: string): void {
  const timer = probeTimers.get(connection);
  if (timer !== undefined) {
    clearTimeout(timer);
    probeTimers.delete(connection);
  }
  nextProbeAtMs.delete(connection);
}

/// Programme la prochaine sonde hors ligne (15 s, +5 s a chaque echec, max 60 s).
function scheduleOfflineProbe(connection: string): void {
  if (probeTimers.has(connection)) return;
  const attempt = (probeAttempts.get(connection) ?? 0) + 1;
  probeAttempts.set(connection, attempt);
  const delay = Math.min(
    OFFLINE_FIRST_DELAY_MS + (attempt - 1) * OFFLINE_DELAY_STEP_MS,
    OFFLINE_MAX_DELAY_MS,
  );
  nextProbeAtMs.set(connection, Date.now() + delay);
  probeTimers.set(
    connection,
    setTimeout(() => {
      probeTimers.delete(connection);
      nextProbeAtMs.delete(connection);
      void probeCloud(connection);
    }, delay),
  );
}

/// Une verification de sante toutes les 60 s tant que le service repond.
function scheduleOnlineCheck(connection: string): void {
  if (probeTimers.has(connection)) return;
  nextProbeAtMs.set(connection, Date.now() + ONLINE_CHECK_DELAY_MS);
  probeTimers.set(
    connection,
    setTimeout(() => {
      probeTimers.delete(connection);
      nextProbeAtMs.delete(connection);
      void probeCloud(connection);
    }, ONLINE_CHECK_DELAY_MS),
  );
}

function setStatus(connection: string, status: CloudStatus): void {
  const previous = getCloudStatus(connection);
  statusByConnection.set(connection, status);
  if (previous === status) {
    // Un echec supplementaire ne doit pas remettre a zero le retour progressif.
    if (status === "offline") {
      scheduleOfflineProbe(connection);
    } else if (status === "online" && !probeTimers.has(connection)) {
      scheduleOnlineCheck(connection);
    }
    return;
  }
  notify(connection, status);
  clearProbeTimer(connection);
  if (status === "offline") {
    scheduleOfflineProbe(connection);
  } else if (status === "online") {
    probeAttempts.delete(connection);
    scheduleOnlineCheck(connection);
  }
}

export function markCloudOnline(connection: string): void {
  setStatus(connection, "online");
}

export function markCloudOffline(connection: string): void {
  setStatus(connection, "offline");
}

/// Secondes restantes avant la prochaine sonde (pour le title du bandeau).
export function nextCloudProbeInSeconds(connection: string): number {
  const at = nextProbeAtMs.get(connection);
  if (at === undefined) return Math.round(OFFLINE_FIRST_DELAY_MS / 1000);
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/// Sonde `status` : met a jour l'etat via cloudRpc (jamais d'exception remontee).
export async function probeCloud(connection: string): Promise<void> {
  try {
    await cloudRpc(connection, "status", {});
  } catch {
    // cloudRpc a deja classe l'echec (transport -> offline, metier -> online).
  }
}

/// Refuse une ecriture quand le service est connu comme injoignable.
export function assertCloudWritable(connection: string): void {
  if (isCloudOffline(connection)) throw new CloudOfflineError();
}

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return err == null ? "" : String(err);
}

// Erreurs renvoyees par le service lui-meme (il a donc repondu) : jamais hors ligne.
const BUSINESS_ERROR =
  /^(protocol error|io error|journal error|session not found|session busy|runtime error|turn cancelled|invalid request|auth error|rate limited|context window exceeded|network error|decode error|stream error|retryable stream error|unsupported feature|provider error)\b/i;
// Reponses HTTP / configuration : le service est joignable mais refuse la connexion.
const REACHABLE_ERROR =
  /^(authentification refusée|hôte refusé|cible ssh manquante|connexion inconnue|HTTP \d{3})\b/i;
// Echecs de transport : rien n'a repondu.
const TRANSPORT_ERROR = [
  /daemon connection closed/i,
  /daemon request .* timed out/i,
  /daemon did not start/i,
  /cannot start daemon/i,
  /connection timed out/i,
  /\btimed out\b/i,
  /connection (refused|reset|closed|aborted|terminated)/i,
  /connection reset without closing handshake/i,
  /failed to connect/i,
  /connect error/i,
  /error (sending|trying to connect)/i,
  /network is unreachable/i,
  /not connected/i,
  /tunnel ssh ne s'est pas ouvert/i,
  /ssh introuvable/i,
  /\bIO error:\s/i,
  /tls error/i,
  /dns error/i,
  /failed to lookup address/i,
  /websocket protocol error/i,
  /unexpected (eof|end of file)/i,
  /early eof/i,
  /broken pipe/i,
  /certificate/i,
  /os error \d+/i,
];

/// Distingue un echec de transport d'une erreur metier du service.
export function isCloudTransportError(err: unknown): boolean {
  const text = errorText(err).trim();
  if (!text) return true;
  if (BUSINESS_ERROR.test(text)) return false;
  if (REACHABLE_ERROR.test(text)) return false;
  if (TRANSPORT_ERROR.some((pattern) => pattern.test(text))) return true;
  // Erreur inconnue : par prudence on ne declare pas le service hors ligne.
  // La verification periodique (60 s) tranchera si la connexion est tombee.
  return false;
}
