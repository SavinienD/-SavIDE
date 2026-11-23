// éditeur riche des documents Word (.docx) et du texte des .pages.
//
// Choix (Savinien, 23/11/2026, tranché par l'agent) : TipTap 3 (ProseMirror, licence MIT) pour
// l'édition ; réécriture du .docx par nos soins (docxPaquet / htmlVersDocx) : seul le corps de
// word/document.xml est régénéré, le reste du paquet (styles, en-têtes, images…) est gardé.
// Ce qui ne peut pas être conservé est annoncé AVANT d'écraser, avec « Enregistrer une copie ».
// Un .pages ne se réécrit pas : son texte s'enregistre en .docx à côté (même nom).
// Modifications non enregistrées gardées en mémoire si l'onglet est quitté (brouillons).

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  Highlighter,
  Italic,
  List,
  ListOrdered,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
} from "lucide-react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { extensionsTexte, PALETTE_SURLIGNAGE, PALETTE_TEXTE, POLICES, TAILLES } from "./editeurExtensions";
import { enregistrerDocx, nouveauDocx, pertesExport, type PaquetDocx } from "./docxPaquet";
import { BROUILLONS } from "./brouillons";
import { ecrireTout, existe, nomCopieLibre, nomLibre, type SourceFichier } from "./sourceFichier";


export type DocumentEditable = {
  /** Paquet .docx d'origine ; null : document neuf (texte d'un .pages). */
  paquet: PaquetDocx | null;
  html: string;
  /** Pertes prévues dès l'ouverture (signets, suivi des modifications…). */
  pertes: string[];
};

type Props = {
  /** Fichier ouvert (clé des brouillons). */
  source: SourceFichier;
  /** Fichier écrit à l'enregistrement (le .docx lui-même, ou le .docx voisin d'un .pages). */
  cible: SourceFichier;
  document: DocumentEditable;
  /** Avis court affiché au-dessus du texte (cas du .pages). */
  avis?: ReactNode;
  onFermer: () => void;
  /** Le fichier `cible` (ou une copie) vient d'être écrit. */
  onEnregistre?: (ecrit: SourceFichier) => void;
};

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** Combinaison affichée dans les info-bulles (« Libellé · Ctrl+S », ⌘ sur macOS). */
function touches(t: string): string {
  return MAC ? t.replace("Ctrl+Maj+", "⇧⌘").replace("Ctrl+", "⌘") : t;
}

type Dialogue =
  | { genre: "pertes"; pertes: string[] }
  | { genre: "existe"; nom: string }
  | { genre: "quitter" };

function Bouton({
  titre,
  icone,
  actif,
  desactive,
  onClick,
  children,
}: {
  titre: string;
  icone?: ReactNode;
  actif?: boolean;
  desactive?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className="xv-btn axe-texte__btn"
      title={titre}
      aria-label={titre}
      aria-pressed={actif}
      data-active={actif ? "true" : undefined}
      disabled={desactive}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icone}
      {children}
    </button>
  );
}

function Palette({
  titre,
  icone,
  couleurs,
  actuelle,
  onChoix,
  aucun,
}: {
  titre: string;
  icone: ReactNode;
  couleurs: { nom: string; couleur: string }[];
  actuelle: string | null;
  onChoix: (c: string | null) => void;
  aucun: string;
}) {
  const [ouvert, setOuvert] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ouvert) return;
    const fermer = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOuvert(false);
    window.addEventListener("mousedown", fermer);
    return () => window.removeEventListener("mousedown", fermer);
  }, [ouvert]);
  return (
    <div className="axe-texte__palette" ref={ref}>
      <button
        type="button"
        className="xv-btn axe-texte__btn"
        title={titre}
        aria-label={titre}
        aria-expanded={ouvert}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOuvert((v) => !v)}
      >
        {icone}
        <span className="axe-texte__pastille" style={{ background: actuelle ?? "transparent" }} />
      </button>
      {ouvert && (
        <div className="axe-texte__menu" role="menu">
          {couleurs.map((c) => (
            <button
              key={c.couleur}
              type="button"
              role="menuitem"
              className="axe-texte__couleur"
              title={c.nom}
              aria-label={c.nom}
              style={{ background: c.couleur }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChoix(c.couleur);
                setOuvert(false);
              }}
            />
          ))}
          <button
            type="button"
            role="menuitem"
            className="axe-texte__aucun"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChoix(null);
              setOuvert(false);
            }}
          >
            {aucun}
          </button>
        </div>
      )}
    </div>
  );
}

