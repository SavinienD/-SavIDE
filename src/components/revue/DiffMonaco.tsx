// Revue des changements : diff Monaco (côte à côte ou en ligne), en lecture seule.
// Monaco est piloté directement (pas le DiffEditor de @monaco-editor/react, qui
// libère les modèles avant l'éditeur et fait lever « TextModel got disposed »).
import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { AXE_MONACO_THEME, monacoThemeData } from "../../axe/themeTargets";
import { onThemeChange } from "../../axe/theme";
import { loadTextScale, MONO_BASE_PX, MONO_LINE_BASE_PX, onTextScaleChange } from "../../axe/zoom";
import type { Bloc, Cote } from "./selectionDiff";

export type SelectionDiff = { cote: Cote; debut: number; fin: number; vide: boolean; ligne: number };

export type DiffApi = {
  blocs(): Bloc[];
  selection(): SelectionDiff;
  allerA(cote: Cote, ligne: number): void;
  texte(cote: Cote, debut: number, fin: number): string;
  focus(): void;
  /** Faux quand Monaco montre le diff en ligne (choix ou place trop étroite). */
  deuxCotes(): boolean;
};

export type MarqueNote = { cote: Cote; debut: number; fin: number };

type Props = {
  ancien: string;
  nouveau: string;
  langage: string;
  enLigne: boolean;
  marques: readonly MarqueNote[];
  onPret: (api: DiffApi | null) => void;
  onBlocs: (blocs: Bloc[]) => void;
  onSelection: (s: SelectionDiff) => void;
};

function options(enLigne: boolean, echelle: number): monaco.editor.IDiffEditorConstructionOptions {
  return {
    readOnly: true,
    originalEditable: false,
    renderSideBySide: !enLigne,
    useInlineViewWhenSpaceIsLimited: true,
    renderSideBySideInlineBreakpoint: 700,
    ignoreTrimWhitespace: false,
    renderMarginRevertIcon: false,
    renderGutterMenu: false,
    renderOverviewRuler: true,
    diffAlgorithm: "advanced",
    hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 10 },
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontFamily: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: Math.max(1, Math.round(MONO_BASE_PX * echelle)),
    lineHeight: Math.max(1, Math.round(MONO_LINE_BASE_PX * echelle)),
    glyphMargin: true,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  };
}

