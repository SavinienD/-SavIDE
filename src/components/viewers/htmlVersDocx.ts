// réécriture de word/document.xml à partir du HTML de l'éditeur riche.
//
// Seul le contenu du corps (w:body) est régénéré ; tout le reste du paquet (styles, en-têtes,
// pieds de page, images, propriétés de section) est gardé. Les éléments gardés tels quels à
// l'import (data-docx-brut) et les propriétés non gérées (data-docx-ppr / -rpr / -tblpr…)
// sont remis à l'identique. Styles de titre et numérotations manquants : ajoutés.
// Pur (DOMParser / XMLSerializer globaux) : testé par tests/docxEdition.test.cjs.

import {
  R_NS,
  SURLIGNAGES_WORD,
  W_NS,
  attrW,
  enfant,
  enfants,
  formatsListes,
  relations,
  serialiser,
  stylesTitres,
} from "./docxVersHtml";

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const TYPE_LIEN = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

const ORDRE_PPR = [
  "pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr", "suppressLineNumbers",
  "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE",
  "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents",
  "suppressOverlap", "jc", "textDirection", "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle",
  "rPr", "sectPr", "pPrChange",
];
const ORDRE_RPR = [
  "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss",
  "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs",
  "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout",
  "specVanish", "oMath",
];

export type SourcesExport = {
  html: string;
  documentXml: string;
  stylesXml?: string | null;
  numberingXml?: string | null;
  relsXml?: string | null;
};

export type ResultatExport = {
  documentXml: string;
  /** Nouvelle valeur quand le fichier a changé (null : inchangé). */
  stylesXml: string | null;
  numberingXml: string | null;
  relsXml: string | null;
  /** Ce qui n'a pas pu être écrit (images collées…). */
  pertes: string[];
};

type Etat = {
  b: boolean;
  i: boolean;
  u: boolean;
  s: boolean;
  couleur: string | null;
  surlignage: string | null;
  taille: number | null;
  police: string | null;
  rpr: string | null;
};

const NOMMEES: Record<string, string> = {
  black: "000000", white: "ffffff", red: "ff0000", green: "008000", lime: "00ff00", blue: "0000ff", yellow: "ffff00",
  cyan: "00ffff", aqua: "00ffff", magenta: "ff00ff", fuchsia: "ff00ff", gray: "808080", grey: "808080", orange: "ffa500",
  purple: "800080", navy: "000080", teal: "008080", maroon: "800000", olive: "808000", silver: "c0c0c0",
};

