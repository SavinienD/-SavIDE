// « Ouvrir dans… » (VS Code, Cursor, Zed… trouvés sur le poste), dossier des
// journaux et relance en administrateur (Windows). Appels au système (src-tauri/src/ouvrir_avec.rs).
import { invoke } from "@tauri-apps/api/core";
import { loader } from "@monaco-editor/react";
import { cloudConnectionFromPath } from "../../lib/ipc";

export type Editeur = { id: string; nom: string; dossier: boolean };

let detectes: Promise<Editeur[]> | null = null;

/** Éditeurs trouvés sur ce poste (demandé une fois). */
export function editeursDetectes(): Promise<Editeur[]> {
  detectes ??= invoke<Editeur[]>("editeurs_detectes").catch(() => []);
  return detectes;
}

/** Un dossier d'un espace cloud n'est pas sur ce poste : pas d'éditeur local. */
export function ouvrableLocalement(dossier: string): boolean {
  return !cloudConnectionFromPath(dossier);
}

/** Ouvre le dossier (ou `chemin`, relatif, à la ligne donnée) dans l'éditeur. */
export function ouvrirDansEditeur(editeur: string, dossier: string, chemin?: string, ligne?: number, colonne?: number): Promise<void> {
  return invoke<void>("ouvrir_dans_editeur", {
    input: { editeur, workspacePath: dossier, chemin: chemin ?? null, ligne: ligne ?? null, colonne: colonne ?? null },
  });
}

export function ouvrirDossierJournaux(): Promise<string> {
  return invoke<string>("ouvrir_dossier_journaux");
}

export function relancerAdministrateur(): Promise<void> {
  return invoke<void>("relancer_administrateur");
}

type EditeurMonaco = {
  getModel: () => { uri: { path: string } } | null;
  getPosition: () => { lineNumber: number; column: number } | null;
  hasTextFocus?: () => boolean;
};

/** Ligne et colonne du curseur de l'éditeur intégré dans ce fichier (null s'il n'y est pas ouvert). */
export function positionCurseur(chemin: string): { ligne: number; colonne: number } | null {
  try {
    const monaco = (loader as unknown as { __getMonacoInstance?: () => { editor?: { getEditors?: () => EditeurMonaco[] } } | null }).__getMonacoInstance?.();
    const editeurs = monaco?.editor?.getEditors?.() ?? [];
    const voulu = chemin.replace(/\\/g, "/");
    const candidats = editeurs.filter((e) => decodeURIComponent(e.getModel()?.uri.path ?? "").endsWith(voulu));
    const e = candidats.find((x) => x.hasTextFocus?.()) ?? candidats[candidats.length - 1];
    const p = e?.getPosition();
    return p ? { ligne: p.lineNumber, colonne: p.column } : null;
  } catch {
    return null;
  }
}