export function DiffMonaco({ ancien, nouveau, langage, enLigne, marques, onPret, onBlocs, onSelection }: Props) {
  const hoteRef = useRef<HTMLDivElement | null>(null);
  const editeurRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const decoRef = useRef<{ ancien?: monaco.editor.IEditorDecorationsCollection; nouveau?: monaco.editor.IEditorDecorationsCollection }>({});
  const rappels = useRef({ onPret, onBlocs, onSelection });
  rappels.current = { onPret, onBlocs, onSelection };
  const enLigneRef = useRef(enLigne);
  enLigneRef.current = enLigne;

  useEffect(() => {
    const hote = hoteRef.current;
    if (!hote) return;
    monaco.editor.defineTheme(AXE_MONACO_THEME, monacoThemeData());
    const editeur = monaco.editor.createDiffEditor(hote, { ...options(enLigneRef.current, loadTextScale()), theme: AXE_MONACO_THEME });
    editeurRef.current = editeur;
    let focusCote: Cote = "nouveau";
    const lireSelection = (cote: Cote): SelectionDiff => {
      const ed = cote === "ancien" ? editeur.getOriginalEditor() : editeur.getModifiedEditor();
      const s = ed.getSelection();
      if (!s) return { cote, debut: 1, fin: 1, vide: true, ligne: 1 };
      // Une sélection qui finit en colonne 1 ne prend pas la dernière ligne.
      const fin = s.endLineNumber > s.startLineNumber && s.endColumn === 1 ? s.endLineNumber - 1 : s.endLineNumber;
      return { cote, debut: s.startLineNumber, fin, vide: s.isEmpty(), ligne: s.positionLineNumber };
    };
    const abonnements = [
      editeur.onDidUpdateDiff(() => rappels.current.onBlocs((editeur.getLineChanges() ?? []) as Bloc[])),
      editeur.getOriginalEditor().onDidFocusEditorText(() => {
        focusCote = "ancien";
        rappels.current.onSelection(lireSelection("ancien"));
      }),
      editeur.getModifiedEditor().onDidFocusEditorText(() => {
        focusCote = "nouveau";
        rappels.current.onSelection(lireSelection("nouveau"));
      }),
      editeur.getOriginalEditor().onDidChangeCursorSelection(() => {
        if (focusCote === "ancien") rappels.current.onSelection(lireSelection("ancien"));
      }),
      editeur.getModifiedEditor().onDidChangeCursorSelection(() => {
        if (focusCote === "nouveau") rappels.current.onSelection(lireSelection("nouveau"));
      }),
    ];
    const finTheme = onThemeChange(() => {
      monaco.editor.defineTheme(AXE_MONACO_THEME, monacoThemeData());
      monaco.editor.setTheme(AXE_MONACO_THEME);
    });
    const finEchelle = onTextScaleChange((e) => editeur.updateOptions(options(enLigneRef.current, e)));
    const api: DiffApi = {
      blocs: () => (editeur.getLineChanges() ?? []) as Bloc[],
      selection: () => lireSelection(focusCote),
      allerA: (cote, ligne) => {
        const ed = cote === "ancien" ? editeur.getOriginalEditor() : editeur.getModifiedEditor();
        const n = Math.max(1, Math.min(ligne, ed.getModel()?.getLineCount() ?? 1));
        ed.setPosition({ lineNumber: n, column: 1 });
        ed.revealLineInCenterIfOutsideViewport(n);
        ed.focus();
        focusCote = cote;
        rappels.current.onSelection(lireSelection(cote));
      },
      texte: (cote, debut, fin) => {
        const modele = cote === "ancien" ? editeur.getModel()?.original : editeur.getModel()?.modified;
        if (!modele) return "";
        const max = modele.getLineCount();
        const lignes: string[] = [];
        for (let n = Math.max(1, debut); n <= Math.min(fin, max); n += 1) lignes.push(modele.getLineContent(n));
        return lignes.join("\n");
      },
      focus: () => (focusCote === "ancien" ? editeur.getOriginalEditor() : editeur.getModifiedEditor()).focus(),
      deuxCotes: () => editeur.getOriginalEditor().getLayoutInfo().width > 0 && (editeur.getOriginalEditor().getDomNode()?.offsetWidth ?? 0) > 0,
    };
    rappels.current.onPret(api);
    return () => {
      rappels.current.onPret(null);
      for (const a of abonnements) a.dispose();
      finTheme();
      finEchelle();
      const modeles = editeur.getModel();
      decoRef.current = {};
      editeur.dispose();
      modeles?.original.dispose();
      modeles?.modified.dispose();
      editeurRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editeur = editeurRef.current;
    if (!editeur) return;
    const avant = editeur.getModel();
    const original = monaco.editor.createModel(ancien, langage);
    const modifie = monaco.editor.createModel(nouveau, langage);
    editeur.setModel({ original, modified: modifie });
    decoRef.current = {};
    avant?.original.dispose();
    avant?.modified.dispose();
  }, [ancien, nouveau, langage]);

  useEffect(() => {
    editeurRef.current?.updateOptions({ renderSideBySide: !enLigne });
  }, [enLigne]);

  // Lignes notées : fond discret et repère dans la marge.
  useEffect(() => {
    const editeur = editeurRef.current;
    if (!editeur) return;
    const deco = (cote: Cote) =>
      marques
        .filter((m) => m.cote === cote)
        .map((m) => ({
          range: new monaco.Range(m.debut, 1, m.fin, 1),
          options: { isWholeLine: true, className: "revue-ligne-notee", glyphMarginClassName: "revue-marge-notee", glyphMarginHoverMessage: { value: "Note de relecture" } },
        }));
    const d = decoRef.current;
    d.ancien ??= editeur.getOriginalEditor().createDecorationsCollection();
    d.nouveau ??= editeur.getModifiedEditor().createDecorationsCollection();
    d.ancien.set(deco("ancien"));
    d.nouveau.set(deco("nouveau"));
  }, [marques, ancien, nouveau, langage]);

  return <div className="revue-diff__monaco" ref={hoteRef} />;
}
