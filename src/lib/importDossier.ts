// axe:import — copie un dossier local dans l'espace cloud (sous-dossier du même nom), puis l'appelant bascule dessus.
import { invoke } from "@tauri-apps/api/core";
import { api } from "./ipc";

export type Progression = (fait: number, total: number) => void;

export async function importerDossier(dossierLocal: string, espace: string, onProgres?: Progression) {
  const nom = dossierLocal.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "import";
  const { fichiers, ignores } = await invoke<{ fichiers: { chemin: string; contenu: string }[]; ignores: number }>(
    "local_folder_files", { dir: dossierLocal });
  const dossiers = new Set<string>();
  for (const f of fichiers) {
    const parts = `${nom}/${f.chemin}`.split("/");
    for (let i = 1; i < parts.length; i += 1) dossiers.add(parts.slice(0, i).join("/"));
  }
  for (const d of [...dossiers].sort((a, b) => a.split("/").length - b.split("/").length)) {
    const i = d.lastIndexOf("/");
    await api.createDirectory(espace, i < 0 ? null : d.slice(0, i), d.slice(i + 1)).catch(() => undefined);
  }
  let fait = 0;
  for (const f of fichiers) {
    await api.writeFile(espace, `${nom}/${f.chemin}`, f.contenu);
    onProgres?.((fait += 1), fichiers.length);
  }
  return { nom, copies: fichiers.length, ignores };
}
