// Image collée (presse-papiers) ou déposée (explorateur du système) dans l'éditeur
// d'un .md : enregistrée dans `images/` à côté du fichier (Rust editeur_image_markdown ; espace
// cloud : fs.write_bytes du service, nom daté), puis lien inséré au curseur (collage) ou à
// l'endroit du dépôt. Un collage qui contient du texte reste un collage de texte.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as monacoNs from "monaco-editor";
import type * as Monaco from "monaco-editor";
import { cloudConnectionFromPath, cloudRpc, cloudToService } from "../../lib/ipc";
import type { EditorTab } from "../../types";
import {
  dossierDe,
  estCheminImage,
  extensionDe,
  extensionDuType,
  horodatage,
  lienImage,
  nomImageCollee,
} from "./imagesMarkdown";

/** Relais du dépôt Tauri (Workspace) vers l'éditeur du .md visé par `chemin`. */
export const DEPOT_MARKDOWN_EVENT = "axecode:depot-markdown";
export type DepotMarkdown = { chemin: string; paths: string[]; x: number; y: number };

type Entree = { donnees: string; typeMedia: string; nom: string } | { source: string };
const MAX_CLOUD = 8 * 1024 * 1024;

function lireBase64(fichier: Blob): Promise<string> {
  return new Promise((ok, ko) => {
    const lecteur = new FileReader();
    lecteur.onload = () => ok(String(lecteur.result).split(",")[1] ?? "");
    lecteur.onerror = () => ko(lecteur.error);
    lecteur.readAsDataURL(fichier);
  });
}

function versBase64(octets: ArrayBuffer): string {
  const vue = new Uint8Array(octets);
  let binaire = "";
  for (let i = 0; i < vue.length; i += 0x8000) binaire += String.fromCharCode(...vue.subarray(i, i + 0x8000));
  return btoa(binaire);
}

function notifierEchec(texte: string, espace?: string): void {
  window.dispatchEvent(
    new CustomEvent("ide-notification", { detail: { genre: "echec", titre: "Image non ajoutée", texte, dossier: espace } }),
  );
}

function imagesDuPressePapiers(donnees: DataTransfer): File[] {
  const depuisItems = [...donnees.items]
    .filter((i) => i.kind === "file" && extensionDuType(i.type))
    .map((i) => i.getAsFile())
    .filter((f): f is File => Boolean(f));
  return depuisItems.length ? depuisItems : [...donnees.files].filter((f) => extensionDuType(f.type));
}

/** Enregistre l'image ; renvoie son chemin relatif au .md (« images/… »). */
async function enregistrer(onglet: EditorTab, espace: string | undefined, entree: Entree): Promise<string> {
  const connexion = espace ? cloudConnectionFromPath(espace) : null;
  if (!espace || !connexion) {
    const r = await invoke<{ relatif: string }>("editeur_image_markdown", {
      input: { cheminMarkdown: onglet.doc.absolutePath, ...entree },
    });
    return r.relatif;
  }
  let donnees: string;
  let nom: string;
  let ext: string;
  if ("source" in entree) {
    ext = extensionDe(entree.source);
    const octets = await invoke<ArrayBuffer>("viewer_read_bytes", {
      input: { path: entree.source, offset: 0, length: MAX_CLOUD + 1 },
    });
    if (octets.byteLength > MAX_CLOUD) throw new Error("image trop volumineuse pour l'espace (8 Mo au plus)");
    donnees = versBase64(octets);
    const tige = (entree.source.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "");
    nom = `${tige.replace(/[^\p{L}\p{N}_]+/gu, "-").replace(/^-+|-+$/g, "") || "image"}-${horodatage(new Date())}`;
  } else {
    ext = extensionDuType(entree.typeMedia) ?? "png";
    donnees = entree.donnees;
    nom = entree.nom.replace(/[^\p{L}\p{N}_-]+/gu, "-") || `image-${horodatage(new Date())}`;
  }
  const relatif = `images/${nom}.${ext}`;
  const dossier = dossierDe(onglet.relativePath.replace(/\\/g, "/"));
  await cloudRpc(connexion, "fs.write_bytes", {
    path: cloudToService(espace, dossier ? `${dossier}/${relatif}` : relatif),
    data: donnees,
  });
  return relatif;
}

async function inserer(
  editeur: Monaco.editor.IStandaloneCodeEditor,
  onglet: EditorTab,
  espace: string | undefined,
  entrees: Entree[],
  position: Monaco.IPosition | null,
): Promise<void> {
  const liens: string[] = [];
  for (const entree of entrees) {
    try {
      liens.push(lienImage(await enregistrer(onglet, espace, entree)));
    } catch (err) {
      notifierEchec(err instanceof Error ? err.message : String(err), espace);
    }
  }
  if (!liens.length || !editeur.getModel()) return;
  const range = position
    ? new monacoNs.Range(position.lineNumber, position.column, position.lineNumber, position.column)
    : editeur.getSelection() ?? new monacoNs.Range(1, 1, 1, 1);
  editeur.pushUndoStop();
  editeur.executeEdits("image-markdown", [{ range, text: liens.join("\n"), forceMoveMarkers: true }]);
  editeur.pushUndoStop();
  editeur.focus();
}

/** Branche le collage et le dépôt d'images sur l'éditeur Monaco d'un .md modifiable. */
export function useImagesMarkdown(
  editeur: Monaco.editor.IStandaloneCodeEditor | null,
  onglet: EditorTab | undefined,
  espace: string | undefined,
  version: number,
): void {
  const actif = Boolean(
    onglet && !onglet.external && onglet.doc.editable && /\.(md|markdown|mdx)$/i.test(onglet.relativePath),
  );
  const ongletRef = useRef(onglet);
  ongletRef.current = onglet;
  const espaceRef = useRef(espace);
  espaceRef.current = espace;

  useEffect(() => {
    if (!actif || !editeur) return;
    const noeud = editeur.getDomNode();
    if (!noeud) return;
    const coller = (e: ClipboardEvent) => {
      const donnees = e.clipboardData;
      if (!donnees || donnees.getData("text/plain").trim()) return;
      const fichiers = imagesDuPressePapiers(donnees);
      const o = ongletRef.current;
      if (!fichiers.length || !o) return;
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        const entrees: Entree[] = [];
        for (const f of fichiers) {
          entrees.push({ donnees: await lireBase64(f), typeMedia: f.type, nom: nomImageCollee(f.name, new Date()) });
        }
        await inserer(editeur, o, espaceRef.current, entrees, null);
      })();
    };
    noeud.addEventListener("paste", coller, true);
    return () => noeud.removeEventListener("paste", coller, true);
  }, [actif, editeur, version]);

  useEffect(() => {
    if (!actif || !editeur) return;
    const deposer = (ev: Event) => {
      const d = (ev as CustomEvent<DepotMarkdown>).detail;
      const o = ongletRef.current;
      if (!d || !o || d.chemin !== o.relativePath) return;
      const images = d.paths.filter(estCheminImage);
      if (!images.length) {
        notifierEchec("Seules les images (png, jpg, gif, webp, svg…) s'ajoutent au Markdown.", espaceRef.current);
        return;
      }
      const position = editeur.getTargetAtClientPoint(d.x, d.y)?.position ?? null;
      void inserer(editeur, o, espaceRef.current, images.map((source) => ({ source })), position);
    };
    window.addEventListener(DEPOT_MARKDOWN_EVENT, deposer);
    return () => window.removeEventListener(DEPOT_MARKDOWN_EVENT, deposer);
  }, [actif, editeur, version]);
}
