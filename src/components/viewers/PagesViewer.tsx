// documents Apple Pages (.pages). Dans l'ordre de préférence : l'aperçu
// QuickLook/Preview.pdf (visionneuse PDF), sinon le texte extrait des Index/*.iwa (ou de
// l'index.xml d'un Pages ancien), sinon la vignette. « Modifier » ouvre le texte dans l'éditeur
// riche et l'enregistre en .docx à côté (un .pages ne se réécrit pas de façon fiable).

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import { bytesToDataUrl, imageMime } from "./bytes";
import { ViewerError, ViewerLoading } from "./common";
import { DocumentFrame } from "./DocumentFrame";
import { lirePages, type EntreesPages, type ResultatPages } from "./pages";
import { lireTout, voisin, type SourceFichier } from "./sourceFichier";
import { brouillonDe } from "./brouillons";
import { htmlDeParagraphes } from "./docxVersHtml";

const PdfViewer = lazy(() => import("./pdf/PdfViewer"));
const DocxEditeur = lazy(() => import("./DocxEditeur"));

const MAX_PAGES_BYTES = 300 * 1024 * 1024;

type Vue = "pdf" | "texte" | "vignette";
type Props = { path: string; size: number; name: string; espace?: string; relatif?: string };

/** Entrées du zip, Index.zip imbriqué compris (paquets Pages 5). */
async function entreesZip(octets: Uint8Array): Promise<EntreesPages> {
  const zip = await JSZip.loadAsync(octets);
  const fichiers = new Map<string, JSZip.JSZipObject>();
  for (const [nom, f] of Object.entries(zip.files)) if (!f.dir) fichiers.set(nom, f);
  const index = [...fichiers.keys()].find((n) => /(^|\/)Index\.zip$/i.test(n));
  if (index) {
    const interne = await JSZip.loadAsync(await fichiers.get(index)!.async("uint8array"));
    for (const [nom, f] of Object.entries(interne.files)) if (!f.dir && !fichiers.has(nom)) fichiers.set(nom, f);
  }
  return { noms: [...fichiers.keys()], lire: (nom) => fichiers.get(nom)!.async("uint8array") };
}

function echapper(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlLecture(res: ResultatPages): string {
  const p = (t: string) => (t ? `<p style="white-space: pre-wrap">${echapper(t)}</p>` : "<p><br></p>");
  let html = res.paragraphes.map(p).join("");
  if (res.autres.length) html += `<hr><p><em>Autres textes (zones de texte, notes, tableaux)</em></p>${res.autres.map(p).join("")}`;
  return html || "<p><em>Aucun texte trouvé dans ce document.</em></p>";
}

export default function PagesViewer({ path, size, name, espace, relatif }: Props) {
  const [res, setRes] = useState<ResultatPages | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [vue, setVue] = useState<Vue | null>(null);
  const [edition, setEdition] = useState(false);
  const source: SourceFichier = useMemo(() => ({ chemin: path, nom: name, taille: size, espace, relatif }), [path, name, size, espace, relatif]);
  const cible = useMemo(() => voisin(source, `${name.replace(/\.pages$/i, "")}.docx`), [source, name]);

  useEffect(() => {
    let annule = false;
    setRes(null);
    setErreur(null);
    (async () => {
      const octets = await lireTout(source, MAX_PAGES_BYTES);
      if (octets[0] !== 0x50 || octets[1] !== 0x4b) {
        throw new Error("Ce fichier .pages n'est pas une archive lisible (paquet macOS non compressé ou fichier abîmé).");
      }
      const r = await lirePages(await entreesZip(octets));
      if (annule) return;
      setRes(r);
      setVue(r.apercuPdf ? "pdf" : r.paragraphes.length || r.autres.length ? "texte" : r.vignette ? "vignette" : "texte");
      if (brouillonDe(path)?.modifie) setEdition(true);
    })().catch((err) => !annule && setErreur(String(err?.message ?? err)));
    return () => {
      annule = true;
    };
  }, [source, path]);

  const vignette = useMemo(() => {
    if (!res?.vignette) return null;
    return bytesToDataUrl(res.vignette.octets, imageMime(res.vignette.nom) ?? "image/jpeg");
  }, [res]);

  const ouvrirEdition = useCallback(() => setEdition(true), []);

  if (erreur) return <ViewerError icon="solar:document-text-linear" title="Impossible de lire ce document Pages." detail={erreur} />;
  if (!res || !vue) return <ViewerLoading label="Lecture du document Pages…" />;

  if (edition) {
    const texte = [...res.paragraphes, ...(res.autres.length ? ["", ...res.autres] : [])];
    return (
      <Suspense fallback={<ViewerLoading label="Ouverture de l'éditeur…" />}>
        <DocxEditeur
          source={source}
          cible={cible}
          document={{ paquet: null, html: htmlDeParagraphes(texte), pertes: [] }}
          avis={
            <>
              Un fichier .pages ne peut pas être réécrit ici : le texte (sans la mise en page ni les images) sera
              enregistré en Word dans « {cible.nom} », à côté de l&rsquo;original, qui reste intact.
            </>
          }
          onFermer={() => setEdition(false)}
        />
      </Suspense>
    );
  }

  const ancien = res.format === "xml-ancien";
  const avis = ancien
    ? "Document Pages ancien (Pages ’09 ou avant) : texte seul."
    : res.format === "inconnu" && !res.apercuPdf
      ? "Structure Pages non reconnue."
      : res.approximatif
        ? "Texte lu de façon approximative."
        : "";
  const choix: { id: Vue; libelle: string; dispo: boolean }[] = [
    { id: "pdf", libelle: "Aperçu", dispo: Boolean(res.apercuPdf) },
    { id: "texte", libelle: "Texte", dispo: res.format !== "inconnu" || res.paragraphes.length > 0 },
    { id: "vignette", libelle: "Vignette", dispo: Boolean(vignette) },
  ];
  const boutons = (
    <>
      {choix
        .filter((c) => c.dispo)
        .map((c) => (
          <button key={c.id} type="button" className="xv-btn" data-active={vue === c.id ? "true" : undefined} onClick={() => setVue(c.id)}>
            {c.libelle}
          </button>
        ))}
      <button
        type="button"
        className="xv-btn xv-btn--text"
        onClick={ouvrirEdition}
        disabled={!res.paragraphes.length && !res.autres.length}
        title={`Modifier le texte et l'enregistrer en Word (${cible.nom})`}
      >
        Modifier
      </button>
      {avis && <span className="xv-toolbar__hint">{avis}</span>}
    </>
  );

  return (
    <div className="xv-doc axe-pages">
      {vue !== "texte" && <div className="xv-toolbar">{boutons}</div>}
      <div className="axe-pages__corps">
        {vue === "pdf" && res.apercuPdf && (
          <Suspense fallback={<ViewerLoading label="Chargement de l'aperçu…" />}>
            <PdfViewer path={path} size={res.apercuPdf.length} data={res.apercuPdf} />
          </Suspense>
        )}
        {vue === "texte" && <DocumentFrame html={htmlLecture(res)} title={name} toolbar={boutons} />}
        {vue === "vignette" && vignette && (
          <div className="axe-pages__vignette">
            <img src={vignette} alt={`Vignette de ${name}`} />
            <span className="xv-toolbar__hint">Seule la vignette du document est lisible.</span>
          </div>
        )}
      </div>
    </div>
  );
}
