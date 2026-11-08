// Revue des changements : éditeur Monaco simple (versions d'un conflit, résultat modifiable).
import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { AXE_MONACO_THEME, monacoThemeData } from "../../axe/themeTargets";
import { loadTextScale, MONO_BASE_PX, MONO_LINE_BASE_PX } from "../../axe/zoom";

export type ZoneLignes = { debut: number; fin: number; classe: string };

type Props = {
  valeur: string;
  langage: string;
  lectureSeule: boolean;
  zones?: readonly ZoneLignes[];
  etiquette: string;
  onChange?: (valeur: string) => void;
  onPret?: (editeur: monaco.editor.IStandaloneCodeEditor | null) => void;
  onCurseur?: (ligne: number) => void;
};

export function MonacoSimple({ valeur, langage, lectureSeule, zones = [], etiquette, onChange, onPret, onCurseur }: Props) {
  const hoteRef = useRef<HTMLDivElement | null>(null);
  const editeurRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const rappels = useRef({ onChange, onPret, onCurseur });
  rappels.current = { onChange, onPret, onCurseur };

  useEffect(() => {
    const hote = hoteRef.current;
    if (!hote) return;
    monaco.editor.defineTheme(AXE_MONACO_THEME, monacoThemeData());
    const echelle = loadTextScale();
    const modele = monaco.editor.createModel(valeur, langage);
    const editeur = monaco.editor.create(hote, {
      model: modele,
      theme: AXE_MONACO_THEME,
      readOnly: lectureSeule,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: Math.max(1, Math.round(MONO_BASE_PX * echelle)),
      lineHeight: Math.max(1, Math.round(MONO_LINE_BASE_PX * echelle)),
      renderLineHighlight: lectureSeule ? "none" : "line",
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      ariaLabel: etiquette,
      padding: { top: 8, bottom: 8 },
    });
    editeurRef.current = editeur;
    decoRef.current = editeur.createDecorationsCollection();
    const abonnements = [
      editeur.onDidChangeModelContent(() => rappels.current.onChange?.(editeur.getValue())),
      editeur.onDidChangeCursorPosition((e) => rappels.current.onCurseur?.(e.position.lineNumber)),
    ];
    rappels.current.onPret?.(editeur);
    return () => {
      rappels.current.onPret?.(null);
      for (const a of abonnements) a.dispose();
      editeur.dispose();
      modele.dispose();
      editeurRef.current = null;
    };
    // Création une seule fois ; valeur et langage suivent plus bas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const modele = editeurRef.current?.getModel();
    if (modele && modele.getValue() !== valeur) {
      if (lectureSeule) modele.setValue(valeur);
      else editeurRef.current?.executeEdits("revue", [{ range: modele.getFullModelRange(), text: valeur }]);
    }
  }, [valeur, lectureSeule]);

  useEffect(() => {
    const modele = editeurRef.current?.getModel();
    if (modele) monaco.editor.setModelLanguage(modele, langage);
  }, [langage]);

  useEffect(() => {
    decoRef.current?.set(
      zones.map((z) => ({ range: new monaco.Range(z.debut, 1, z.fin, 1), options: { isWholeLine: true, className: z.classe } })),
    );
  }, [zones]);

  return <div className="revue-monaco" ref={hoteRef} />;
}
