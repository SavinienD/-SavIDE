// Fichiers et commandes simulés des scènes « editeur-* » (scenes-editeur.mjs) :
// un .md long (côte à côte, défilement, image déposée), un .csv (tri, filtre), un .mmd, une image
// modifiée depuis le dernier commit (avant / après) et un .ts modifié (marques dans la marge).
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as D from "./donnees";

declare global {
  interface Window {
    /** Contenu écrit par fichier (write_workspace_file_command), scènes « editeur-* ». */
    __bancEcrits?: Record<string, string>;
    /** Dernière image enregistrée pour un .md (editeur_image_markdown). */
    __bancImage?: unknown;
  }
}

export const NOTES_MD = "# Mise en service de la téléphonie\n\nProcédure suivie pour le cabinet Martin (12 postes) et l'atelier Durand (5 postes).\n\n## Étape 1 : préparer le fichier d'import\n\nParagraphe de l'étape 1 : on relit la fiche du client, on note les numéros à porter et on prévient l'accueil avant la bascule. Chaque action est consignée dans le ticket pour que l'équipe puisse reprendre sans appeler.\n\n- vérifier la liste des postes\n- noter les numéros courts\n- [ ] prévenir le client la veille\n\n## Étape 2 : créer les postes\n\nParagraphe de l'étape 2 : on relit la fiche du client, on note les numéros à porter et on prévient l'accueil avant la bascule. Chaque action est consignée dans le ticket pour que l'équipe puisse reprendre sans appeler.\n\n- vérifier la liste des postes\n- noter les numéros courts\n- [ ] prévenir le client la veille\n\n```bash\npython import.py --client martin --postes 12\n```\n\n## Étape 3 : configurer les renvois\n\nParagraphe de l'étape 3 : on relit la fiche du client, on note les numéros à porter et on prévient l'accueil avant la bascule. Chaque action est consignée dans le ticket pour que l'équipe puisse reprendre sans appeler.\n\n- vérifier la liste des postes\n- noter les numéros courts\n- [ ] prévenir le client la veille\n\n## Étape 4 : tester les appels entrants\n\nParagraphe de l'étape 4 : on relit la fiche du client, on note les numéros à porter et on prévient l'accueil avant la bascule. Chaque action est consignée dans le ticket pour que l'équipe puisse reprendre sans appeler.\n\n- vérifier la liste des postes\n- noter les numéros courts\n- [ ] prévenir le client la veille\n\n| Poste | Numéro | Renvoi |\n|---|---|---|\n| Accueil | 201 | 202 |\n| Direction | 210 | messagerie |\n\n## Étape 5 : former l'accueil\n\nParagraphe de l'étape 5 : on relit la fiche du client, on note les numéros à porter et on prévient l'accueil avant la bascule. Chaque action est consignée dans le ticket pour que l'équipe puisse reprendre sans appeler.\n\n- vérifier la liste des postes\n- noter les numéros courts\n- [ ] prévenir le client la veille\n\n## Étape 6 : vérifier la messagerie\n\nParagraphe de l'étape 6 : on relit la fiche du client, on note les numéros à porter et on prévient l'accueil avant la bascule. Chaque action est consignée dans le ticket pour que l'équipe puisse reprendre sans appeler.\n\n- vérifier la liste des postes\n- noter les numéros courts\n- [ ] prévenir le client la veille\n\n![Schéma des renvois](images/renvois.png)\n\n## Étape 7 : basculer les numéros\n\nParagraphe de l'étape 7 : on relit la fiche du client, on note les numéros à porter et on prévient l'accueil avant la bascule. Chaque action est consignée dans le ticket pour que l'équipe puisse reprendre sans appeler.\n\n- vérifier la liste des postes\n- noter les numéros courts\n- [ ] prévenir le client la veille\n\n## Étape 8 : clôturer le ticket\n\nParagraphe de l'étape 8 : on relit la fiche du client, on note les numéros à porter et on prévient l'accueil avant la bascule. Chaque action est consignée dans le ticket pour que l'équipe puisse reprendre sans appeler.\n\n- vérifier la liste des postes\n- noter les numéros courts\n- [ ] prévenir le client la veille\n\nFin de la procédure.\n";
const APP_HEAD = "export function total(lignes: number[]): number {\n  let somme = 0;\n  for (const l of lignes) somme += l;\n  return somme;\n}\n\nexport function moyenne(lignes: number[]): number {\n  return total(lignes) / lignes.length;\n}\n\nexport const VERSION = \"1.0\";\n";
export const APP_ACTUEL = "export function total(lignes: number[]): number {\n  return lignes.reduce((a, b) => a + b, 0);\n}\n\nexport function moyenne(lignes: number[]): number {\n  if (!lignes.length) return 0;\n  return total(lignes) / lignes.length;\n}\n";
const DONNEES_CSV = "Client,Ville,Montant,Date\r\nCabinet Martin,Lyon,1250.5,2026-01-01\r\nAtelier Durand,Paris,993,2026-06-08\r\nGarage Petit,Marseille,15426,2026-11-15\r\nBoulangerie Roux,Lyon,126.25,2026-04-22\r\nPharmacie Morel,Nantes,3252,2026-09-01\r\nStudio Faure,Lille,705,2026-02-08\r\nCabinet Lambert,Lyon,12078,2026-07-15\r\nHôtel Garnier,Bordeaux,546.9,2026-12-22\r\nLibrairie Blanc,Toulouse,2314,2026-05-01\r\nAgence Chevalier,Paris,216,2026-10-08\r\nClinique Robin,Lyon,1380.5,2026-03-15\r\nMenuiserie Henry,Paris,1123,2026-08-22\r\nOptique Mercier,Marseille,15556,2026-01-01\r\nTransports Dupont,Lyon,256.25,2026-06-08\r\nFleurs Leroy,Nantes,3382,2026-11-15\r\nNotaires Moreau,Lille,835,2026-04-22\r\nImprimerie Simon,Lyon,12208,2026-09-01\r\nTraiteur Michel,Bordeaux,676.9,2026-02-08\r\nAuto-école Lefebvre,Toulouse,2444,2026-07-15\r\nCave Bertrand,Paris,346,2026-12-22\r\nCrèche Girard,Lyon,1510.5,2026-05-01\r\nTaxi Bonnet,Paris,1253,2026-10-08\r\nSport Dupuis,Marseille,15686,2026-03-15\r\nCoiffure Lambert,Lyon,386.25,2026-08-22\r\n";
const FLUX_MMD = "flowchart LR\n  A[Ticket reçu] --> B{Urgent ?}\n  B -- oui --> C[Appel du client]\n  B -- non --> D[File du jour]\n  C --> E[Résolu]\n  D --> E\n";
const LOGO_HEAD = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAYAAAABtjuPAAABH0lEQVR42u3SMQ0AIAwAwSphR0PdIZoVRDA0KTe8gc/FmHmkqsIEASgAJQAFoASgAJQAFIASgAJQAlAASgAKQAlAASgBKACllgBzbT0GIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAgigAAQQQAAFIIAAAigAAQQQQAEIIIAACkAAAQRQAAIIIIACEEAAARSAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAQgggAAKQAABBFAAAggggAIQQAABFIAAAgigAAQQQAAFoASgAJQAFIASgAJQAlAASgAKQAlAASgAJQAFoASgAJQA1Add+gIEGYskhuUAAAAASUVORK5CYII=";
const LOGO_ACTUEL = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAYAAAABtjuPAAABcElEQVR42u3dMQ2AQBBE0e3xQI8G1ODfAgmIILBL5hXfwNzLVYSrddsvqasyggAUgBKAAlACUABKAApACUABKAEoACUABaAE4IDOY7EDgO8Ce5odAfwcHYwAjoIHIoDt6GAEcBy+dIQF3gIigPClIiz4IAQQvFiIBR+EAMIXixBAAAGELxdhwQchgPDFIgQQQADhy0VY8EEIIIAAAggggPDFIQQQQADhy0UIIIAAAgggfBACCCCAAAIIIIAAAggggAACCCCAAAIIIHwQAgihGxBAAAEEEEAAAQQQPAABBBBAAQgggL6Ihg9AAAEEEEAAIYQPQAABhBA+AAEEEEAA/SEVPgAhhA9AAAGEED4vJcEHIITeigMQQAAh9F4whPABCGIIvEiAf0GYdB5xAKcjTDuLSIATIaaeQTTAKQiT948H2IXR3gC2QLQvgJ9jtCOArwK1A4ACUAJQAEoACkAJQAEoASgAJQAFoASgAJQAVHM3sC29jbTzxfIAAAAASUVORK5CYII=";

