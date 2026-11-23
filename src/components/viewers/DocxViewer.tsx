// viewers — Word (.docx) viewer: mammoth converts the document to clean
// semantic HTML (headings, lists, tables, images inlined as data URIs), shown
// in the sandboxed document frame. Layout (columns, headers/footers, exact
// fonts) is intentionally not reproduced.
// « Modifier » ouvre l'éditeur riche (DocxEditeur) ; la lecture reste le mode par
// défaut. Fichiers du PC et des espaces cloud (sourceFichier).

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { ViewerError, ViewerLoading } from "./common";
import { DocumentFrame } from "./DocumentFrame";
import { lireTout, type SourceFichier } from "./sourceFichier";
import type { DocumentEditable } from "./DocxEditeur";
import { brouillonDe } from "./brouillons";

const DocxEditeur = lazy(() => import("./DocxEditeur"));

const MAX_DOCX_BYTES = 150 * 1024 * 1024;

type Props = { path: string; size: number; name: string; espace?: string; relatif?: string };

export default function DocxViewer({ path, size, name, espace, relatif }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [octets, setOctets] = useState<Uint8Array | null>(null);
  const [warnings, setWarnings] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [edition, setEdition] = useState<DocumentEditable | null>(null);
  const [ouverture, setOuverture] = useState(false);
  const source: SourceFichier = { chemin: path, nom: name, taille: size, espace, relatif };

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    (async () => {
      const [bytes, mammoth] = await Promise.all([
        lireTout({ chemin: path, nom: name, taille: size, espace, relatif }, MAX_DOCX_BYTES),
        import("mammoth"),
      ]);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
      if (cancelled) return;
      setOctets(bytes);
      setWarnings(result.messages.filter((m) => m.type === "warning").length);
      setHtml(result.value || "<p><em>Document vide.</em></p>");
    })().catch((err) => !cancelled && setError(String(err?.message ?? err)));
    return () => {
      cancelled = true;
    };
  }, [path, size, name, espace, relatif, version]);

  const modifier = useCallback(async () => {
    if (!octets) return;
    setOuverture(true);
    try {
      const { ouvrirDocx, docxPourEditeur } = await import("./docxPaquet");
      const paquet = await ouvrirDocx(octets);
      const { html: contenu, pertes } = await docxPourEditeur(paquet);
      setEdition({ paquet, html: contenu, pertes });
    } catch (err) {
      setError(`Ce document ne peut pas être modifié ici : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setOuverture(false);
    }
  }, [octets]);

  // Un brouillon non enregistré (onglet quitté pendant la modification) rouvre l'éditeur.
  useEffect(() => {
    if (octets && !edition && brouillonDe(path)?.modifie) void modifier();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [octets]);

  if (edition) {
    return (
      <Suspense fallback={<ViewerLoading label="Ouverture de l'éditeur…" />}>
        <DocxEditeur
          source={source}
          cible={source}
          document={edition}
          onFermer={() => setEdition(null)}
          onEnregistre={(ecrit) => ecrit.chemin === path && setVersion((v) => v + 1)}
        />
      </Suspense>
    );
  }
  if (error) return <ViewerError icon="solar:document-text-linear" title="Impossible de lire ce document Word." detail={error} />;
  if (html === null) return <ViewerLoading label="Conversion du document…" />;
  return (
    <DocumentFrame
      html={html}
      title={name}
      toolbar={
        <>
          <button
            type="button"
            className="xv-btn xv-btn--text"
            onClick={() => void modifier()}
            disabled={ouverture || !octets}
            title="Modifier le document (gras, surlignage, couleurs, titres, listes…)"
          >
            {ouverture ? "Ouverture…" : "Modifier"}
          </button>
          <span className="xv-toolbar__hint" title="Mise en page simplifiée : le contenu est fidèle, pas la mise en forme exacte.">
            Aperçu lisible · mise en page simplifiée
            {warnings ? ` · ${warnings} élément${warnings > 1 ? "s" : ""} non converti${warnings > 1 ? "s" : ""}` : ""}
          </span>
        </>
      }
    />
  );
}