function Barre({ editeur }: { editeur: Editor }) {
  const etat = useEditorState({
    editor: editeur,
    selector: ({ editor: e }) => ({
      gras: e.isActive("bold"),
      italique: e.isActive("italic"),
      souligne: e.isActive("underline"),
      barre: e.isActive("strike"),
      puces: e.isActive("bulletList"),
      numeros: e.isActive("orderedList"),
      bloc: e.isActive("heading", { level: 1 })
        ? "h1"
        : e.isActive("heading", { level: 2 })
          ? "h2"
          : e.isActive("heading", { level: 3 })
            ? "h3"
            : "p",
      align: (["center", "right", "justify"] as const).find((a) => e.isActive({ textAlign: a })) ?? "left",
      couleur: (e.getAttributes("textStyle").color as string | undefined) ?? null,
      surlignage: (e.getAttributes("highlight").color as string | undefined) ?? null,
      police: (e.getAttributes("textStyle").fontFamily as string | undefined) ?? "",
      taille: (e.getAttributes("textStyle").fontSize as string | undefined) ?? "",
      annuler: e.can().undo(),
      retablir: e.can().redo(),
    }),
  });
  const c = () => editeur.chain().focus();
  const tailleNum = etat.taille ? String(parseFloat(etat.taille)) : "";
  return (
    <div className="axe-texte__barre" role="toolbar" aria-label="Mise en forme">
      <Bouton titre={`Annuler · ${touches("Ctrl+Z")}`} icone={<Undo2 size={15} />} desactive={!etat.annuler} onClick={() => c().undo().run()} />
      <Bouton titre={`Rétablir · ${touches("Ctrl+Y")}`} icone={<Redo2 size={15} />} desactive={!etat.retablir} onClick={() => c().redo().run()} />
      <span className="axe-texte__sep" />
      <select
        className="axe-texte__select"
        title="Style du paragraphe"
        value={etat.bloc}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "p") c().setParagraph().run();
          else c().setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run();
        }}
      >
        <option value="p">Paragraphe</option>
        <option value="h1">Titre 1</option>
        <option value="h2">Titre 2</option>
        <option value="h3">Titre 3</option>
      </select>
      <select
        className="axe-texte__select axe-texte__select--police"
        title="Police"
        value={POLICES.includes(etat.police) ? etat.police : etat.police ? "__autre" : ""}
        onChange={(e) => (e.target.value ? c().setFontFamily(e.target.value).run() : c().unsetFontFamily().run())}
      >
        <option value="">Police par défaut</option>
        {etat.police && !POLICES.includes(etat.police) && <option value="__autre">{etat.police}</option>}
        {POLICES.map((p) => (
          <option key={p} value={p} style={{ fontFamily: p }}>
            {p}
          </option>
        ))}
      </select>
      <select
        className="axe-texte__select axe-texte__select--taille"
        title="Taille (points)"
        value={TAILLES.map(String).includes(tailleNum) ? tailleNum : tailleNum ? "__autre" : ""}
        onChange={(e) => (e.target.value ? c().setFontSize(`${e.target.value}pt`).run() : c().unsetFontSize().run())}
      >
        <option value="">Taille</option>
        {tailleNum && !TAILLES.map(String).includes(tailleNum) && <option value="__autre">{tailleNum}</option>}
        {TAILLES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <span className="axe-texte__sep" />
      <Bouton titre={`Gras · ${touches("Ctrl+B")}`} icone={<Bold size={15} />} actif={etat.gras} onClick={() => c().toggleBold().run()} />
      <Bouton titre={`Italique · ${touches("Ctrl+I")}`} icone={<Italic size={15} />} actif={etat.italique} onClick={() => c().toggleItalic().run()} />
      <Bouton titre={`Souligné · ${touches("Ctrl+U")}`} icone={<Underline size={15} />} actif={etat.souligne} onClick={() => c().toggleUnderline().run()} />
      <Bouton titre="Barré" icone={<Strikethrough size={15} />} actif={etat.barre} onClick={() => c().toggleStrike().run()} />
      <Palette
        titre="Surligner"
        icone={<Highlighter size={15} />}
        couleurs={PALETTE_SURLIGNAGE}
        actuelle={etat.surlignage}
        aucun="Sans surlignage"
        onChoix={(v) => (v ? c().setHighlight({ color: v }).run() : c().unsetHighlight().run())}
      />
      <Palette
        titre="Couleur du texte"
        icone={<Baseline size={15} />}
        couleurs={PALETTE_TEXTE}
        actuelle={etat.couleur}
        aucun="Couleur automatique"
        onChoix={(v) => (v ? c().setColor(v).run() : c().unsetColor().run())}
      />
      <span className="axe-texte__sep" />
      <Bouton titre="Liste à puces" icone={<List size={15} />} actif={etat.puces} onClick={() => c().toggleBulletList().run()} />
      <Bouton titre="Liste numérotée" icone={<ListOrdered size={15} />} actif={etat.numeros} onClick={() => c().toggleOrderedList().run()} />
      <span className="axe-texte__sep" />
      <Bouton titre="Aligner à gauche" icone={<AlignLeft size={15} />} actif={etat.align === "left"} onClick={() => c().setTextAlign("left").run()} />
      <Bouton titre="Centrer" icone={<AlignCenter size={15} />} actif={etat.align === "center"} onClick={() => c().setTextAlign("center").run()} />
      <Bouton titre="Aligner à droite" icone={<AlignRight size={15} />} actif={etat.align === "right"} onClick={() => c().setTextAlign("right").run()} />
      <Bouton titre="Justifier" icone={<AlignJustify size={15} />} actif={etat.align === "justify"} onClick={() => c().setTextAlign("justify").run()} />
    </div>
  );
}

