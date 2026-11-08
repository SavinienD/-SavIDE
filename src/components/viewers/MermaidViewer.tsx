// Visionneuse des fichiers Mermaid (.mmd, .mermaid) : le diagramme rendu par-dessus
// le code (bascule Diagramme / Code), redessiné 300 ms après la frappe ; un clic (ou Entrée)
// l'agrandit en plein écran avec zoom à la molette et déplacement à la souris.

import { useEffect, useState } from "react";
import { MermaidDiagram } from "../chat/MermaidDiagram";

export default function MermaidViewer({ text }: { text: string }) {
  const [source, setSource] = useState(text);
  useEffect(() => {
    const minuterie = window.setTimeout(() => setSource(text), 300);
    return () => window.clearTimeout(minuterie);
  }, [text]);
  return (
    <div className="xv-mermaid">
      {source.trim() ? (
        <MermaidDiagram source={source} />
      ) : (
        <div className="xv-state">Fichier vide : écrivez un diagramme dans le code.</div>
      )}
    </div>
  );
}
