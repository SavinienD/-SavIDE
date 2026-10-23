// Trouve le navigateur de test (chrome-headless-shell) ; l'installe s'il manque.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DOSSIER_NAVIGATEURS =
  process.env.AXECODE_AUDIT_NAVIGATEURS ?? join(homedir(), ".cache", "axecode-audit-affichage");

function chercher(dossier) {
  const base = join(dossier, "chrome-headless-shell");
  if (!existsSync(base)) return null;
  const versions = readdirSync(base).sort().reverse();
  for (const v of versions) {
    const exe = join(base, v, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(exe)) return exe;
  }
  return null;
}

export async function trouverNavigateur() {
  if (process.env.AXECODE_AUDIT_CHROME && existsSync(process.env.AXECODE_AUDIT_CHROME)) {
    return process.env.AXECODE_AUDIT_CHROME;
  }
  const deja = chercher(DOSSIER_NAVIGATEURS);
  if (deja) return deja;
  console.log(`Navigateur de test absent : installation dans ${DOSSIER_NAVIGATEURS}…`);
  const b = await import("@puppeteer/browsers");
  const plateforme = b.detectBrowserPlatform();
  const buildId = await b.resolveBuildId(b.Browser.CHROMEHEADLESSSHELL, plateforme, "stable");
  const res = await b.install({ browser: b.Browser.CHROMEHEADLESSSHELL, buildId, cacheDir: DOSSIER_NAVIGATEURS });
  return res.executablePath;
}