const TEXTES: Record<string, string> = { "notes.md": NOTES_MD, "app.ts": APP_ACTUEL, "donnees.csv": DONNEES_CSV, "flux.mmd": FLUX_MMD };
const NOMS = ["app.ts", "donnees.csv", "flux.mmd", "logo.png", "notes.md"];
const absolu = (rel: string) => D.WS + "\\" + rel.replace(/\//g, "\\");
const encoder = (texte: string) => btoa(String.fromCharCode(...new TextEncoder().encode(texte)));

function doc(rel: string, content: string | null) {
  const image = rel === "logo.png";
  return {
    name: rel.split("/").pop(), relativePath: rel, absolutePath: absolu(rel), editable: !image, content: image ? null : content,
    reason: image ? "Binary file is not editable yet." : null, size: image ? atob(LOGO_ACTUEL).length : (content ?? "").length,
    lastModifiedMs: D.T0, imageMediaType: image ? "image/png" : null, imageData: image ? LOGO_ACTUEL : null,
  };
}

export function simulationEditeur(scene: Record<string, unknown>, h: Record<string, (a: any, args?: any) => any>) {
  const ecrits: Record<string, string> = {};
  window.__bancEcrits = ecrits;
  const nomDe = (chemin: string) => chemin.split(/[\\/]/).pop() ?? "";
  return {
    list_workspace_entries_command: (a: any, args: any) => {
      const dossier = a.relativePath ?? a.input?.relativePath ?? "";
      const liste = h.list_workspace_entries_command(a, args) ?? [];
      if (dossier) return liste;
      return [...liste, ...NOMS.map((name, i) => ({ name, relativePath: name, absolutePath: absolu(name), kind: "file", hasChildren: false, modifiedMs: D.T0 - i * 60_000, size: 400 + i }))];
    },
    read_workspace_file_command: (a: any, args: any) => {
      const rel = a.relativePath ?? "";
      if (rel === "logo.png") return doc(rel, null);
      if (rel in TEXTES) return doc(rel, ecrits[rel] ?? TEXTES[rel]);
      return h.read_workspace_file_command(a, args);
    },
    write_workspace_file_command: (a: any, args: any) => {
      const rel = a.relativePath ?? "";
      if (!(rel in TEXTES)) return h.write_workspace_file_command(a, args);
      ecrits[rel] = a.content ?? "";
      window.__bancEcrit = a.content ?? ""; // témoin « ecritcontient: »
      return { ...doc(rel, a.content ?? ""), lastModifiedMs: Date.now() };
    },
    // Version au dernier commit : app.ts et logo.png modifiés, notes.md inchangé, le reste nouveau.
    editeur_fichier_head: (a: any) => {
      const nom = nomDe(String(a.chemin ?? ""));
      if (nom === "app.ts") return { etat: "suivi", modifie: true, base64: encoder(APP_HEAD), taille: APP_HEAD.length };
      if (nom === "logo.png") return { etat: "suivi", modifie: true, base64: LOGO_HEAD, taille: atob(LOGO_HEAD).length };
      if (nom === "notes.md") return { etat: "suivi", modifie: false, base64: encoder(NOTES_MD), taille: NOTES_MD.length };
      return { etat: scene.horsDepot ? "hors-depot" : "nouveau", modifie: false, base64: null, taille: 0 };
    },
    editeur_image_markdown: (a: any) => {
      window.__bancImage = a;
      const nom = a.source ? nomDe(String(a.source)).replace(/\s+/g, "-") : `${a.nom ?? "image"}.png`;
      return { relatif: `images/${nom}`, absolu: D.WS + "\\images\\" + nom };
    },
  };
}
