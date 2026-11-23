// extensions de l'éditeur riche (TipTap / ProseMirror, licence MIT).
// Partagées par l'éditeur (DocxEditeur.tsx) et par les tests (tests/docxEdition.test.cjs),
// pour que l'aller-retour Word → éditeur → Word soit vérifié avec le vrai schéma.
//
// En plus du kit de base : surlignage multicolore, couleur, taille et police du texte,
// alignement, tableaux, et deux nœuds « gardés tels quels » (XML Word brut : images,
// notes, champs, tableaux complexes…) avec les attributs data-docx-* qui portent les
// propriétés Word que l'éditeur ne modifie pas.

import { Extension, Node, mergeAttributes, type AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { TableKit } from "@tiptap/extension-table";

/** Attribut gardé : lu depuis data-docx-…, réécrit tel quel. */
function garde(cle: string, nomHtml: string) {
  return {
    [cle]: {
      default: null,
      parseHTML: (el: HTMLElement) => el.getAttribute(nomHtml),
      renderHTML: (a: Record<string, unknown>) => (a[cle] ? { [nomHtml]: a[cle] } : {}),
    },
  };
}

const AttributsWord = Extension.create({
  name: "attributsWord",
  addGlobalAttributes() {
    return [
      { types: ["paragraph", "heading"], attributes: garde("docxPpr", "data-docx-ppr") },
      { types: ["textStyle"], attributes: garde("docxRpr", "data-docx-rpr") },
      { types: ["bulletList", "orderedList"], attributes: garde("docxNum", "data-docx-num") },
      { types: ["table"], attributes: { ...garde("docxTblpr", "data-docx-tblpr"), ...garde("docxGrid", "data-docx-grid") } },
      { types: ["tableRow"], attributes: garde("docxTrpr", "data-docx-trpr") },
      { types: ["tableCell", "tableHeader"], attributes: garde("docxTcpr", "data-docx-tcpr") },
    ];
  },
});

/** TextStyle qui accepte aussi un <span data-docx-rpr> sans style. */
const StyleTexte = TextStyle.extend({
  parseHTML() {
    return [
      ...(this.parent?.() ?? []),
      { tag: "span[data-docx-rpr]", consuming: false, getAttrs: () => ({}) },
    ];
  },
});

/** Élément Word en ligne gardé tel quel (image, note, champ…). */
export const BrutEnLigne = Node.create({
  name: "docxBrutEnLigne",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      ...garde("brut", "data-docx-brut"),
      ...garde("libelle", "data-libelle"),
      src: { default: null, parseHTML: (el: HTMLElement) => (el.tagName === "IMG" ? el.getAttribute("src") : null), renderHTML: () => ({}) },
      texte: { default: null, parseHTML: (el: HTMLElement) => (el.tagName === "IMG" ? null : el.textContent), renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [
      { tag: "img[data-docx-brut]", priority: 100 },
      { tag: "span[data-docx-brut]", priority: 100 },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    if (node.attrs.src) {
      return ["img", mergeAttributes(HTMLAttributes, { src: node.attrs.src, alt: node.attrs.libelle ?? "Image", class: "axe-texte__image" })];
    }
    return ["span", mergeAttributes(HTMLAttributes, { class: "axe-texte__brut", contenteditable: "false" }), node.attrs.texte || node.attrs.libelle || "Élément"];
  },
  renderText({ node }) {
    return node.attrs.src ? "" : node.attrs.texte ?? "";
  },
});

/** Bloc Word gardé tel quel (tableau complexe, table des matières…). */
export const BrutBloc = Node.create({
  name: "docxBrutBloc",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      ...garde("brut", "data-docx-brut"),
      ...garde("libelle", "data-libelle"),
      texte: { default: null, parseHTML: (el: HTMLElement) => el.textContent, renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-docx-brut]", priority: 100 }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "axe-texte__bloc", contenteditable: "false" }), node.attrs.texte || node.attrs.libelle || "Élément"];
  },
});

/** Toutes les extensions de l'éditeur riche. */
export function extensionsTexte(): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: false, linkOnPaste: true },
      codeBlock: false,
      code: false,
    }),
    StyleTexte,
    Color,
    FontFamily,
    FontSize,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right", "justify"] }),
    TableKit.configure({ table: { resizable: false } }),
    AttributsWord,
    BrutEnLigne,
    BrutBloc,
  ];
}

/** Couleurs de surlignage proposées (celles de Word : gardées en w:highlight). */
export const PALETTE_SURLIGNAGE: { nom: string; couleur: string }[] = [
  { nom: "Jaune", couleur: "#ffff00" },
  { nom: "Vert", couleur: "#00ff00" },
  { nom: "Turquoise", couleur: "#00ffff" },
  { nom: "Rose", couleur: "#ff00ff" },
  { nom: "Rouge", couleur: "#ff0000" },
  { nom: "Gris", couleur: "#c0c0c0" },
];

/** Couleurs de texte proposées. */
export const PALETTE_TEXTE: { nom: string; couleur: string }[] = [
  { nom: "Noir", couleur: "#000000" },
  { nom: "Gris", couleur: "#595959" },
  { nom: "Rouge", couleur: "#c00000" },
  { nom: "Orange", couleur: "#e36c09" },
  { nom: "Vert", couleur: "#00b050" },
  { nom: "Bleu", couleur: "#0070c0" },
  { nom: "Violet", couleur: "#7030a0" },
];

export const POLICES = ["Calibri", "Arial", "Times New Roman", "Georgia", "Verdana", "Courier New", "Cambria", "Helvetica"];
export const TAILLES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];
