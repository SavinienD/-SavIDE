// axe:e4 — registre de scripts « un seul cerveau ».
//
// Une fonction ne se sérialise pas : on persiste sa SOURCE (fn.toString()) et
// ses métadonnées sous `axe:scripts:registry`. Au rechargement, les fonctions
// vivantes de la session gardent la priorité ; sinon la source sert au sandbox.

export type ScriptInfo = {
  name: string;
  source: string;
  origine: "local" | "prime";
  enregistreLe: number;
  primeId?: string;
};

export const CLE_REGISTRE = "axe:scripts:registry";

type Stockage = Pick<Storage, "getItem" | "setItem">;

function stockageParDefaut(): Stockage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export class ScriptRegistry {
  private vivants = new Map<string, () => Promise<unknown>>();
  private infos = new Map<string, ScriptInfo>();

  constructor(private stockage: Stockage | null = stockageParDefaut()) {
    this.recharger();
  }

  /** Relit le stockage (sans planter sur un contenu corrompu). */
  recharger(): void {
    this.infos.clear();
    const brut = this.stockage?.getItem(CLE_REGISTRE);
    if (!brut) return;
    try {
      const liste = JSON.parse(brut) as ScriptInfo[];
      if (!Array.isArray(liste)) return;
      for (const s of liste)
        if (s && typeof s.name === "string" && typeof s.source === "string") this.infos.set(s.name, s);
    } catch {
      /* contenu illisible : registre vide plutôt qu'un plantage */
    }
  }

  private persister(): void {
    try {
      this.stockage?.setItem(CLE_REGISTRE, JSON.stringify(this.list()));
    } catch {
      /* stockage plein : le registre vit le temps de la session */
    }
  }

  register(
    name: string,
    fn: () => Promise<unknown>,
    meta: Partial<Pick<ScriptInfo, "origine" | "primeId" | "source">> = {},
  ): ScriptInfo {
    const nom = name.trim();
    if (!nom) throw new Error("nom de script vide");
    const info: ScriptInfo = {
      name: nom,
      source: meta.source ?? fn.toString(),
      origine: meta.origine ?? "local",
      enregistreLe: Date.now(),
      ...(meta.primeId ? { primeId: meta.primeId } : {}),
    };
    this.vivants.set(nom, fn);
    this.infos.set(nom, info);
    this.persister();
    return info;
  }

  /** Enregistre une source seule (script venu de Prime, pas encore exécutable ici). */
  registerSource(info: Omit<ScriptInfo, "enregistreLe">): ScriptInfo {
    const complet = { ...info, enregistreLe: Date.now() };
    this.infos.set(info.name, complet);
    this.vivants.delete(info.name);
    this.persister();
    return complet;
  }

  unregister(name: string): boolean {
    const existait = this.infos.delete(name);
    this.vivants.delete(name);
    if (existait) this.persister();
    return existait;
  }

  list(): ScriptInfo[] {
    return [...this.infos.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): ScriptInfo | undefined {
    return this.infos.get(name);
  }

  /** Exécute la fonction vivante ; sans elle, c'est au sandbox de jouer la source. */
  async run(name: string): Promise<unknown> {
    const fn = this.vivants.get(name);
    if (!fn) throw new Error(`script « ${name} » sans fonction vivante (passer par le sandbox)`);
    return fn();
  }
}

/** Pont inverse Prime → Axe : GET /prime/api/scripts/:id puis enregistrement local. */
export async function importFromPrime(
  scriptId: string,
  registre: ScriptRegistry,
  fetcher: typeof fetch = fetch,
  base = "",
): Promise<ScriptInfo> {
  const rep = await fetcher(`${base}/prime/api/registre/v1/scripts/${encodeURIComponent(scriptId)}`, {
    credentials: "include",
  });
  if (!rep.ok) throw new Error(`Prime a répondu ${rep.status} pour le script ${scriptId}`);
  const brut = (await rep.json()) as Record<string, any>;
  // Registre v1 : {script, manifeste} ; le code se lit à part (/code). Ancien format : {name, source}.
  let corps = brut as { name?: string; nom?: string; source?: string; code?: string };
  if (brut.manifeste) {
    const c = await fetcher(`${base}/prime/api/registre/v1/scripts/${encodeURIComponent(scriptId)}/code`, { credentials: "include" });
    if (!c.ok) throw new Error(`Prime a répondu ${c.status} pour le code de ${scriptId}`);
    corps = { nom: brut.manifeste.nom ?? scriptId, source: await c.text() };
  }
  const name = (corps.name ?? corps.nom ?? scriptId).trim();
  const source = corps.source ?? corps.code;
  if (typeof source !== "string" || !source) throw new Error(`script ${scriptId} sans source`);
  return registre.registerSource({ name, source, origine: "prime", primeId: scriptId });
}