/** Couleur CSS (#rgb, #rrggbb, rgb(), nom simple) en RRGGBB, ou null. */
export function versHex(css: string | null | undefined): string | null {
  if (!css) return null;
  const v = css.trim().toLowerCase().replace(/['"]/g, "");
  let m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return m[1].toUpperCase();
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (m) return (m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toUpperCase();
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  return NOMMEES[v]?.toUpperCase() ?? null;
}

/** Taille CSS (pt, px) en points. */
export function versPoints(css: string | null | undefined): number | null {
  if (!css) return null;
  const m = /^([\d.]+)\s*(pt|px)?$/i.exec(css.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!(n > 0)) return null;
  return m[2]?.toLowerCase() === "px" ? n * 0.75 : n;
}

function premierePolice(css: string | null | undefined): string | null {
  const p = css?.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "");
  return p || null;
}

/** Nom Word de surlignage pour une couleur exacte, sinon null. */
function nomSurlignage(hex: string): string | null {
  const bas = `#${hex.toLowerCase()}`;
  for (const [nom, v] of Object.entries(SURLIGNAGES_WORD)) if (v === bas) return nom;
  return null;
}

class Exporteur {
  doc: Document;
  nsDecls: string;
  pertes = new Map<string, number>();
  titres: Map<number, string>;
  stylesDoc: Document | null;
  stylesChange = false;
  numDoc: Document | null;
  numChange = false;
  formats: Map<string, Map<number, string>>;
  numDefaut = new Map<"bullet" | "decimal", string>();
  relsDoc: Document | null;
  relsChange = false;
  liens = new Map<string, string>();

  constructor(private src: SourcesExport) {
    const p = new DOMParser();
    this.doc = p.parseFromString(src.documentXml, "application/xml");
    const racine = this.doc.documentElement;
    this.nsDecls = Array.from(racine.attributes)
      .filter((a) => a.name.startsWith("xmlns"))
      .map((a) => `${a.name}="${a.value.replace(/"/g, "&quot;")}"`)
      .join(" ");
    this.titres = new Map();
    for (const [id, n] of stylesTitres(src.stylesXml)) if (!this.titres.has(n)) this.titres.set(n, id);
    this.stylesDoc = src.stylesXml ? p.parseFromString(src.stylesXml, "application/xml") : null;
    this.numDoc = src.numberingXml ? p.parseFromString(src.numberingXml, "application/xml") : null;
    this.formats = formatsListes(src.numberingXml);
    this.relsDoc = src.relsXml ? p.parseFromString(src.relsXml, "application/xml") : null;
    for (const [id, r] of relations(src.relsXml)) if (r.externe && r.type === TYPE_LIEN && !this.liens.has(r.cible)) this.liens.set(r.cible, id);
  }

  perte(quoi: string) {
    this.pertes.set(quoi, (this.pertes.get(quoi) ?? 0) + 1);
  }

  w(nom: string, attrs: Record<string, string> = {}): Element {
    const el = this.doc.createElementNS(W_NS, `w:${nom}`);
    for (const [k, v] of Object.entries(attrs)) el.setAttributeNS(W_NS, `w:${k}`, v);
    return el;
  }

  /** XML brut gardé à l'import, réimporté dans le document. */
  brut(xml: string): Element | null {
    const d = new DOMParser().parseFromString(`<axe-brut ${this.nsDecls}>${xml}</axe-brut>`, "application/xml");
    const el = d.documentElement.firstElementChild;
    if (!el || d.getElementsByTagName("parsererror").length) return null;
    const x = this.doc.importNode(el, true) as Element;
    // Déclarations d'espaces de noms redondantes (déjà sur la racine du document) : retirées.
    const racine = this.doc.documentElement;
    for (const e of [x, ...Array.from(x.getElementsByTagName("*"))]) {
      for (const a of Array.from(e.attributes)) {
        if ((a.name === "xmlns" || a.name.startsWith("xmlns:")) && racine.getAttribute(a.name) === a.value) e.removeAttribute(a.name);
      }
    }
    return x;
  }

  /** Insère `el` à sa place dans pPr / rPr (ordre du schéma), en remplaçant le même élément. */
  placer(parent: Element, el: Element, ordre: string[]) {
    const ancien = enfant(parent, el.localName);
    if (ancien) {
      parent.replaceChild(el, ancien);
      return;
    }
    const rang = ordre.indexOf(el.localName);
    for (const c of enfants(parent)) {
      const r = ordre.indexOf(c.localName);
      if (r > rang) {
        parent.insertBefore(el, c);
        return;
      }
    }
    parent.appendChild(el);
  }

  retirer(parent: Element, noms: string[]) {
    for (const c of enfants(parent)) if (noms.includes(c.localName)) parent.removeChild(c);
  }

  rPr(e: Etat): Element | null {
    const rPr = (e.rpr && this.brut(e.rpr)) || this.w("rPr");
    this.retirer(rPr, ["b", "i", "u", "strike", "dstrike", "color", "highlight", "shd", "sz", "szCs", "rFonts"]);
    if (e.police) this.placer(rPr, this.w("rFonts", { ascii: e.police, hAnsi: e.police, cs: e.police }), ORDRE_RPR);
    if (e.b) this.placer(rPr, this.w("b"), ORDRE_RPR);
    if (e.i) this.placer(rPr, this.w("i"), ORDRE_RPR);
    if (e.s) this.placer(rPr, this.w("strike"), ORDRE_RPR);
    if (e.couleur) this.placer(rPr, this.w("color", { val: e.couleur }), ORDRE_RPR);
    if (e.taille) {
      const demi = String(Math.round(e.taille * 2));
      this.placer(rPr, this.w("sz", { val: demi }), ORDRE_RPR);
      this.placer(rPr, this.w("szCs", { val: demi }), ORDRE_RPR);
    }
    if (e.surlignage) {
      const nom = nomSurlignage(e.surlignage);
      if (nom) this.placer(rPr, this.w("highlight", { val: nom }), ORDRE_RPR);
      else this.placer(rPr, this.w("shd", { val: "clear", color: "auto", fill: e.surlignage }), ORDRE_RPR);
    }
    if (e.u) this.placer(rPr, this.w("u", { val: "single" }), ORDRE_RPR);
    return enfants(rPr).length ? rPr : null;
  }

  course(e: Etat, contenu: Element[]): Element {
    const r = this.w("r");
    const rPr = this.rPr(e);
    if (rPr) r.appendChild(rPr);
    for (const c of contenu) r.appendChild(c);
    return r;
  }

  texte(t: string, e: Etat, out: Element[]) {
    const morceaux = t.split("\t");
    const contenu: Element[] = [];
    morceaux.forEach((m, i) => {
      if (i > 0) contenu.push(this.w("tab"));
      if (m) {
        const wt = this.w("t");
        wt.setAttributeNS(XML_NS, "xml:space", "preserve");
        wt.textContent = m;
        contenu.push(wt);
      }
    });
    if (contenu.length) out.push(this.course(e, contenu));
  }

  /** Contenu en ligne d'un nœud HTML, ajouté à `out` (courses, liens, éléments gardés). */
  enLigne(n: Node, e: Etat, out: Element[]) {
    if (n.nodeType === 3) {
      this.texte(n.nodeValue ?? "", e, out);
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const brut = el.getAttribute("data-docx-brut");
    if (brut !== null) {
      const x = this.brut(brut);
      if (x) out.push(x);
      else this.perte("éléments illisibles");
      return;
    }
    if (tag === "br") {
      out.push(this.course(e, [this.w("br")]));
      return;
    }
    if (tag === "img") {
      this.perte("images ajoutées dans l'éditeur");
      return;
    }
    const s: Etat = { ...e };
    if (tag === "strong" || tag === "b") s.b = true;
    if (tag === "em" || tag === "i") s.i = true;
    if (tag === "u") s.u = true;
    if (tag === "s" || tag === "strike" || tag === "del") s.s = true;
    if (tag === "code") s.police = "Consolas";
    if (tag === "mark") s.surlignage = versHex(el.getAttribute("data-color")) ?? versHex(el.style?.backgroundColor) ?? "FFFF00";
    const st = el.style;
    if (st) {
      if (tag !== "mark") {
        const fond = versHex(st.backgroundColor);
        if (fond) s.surlignage = fond;
      }
      const c = versHex(st.color);
      if (c && tag !== "mark") s.couleur = c;
      const t = versPoints(st.fontSize);
      if (t) s.taille = t;
      const p = premierePolice(st.fontFamily);
      if (p) s.police = p;
      if (st.fontWeight === "bold" || Number(st.fontWeight) >= 600) s.b = true;
      if (st.fontStyle === "italic") s.i = true;
      if (/underline/.test(st.textDecoration || "")) s.u = true;
      if (/line-through/.test(st.textDecoration || "")) s.s = true;
    }
    const rpr = el.getAttribute("data-docx-rpr");
    if (rpr) s.rpr = rpr;
    if (tag === "a" && el.getAttribute("href")) {
      const lien = this.lien(el.getAttribute("href")!);
      const sous: Element[] = [];
      for (let c = el.firstChild; c; c = c.nextSibling) this.enLigne(c, s, sous);
      for (const x of sous) lien.appendChild(x);
      out.push(lien);
      return;
    }
    for (let c = el.firstChild; c; c = c.nextSibling) this.enLigne(c, s, out);
  }

  lien(href: string): Element {
    if (href.startsWith("#")) return this.w("hyperlink", { anchor: href.slice(1) });
    let id = this.liens.get(href);
    if (!id) {
      if (!this.relsDoc) {
        this.relsDoc = new DOMParser().parseFromString(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
          "application/xml",
        );
      }
      const racine = this.relsDoc.documentElement;
      const pris = new Set(Array.from(racine.getElementsByTagName("Relationship")).map((r) => r.getAttribute("Id")));
      let i = 1;
      while (pris.has(`rIdAxe${i}`)) i += 1;
      id = `rIdAxe${i}`;
      const r = this.relsDoc.createElementNS(racine.namespaceURI, "Relationship");
      r.setAttribute("Id", id);
      r.setAttribute("Type", TYPE_LIEN);
      r.setAttribute("Target", href);
      r.setAttribute("TargetMode", "External");
      racine.appendChild(r);
      this.relsChange = true;
      this.liens.set(href, id);
    }
    const h = this.w("hyperlink");
    h.setAttributeNS(R_NS, "r:id", id);
    return h;
  }

  /** Id du style de titre `n` (ajouté à styles.xml s'il manque). */
  styleTitre(n: number): string | null {
    const connu = this.titres.get(n);
    if (connu) return connu;
    if (!this.stylesDoc) return null;
    const racine = this.stylesDoc.documentElement;
    const mk = (nom: string, attrs: Record<string, string> = {}) => {
      const el = this.stylesDoc!.createElementNS(W_NS, `w:${nom}`);
      for (const [k, v] of Object.entries(attrs)) el.setAttributeNS(W_NS, `w:${k}`, v);
      return el;
    };
    const normal = Array.from(racine.getElementsByTagNameNS(W_NS, "style")).find(
      (s) => attrW(s, "type") === "paragraph" && /^(1|true)$/.test(attrW(s, "default") ?? ""),
    );
    const pris = new Set(Array.from(racine.getElementsByTagNameNS(W_NS, "style")).map((s) => attrW(s, "styleId")));
    let id = `Heading${n}`;
    while (pris.has(id)) id = `${id}Axe`;
    const style = mk("style", { type: "paragraph", styleId: id });
    style.appendChild(mk("name", { val: `heading ${n}` }));
    const idNormal = normal ? attrW(normal, "styleId") : null;
    if (idNormal) {
      style.appendChild(mk("basedOn", { val: idNormal }));
      style.appendChild(mk("next", { val: idNormal }));
    }
    style.appendChild(mk("qFormat"));
    const pPr = mk("pPr");
    pPr.appendChild(mk("keepNext"));
    pPr.appendChild(mk("spacing", { before: n === 1 ? "360" : "240", after: "120" }));
    pPr.appendChild(mk("outlineLvl", { val: String(n - 1) }));
    style.appendChild(pPr);
    const rPr = mk("rPr");
    rPr.appendChild(mk("b"));
    rPr.appendChild(mk("sz", { val: ["32", "28", "24"][n - 1] ?? "24" }));
    style.appendChild(rPr);
    racine.appendChild(style);
    this.stylesChange = true;
    this.titres.set(n, id);
    return id;
  }

  /** numId d'une liste du type voulu (créée dans numbering.xml si besoin). */
  numero(type: "bullet" | "decimal", souhaite: string | null): string {
    const ok = (id: string) => {
      const f = this.formats.get(id)?.get(0);
      return f !== undefined && (type === "bullet" ? f === "bullet" : f !== "bullet" && f !== "none");
    };
    if (souhaite && ok(souhaite)) return souhaite;
    const deja = this.numDefaut.get(type);
    if (deja) return deja;
    for (const id of this.formats.keys()) {
      if (ok(id)) {
        this.numDefaut.set(type, id);
        return id;
      }
    }
    if (!this.numDoc) {
      this.numDoc = new DOMParser().parseFromString(`<w:numbering xmlns:w="${W_NS}"/>`, "application/xml");
    }
    const racine = this.numDoc.documentElement;
    const mk = (nom: string, attrs: Record<string, string> = {}) => {
      const el = this.numDoc!.createElementNS(W_NS, `w:${nom}`);
      for (const [k, v] of Object.entries(attrs)) el.setAttributeNS(W_NS, `w:${k}`, v);
      return el;
    };
    const max = (nom: string, attr: string) =>
      Math.max(0, ...Array.from(racine.getElementsByTagNameNS(W_NS, nom)).map((e) => Number(attrW(e, attr)) || 0));
    const abs = String(max("abstractNum", "abstractNumId") + 1);
    const num = String(Math.max(max("num", "numId"), ...[...this.formats.keys()].map(Number).filter(Number.isFinite)) + 1);
    const a = mk("abstractNum", { abstractNumId: abs });
    a.appendChild(mk("multiLevelType", { val: "hybridMultilevel" }));
    const puces = ["\u2022", "\u25e6", "\u25aa"];
    const formats = ["decimal", "lowerLetter", "lowerRoman"];
    for (let l = 0; l < 9; l += 1) {
      const lvl = mk("lvl", { ilvl: String(l) });
      lvl.appendChild(mk("start", { val: "1" }));
      lvl.appendChild(mk("numFmt", { val: type === "bullet" ? "bullet" : formats[l % 3] }));
      lvl.appendChild(mk("lvlText", { val: type === "bullet" ? puces[l % 3] : `%${l + 1}.` }));
      lvl.appendChild(mk("lvlJc", { val: "left" }));
      const pPr = mk("pPr");
      pPr.appendChild(mk("ind", { left: String(720 * (l + 1)), hanging: "360" }));
      lvl.appendChild(pPr);
      a.appendChild(lvl);
    }
    const premierNum = Array.from(racine.childNodes).find((c) => (c as Element).localName === "num");
    racine.insertBefore(a, premierNum ?? null);
    const n = mk("num", { numId: num });
    n.appendChild(mk("abstractNumId", { val: abs }));
    racine.appendChild(n);
    this.formats.set(num, new Map([[0, type]]));
    this.numDefaut.set(type, num);
    this.numChange = true;
    return num;
  }

  /** Paragraphe Word pour un bloc HTML (p, h1-h6, pre…). */
  paragraphe(el: HTMLElement, liste: { numId: string; ilvl: number } | null): Element {
    const p = this.w("p");
    const tag = el.tagName.toLowerCase();
    const ppr = el.getAttribute("data-docx-ppr");
    const pPr = (ppr && this.brut(ppr)) || this.w("pPr");
    const h = /^h([1-6])$/.exec(tag);
    if (h) {
      const id = this.styleTitre(Math.min(3, Number(h[1])));
      if (id) this.placer(pPr, this.w("pStyle", { val: id }), ORDRE_PPR);
    }
    if (liste) {
      const numPr = this.w("numPr");
      numPr.appendChild(this.w("ilvl", { val: String(liste.ilvl) }));
      numPr.appendChild(this.w("numId", { val: liste.numId }));
      this.placer(pPr, numPr, ORDRE_PPR);
    }
    const align = (el.style?.textAlign || "").toLowerCase();
    const jc = align === "center" ? "center" : align === "right" ? "right" : align === "justify" ? "both" : null;
    this.retirer(pPr, ["jc"]);
    if (jc) this.placer(pPr, this.w("jc", { val: jc }), ORDRE_PPR);
    if (enfants(pPr).length) p.appendChild(pPr);
    const etat: Etat = { b: false, i: false, u: false, s: false, couleur: null, surlignage: null, taille: null, police: null, rpr: null };
    if (tag === "pre") etat.police = "Consolas";
    const out: Element[] = [];
    for (let c = el.firstChild; c; c = c.nextSibling) this.enLigne(c, etat, out);
    for (const x of out) p.appendChild(x);
    return p;
  }

  liste(el: HTMLElement, profondeur: number, out: Element[]) {
    const type = el.tagName.toLowerCase() === "ul" ? "bullet" : "decimal";
    const numId = this.numero(type, el.getAttribute("data-docx-num"));
    for (const li of Array.from(el.children)) {
      if (li.tagName.toLowerCase() !== "li") continue;
      let premier = true;
      const enLigne: Node[] = [];
      const vider = () => {
        if (!enLigne.length) return;
        if (enLigne.every((n) => n.nodeType === 3 && !(n.nodeValue ?? "").trim())) {
          enLigne.length = 0;
          return;
        }
        const p = li.ownerDocument!.createElement("p");
        for (const n of enLigne.splice(0)) p.appendChild(n.cloneNode(true));
        out.push(this.paragraphe(p, premier ? { numId, ilvl: profondeur } : null));
        premier = false;
      };
      for (const c of Array.from(li.childNodes)) {
        const t = c.nodeType === 1 ? (c as Element).tagName.toLowerCase() : "";
        if (t === "ul" || t === "ol") {
          vider();
          this.liste(c as HTMLElement, Math.min(8, profondeur + 1), out);
        } else if (/^(p|h[1-6]|pre)$/.test(t)) {
          vider();
          out.push(this.paragraphe(c as HTMLElement, premier ? { numId, ilvl: profondeur } : null));
          premier = false;
        } else enLigne.push(c);
      }
      vider();
      if (premier) out.push(this.paragraphe(li.ownerDocument!.createElement("p"), { numId, ilvl: profondeur }));
    }
  }

  tableau(t: HTMLElement): Element {
    const tbl = this.w("tbl");
    const tblPr = t.getAttribute("data-docx-tblpr");
    let pr = tblPr ? this.brut(tblPr) : null;
    if (!pr) {
      pr = this.w("tblPr");
      pr.appendChild(this.w("tblW", { w: "0", type: "auto" }));
      const bords = this.w("tblBorders");
      for (const cote of ["top", "left", "bottom", "right", "insideH", "insideV"]) {
        bords.appendChild(this.w(cote, { val: "single", sz: "4", space: "0", color: "auto" }));
      }
      pr.appendChild(bords);
      pr.appendChild(this.w("tblLook", { val: "04A0" }));
    }
    tbl.appendChild(pr);
    const lignes = Array.from(t.querySelectorAll("tr")).filter((tr) => tr.closest("table") === t);
    const colonnes = Math.max(1, ...lignes.map((tr) => Array.from(tr.children).filter((c) => /^t[dh]$/i.test(c.tagName)).length));
    const grilleBrute = t.getAttribute("data-docx-grid");
    let grille = grilleBrute ? this.brut(grilleBrute) : null;
    if (!grille || enfants(grille, "gridCol").length !== colonnes) {
      grille = this.w("tblGrid");
      for (let i = 0; i < colonnes; i += 1) grille.appendChild(this.w("gridCol", { w: String(Math.floor(9638 / colonnes)) }));
    }
    tbl.appendChild(grille);
    for (const tr of lignes) {
      const wtr = this.w("tr");
      const trPr = tr.getAttribute("data-docx-trpr");
      const x = trPr ? this.brut(trPr) : null;
      if (x) wtr.appendChild(x);
      for (const td of Array.from(tr.children)) {
        if (!/^t[dh]$/i.test(td.tagName)) continue;
        const tc = this.w("tc");
        const tcPr = td.getAttribute("data-docx-tcpr");
        const y = (tcPr && this.brut(tcPr)) || null;
        if (y) tc.appendChild(y);
        else {
          const p = this.w("tcPr");
          p.appendChild(this.w("tcW", { w: String(Math.floor(9638 / colonnes)), type: "dxa" }));
          tc.appendChild(p);
        }
        const blocs: Element[] = [];
        this.blocs(td as HTMLElement, blocs);
        const paras = blocs.filter((b) => b.localName === "p" || b.localName === "tbl" || b.localName === "sdt");
        if (!paras.length || paras[paras.length - 1].localName !== "p") paras.push(this.w("p"));
        for (const b of paras) tc.appendChild(b);
        wtr.appendChild(tc);
      }
      tbl.appendChild(wtr);
    }
    return tbl;
  }

  /** Blocs Word pour le contenu d'un conteneur HTML (corps, cellule, citation…). */
  blocs(parent: HTMLElement, out: Element[]) {
    let enLigne: Node[] = [];
    const vider = () => {
      if (enLigne.some((n) => n.nodeType !== 3 || (n.nodeValue ?? "").trim())) {
        const p = parent.ownerDocument!.createElement("p");
        for (const n of enLigne) p.appendChild(n.cloneNode(true));
        out.push(this.paragraphe(p, null));
      }
      enLigne = [];
    };
    for (const c of Array.from(parent.childNodes)) {
      if (c.nodeType !== 1) {
        enLigne.push(c);
        continue;
      }
      const el = c as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (el.getAttribute("data-docx-brut") !== null && tag === "div") {
        vider();
        const x = this.brut(el.getAttribute("data-docx-brut")!);
        if (x) out.push(x);
        else this.perte("éléments illisibles");
      } else if (/^(p|h[1-6])$/.test(tag)) {
        vider();
        out.push(this.paragraphe(el, null));
      } else if (tag === "pre") {
        vider();
        for (const ligne of (el.textContent ?? "").split("\n")) {
          const p = parent.ownerDocument!.createElement("pre");
          p.textContent = ligne;
          out.push(this.paragraphe(p, null));
        }
      } else if (tag === "ul" || tag === "ol") {
        vider();
        this.liste(el, 0, out);
      } else if (tag === "table") {
        vider();
        out.push(this.tableau(el));
      } else if (tag === "hr") {
        vider();
        const p = this.w("p");
        const pPr = this.w("pPr");
        const bdr = this.w("pBdr");
        bdr.appendChild(this.w("bottom", { val: "single", sz: "6", space: "1", color: "auto" }));
        pPr.appendChild(bdr);
        p.appendChild(pPr);
        out.push(p);
      } else if (/^(div|blockquote|section|article|tbody|thead|figure)$/.test(tag)) {
        vider();
        this.blocs(el, out);
      } else if (tag === "colgroup") {
        continue;
      } else enLigne.push(c);
    }
    vider();
  }
}

const serialiserDoc = (d: Document) => {
  const xml = new XMLSerializer().serializeToString(d);
  return xml.startsWith("<?xml") ? xml : DECLARATION + xml;
};

/** Nouveau word/document.xml (et styles, numérotation, relations si besoin) pour le HTML de l'éditeur. */
export function htmlVersDocx(src: SourcesExport): ResultatExport {
  const ex = new Exporteur(src);
  const body = enfant(ex.doc.documentElement, "body");
  if (!body) throw new Error("document Word sans corps (w:body)");
  const sectPr = enfants(body).filter((c) => c.localName === "sectPr").pop() ?? null;
  while (body.firstChild) body.removeChild(body.firstChild);
  const html = new DOMParser().parseFromString(`<!doctype html><html><body>${src.html}</body></html>`, "text/html");
  const blocs: Element[] = [];
  ex.blocs(html.body, blocs);
  if (!blocs.length) blocs.push(ex.w("p"));
  for (const b of blocs) body.appendChild(b);
  if (sectPr) body.appendChild(sectPr);
  return {
    documentXml: serialiserDoc(ex.doc),
    stylesXml: ex.stylesChange && ex.stylesDoc ? serialiserDoc(ex.stylesDoc) : null,
    numberingXml: ex.numChange && ex.numDoc ? serialiserDoc(ex.numDoc) : null,
    relsXml: ex.relsChange && ex.relsDoc ? serialiserDoc(ex.relsDoc) : null,
    pertes: [...ex.pertes].map(([q, n]) => (n > 1 ? `${q} (${n})` : q)),
  };
}

export { serialiser };