export default function DocxEditeur({ source, cible, document: docInitial, avis, onFermer, onEnregistre }: Props) {
  const brouillon = BROUILLONS.get(source.chemin);
  const [modifie, setModifie] = useState(Boolean(brouillon?.modifie));
  const [etat, setEtat] = useState<{ genre: "ok" | "erreur" | "cours"; texte: string } | null>(null);
  const [dialogue, setDialogue] = useState<Dialogue | null>(null);
  const paquetRef = useRef<PaquetDocx | null>(docInitial.paquet);
  const pertesInitiales = useRef<string[]>(docInitial.pertes);
  /** Écrasement accepté malgré les pertes / fichier existant (une fois par session d'édition). */
  const accord = useRef({ pertes: false, existe: false });
  const cibleRef = useRef<SourceFichier>(cible);
  const modifieRef = useRef(modifie);
  const pretRef = useRef(false);
  modifieRef.current = modifie;

  const editeur = useEditor({
    extensions: extensionsTexte(),
    content: brouillon?.html ?? docInitial.html,
    autofocus: "start",
    editorProps: { attributes: { class: "axe-texte__page", spellcheck: "true", lang: "fr" } },
    onCreate: () => {
      // Normalisations éventuelles du schéma à l'ouverture : pas une modification de l'utilisateur.
      window.setTimeout(() => (pretRef.current = true), 0);
    },
    onUpdate: ({ editor }) => {
      if (!pretRef.current) return;
      if (!modifieRef.current) setModifie(true);
      BROUILLONS.set(source.chemin, { html: editor.getHTML(), modifie: true });
    },
  });

  // Brouillon gardé quand l'onglet est quitté ; oublié une fois enregistré ou abandonné.
  useEffect(
    () => () => {
      if (editeur && modifieRef.current) BROUILLONS.set(source.chemin, { html: editeur.getHTML(), modifie: true });
    },
    [editeur, source.chemin],
  );

  const ecrire = useCallback(
    async (ou: SourceFichier, creerSeulement: boolean) => {
      if (!editeur) return;
      setEtat({ genre: "cours", texte: "Enregistrement…" });
      try {
        const paquet = paquetRef.current ?? (paquetRef.current = await nouveauDocx());
        const octets = await enregistrerDocx(paquet, editeur.getHTML());
        await ecrireTout(ou, octets, creerSeulement);
        if (ou.chemin === cibleRef.current.chemin) {
          setModifie(false);
          BROUILLONS.delete(source.chemin);
          pertesInitiales.current = [];
        }
        setEtat({ genre: "ok", texte: `Enregistré : ${ou.nom}` });
        onEnregistre?.(ou);
      } catch (err) {
        setEtat({ genre: "erreur", texte: `Échec de l'enregistrement : ${err instanceof Error ? err.message : String(err)}` });
      }
    },
    [editeur, onEnregistre, source.chemin],
  );

  const enregistrerCopie = useCallback(async () => {
    setDialogue(null);
    const copie = await nomCopieLibre(cibleRef.current, "docx");
    await ecrire(copie, true);
  }, [ecrire]);

  const enregistrer = useCallback(async () => {
    if (!editeur) return;
    setDialogue(null);
    const paquet = paquetRef.current;
    const pertes = [...pertesInitiales.current, ...(paquet ? pertesExport(paquet, editeur.getHTML()) : [])];
    if (pertes.length && !accord.current.pertes) {
      setDialogue({ genre: "pertes", pertes });
      return;
    }
    if (!paquet && !accord.current.existe && (await existe(cibleRef.current))) {
      setDialogue({ genre: "existe", nom: cibleRef.current.nom });
      return;
    }
    await ecrire(cibleRef.current, false);
    if (!paquet) accord.current.existe = true;
  }, [editeur, ecrire]);

  const quitter = () => {
    if (modifie) setDialogue({ genre: "quitter" });
    else onFermer();
  };

  return (
    <div
      className="axe-texte"
      onKeyDownCapture={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
          e.preventDefault();
          e.stopPropagation();
          void (e.shiftKey ? enregistrerCopie() : enregistrer());
        }
      }}
    >
      <div className="xv-toolbar axe-texte__haut">
        <span className="xv-toolbar__hint" title={cibleRef.current.nom}>
          {modifie ? "Modifié · " : ""}
          {cibleRef.current.nom}
        </span>
        <span className="xv-toolbar__spacer" />
        {etat && (
          <span className={`axe-texte__etat axe-texte__etat--${etat.genre}`} role="status">
            {etat.texte}
          </span>
        )}
        <button type="button" className="xv-btn xv-btn--text" onClick={() => void enregistrerCopie()} title={`Enregistrer une copie · ${touches("Ctrl+Maj+S")}`}>
          Enregistrer une copie
        </button>
        <button
          type="button"
          className="xv-btn xv-btn--text axe-texte__principal"
          onClick={() => void enregistrer()}
          title={`Enregistrer · ${touches("Ctrl+S")}`}
          disabled={!modifie && !(paquetRef.current === null)}
        >
          Enregistrer
        </button>
        <button type="button" className="xv-btn xv-btn--text" onClick={quitter} title="Revenir à la lecture">
          Terminer
        </button>
      </div>
      {editeur && <Barre editeur={editeur} />}
      {avis && <div className="axe-texte__avis">{avis}</div>}
      <div className="axe-texte__fond">
        <EditorContent editor={editeur} />
      </div>
      {dialogue && (
        <div className="axe-texte__voile" role="dialog" aria-modal="true">
          <div className="axe-texte__dialogue">
            {dialogue.genre === "pertes" && (
              <>
                <strong>Certains éléments ne seront pas conservés</strong>
                <ul>
                  {dialogue.pertes.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <p>Enregistrer une copie garde le fichier d&rsquo;origine intact.</p>
                <div className="axe-texte__actions">
                  <button type="button" className="xv-btn xv-btn--text" onClick={() => setDialogue(null)}>
                    Annuler
                  </button>
                  <button
                    type="button"
                    className="xv-btn xv-btn--text"
                    onClick={() => {
                      accord.current.pertes = true;
                      void enregistrer();
                    }}
                  >
                    Écraser quand même
                  </button>
                  <button type="button" className="xv-btn xv-btn--text axe-texte__principal" onClick={() => void enregistrerCopie()} autoFocus>
                    Enregistrer une copie
                  </button>
                </div>
              </>
            )}
            {dialogue.genre === "existe" && (
              <>
                <strong>{dialogue.nom} existe déjà</strong>
                <p>Le remplacer par ce texte, ou enregistrer sous un autre nom ?</p>
                <div className="axe-texte__actions">
                  <button type="button" className="xv-btn xv-btn--text" onClick={() => setDialogue(null)}>
                    Annuler
                  </button>
                  <button
                    type="button"
                    className="xv-btn xv-btn--text"
                    onClick={() => {
                      accord.current.existe = true;
                      void enregistrer();
                    }}
                  >
                    Remplacer
                  </button>
                  <button
                    type="button"
                    className="xv-btn xv-btn--text axe-texte__principal"
                    autoFocus
                    onClick={async () => {
                      setDialogue(null);
                      const libre = await nomLibre(cibleRef.current, cibleRef.current.nom.replace(/\.docx$/i, ""), "docx");
                      cibleRef.current = libre;
                      accord.current.existe = true;
                      await ecrire(libre, true);
                    }}
                  >
                    Autre nom
                  </button>
                </div>
              </>
            )}
            {dialogue.genre === "quitter" && (
              <>
                <strong>Modifications non enregistrées</strong>
                <p>Revenir à la lecture sans enregistrer ? Les modifications seront perdues.</p>
                <div className="axe-texte__actions">
                  <button type="button" className="xv-btn xv-btn--text" onClick={() => setDialogue(null)} autoFocus>
                    Continuer à modifier
                  </button>
                  <button
                    type="button"
                    className="xv-btn xv-btn--text"
                    onClick={() => {
                      BROUILLONS.delete(source.chemin);
                      modifieRef.current = false;
                      onFermer();
                    }}
                  >
                    Abandonner les modifications
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
