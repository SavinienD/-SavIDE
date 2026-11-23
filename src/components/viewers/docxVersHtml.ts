// conversion d'un document Word (word/document.xml) en HTML pour l'éditeur riche.
//
// Le HTML produit suit le schéma de l'éditeur (TipTap) : <p>, <h1>-<h3>, listes, tableaux
// simples, marques (gras, italique, souligné, barré, surlignage, couleur, taille, police).
// Ce que l'éditeur ne sait pas modifier est gardé tel quel (XML brut dans data-docx-brut :
// images, notes, champs, tableaux fusionnés, tables des matières…), les propriétés de
// paragraphe et de texte non gérées aussi (data-docx-ppr / data-docx-rpr). Les éléments
// qui seront perdus à l'enregistrement sont listés dans `pertes`.
// Pur (DOMParser / XMLSerializer globaux) : testé par tests/docxEdition.test.cjs.

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Couleurs de surlignage de Word (w:highlight) et leur valeur. */
export const SURLIGNAGES_WORD: Record<string, string> = {
  yellow: "#ffff00",
  green: "#00ff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  blue: "#0000ff",
  red: "#ff0000",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#c0c0c0",
  black: "#000000",
  white: "#ffffff",
};

export function enfants(el: Element, nom?: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!nom || (n as Element).localName === nom)) out.push(n as Element);
  }
  return out;
}

export function enfant(el: Element | null | undefined, nom: string): Element | null {
  if (!el) return null;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).localName === nom) return n as Element;
  }
  return null;
}

export function attrW(el: Element | null | undefined, nom: string): string | null {
  if (!el) return null;
  return el.getAttributeNS(W_NS, nom) ?? el.getAttribute(`w:${nom}`);
}

/** Valeur booléenne d'une propriété (<w:b/>, <w:b w:val="0"/>…). */
function vrai(el: Element | null): boolean {
  if (!el) return false;
  const v = attrW(el, "val");
  return v === null || !/^(0|false|off|none)$/i.test(v);
}

export function serialiser(n: Node): string {
  return new XMLSerializer().serializeToString(n);
}

export function echapper(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type SourcesDocx = {
  documentXml: string;
  stylesXml?: string | null;
  numberingXml?: string | null;
  /** word/_rels/document.xml.rels */
  relsXml?: string | null;
  /** Image d'une relation (r:embed) en data URL, si connue. */
  imageDe?: (rid: string) => string | null;
};

export type ResultatImport = { html: string; pertes: string[] };

/** Id des styles de titre 1 à 3 (d'après leur nom interne « heading N »). */
export function stylesTitres(stylesXml: string | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!stylesXml) return out;
  const doc = new DOMParser().parseFromString(stylesXml, "application/xml");
  for (const s of Array.from(doc.getElementsByTagNameNS(W_NS, "style"))) {
    const id = attrW(s, "styleId");
    const nom = attrW(enfant(s, "name"), "val") ?? "";
    const m = /^heading\s*(\d)$/i.exec(nom.trim()) ?? /^(?:heading|titre)(\d)$/i.exec(id ?? "");
    if (id && m) out.set(id, Number(m[1]));
  }
  return out;
}

/** Format du niveau 0 de chaque numId (« bullet », « decimal »…). */
export function formatsListes(numberingXml: string | null | undefined): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  if (!numberingXml) return out;
  const doc = new DOMParser().parseFromString(numberingXml, "application/xml");
  const abstraits = new Map<string, Map<number, string>>();
  for (const a of Array.from(doc.getElementsByTagNameNS(W_NS, "abstractNum"))) {
    const niveaux = new Map<number, string>();
    for (const lvl of enfants(a, "lvl")) niveaux.set(Number(attrW(lvl, "ilvl") ?? 0), attrW(enfant(lvl, "numFmt"), "val") ?? "decimal");
    abstraits.set(attrW(a, "abstractNumId") ?? "", niveaux);
  }
  for (const n of Array.from(doc.getElementsByTagNameNS(W_NS, "num"))) {
    const a = attrW(enfant(n, "abstractNumId"), "val") ?? "";
    out.set(attrW(n, "numId") ?? "", abstraits.get(a) ?? new Map());
  }
  return out;
}

export function relations(relsXml: string | null | undefined): Map<string, { cible: string; externe: boolean; type: string }> {
  const out = new Map<string, { cible: string; externe: boolean; type: string }>();
  if (!relsXml) return out;
  const doc = new DOMParser().parseFromString(relsXml, "application/xml");
  for (const r of Array.from(doc.getElementsByTagName("Relationship"))) {
    out.set(r.getAttribute("Id") ?? "", {
      cible: r.getAttribute("Target") ?? "",
      externe: r.getAttribute("TargetMode") === "External",
      type: r.getAttribute("Type") ?? "",
    });
  }
  return out;
}

/** Normalise une couleur Word (« FF0000 », « auto ») en #rrggbb, ou null. */
function couleurHex(v: string | null): string | null {
  if (!v || !/^[0-9a-f]{6}$/i.test(v)) return null;
  return `#${v.toLowerCase()}`;
}

type Fmt = {
  b: boolean;
  i: boolean;
  u: boolean;
  s: boolean;
  couleur: string | null;
  surlignage: string | null;
  taille: string | null;
  police: string | null;
  rpr: string | null;
};

const RPR_GERES = new Set(["b", "i", "u", "strike", "dstrike", "color", "highlight", "shd", "sz", "szCs", "rFonts"]);
const PPR_GERES = new Set(["jc", "numPr"]);

function lireFmt(rPr: Element | null, xml: (e: Element) => string = serialiser): Fmt {
  const f: Fmt = { b: false, i: false, u: false, s: false, couleur: null, surlignage: null, taille: null, police: null, rpr: null };
  if (!rPr) return f;
  f.b = vrai(enfant(rPr, "b"));
  f.i = vrai(enfant(rPr, "i"));
  const u = enfant(rPr, "u");
  f.u = Boolean(u && (attrW(u, "val") ?? "single") !== "none");
  f.s = vrai(enfant(rPr, "strike")) || vrai(enfant(rPr, "dstrike"));
  f.couleur = couleurHex(attrW(enfant(rPr, "color"), "val"));
  const hl = attrW(enfant(rPr, "highlight"), "val");
  if (hl && hl !== "none") f.surlignage = SURLIGNAGES_WORD[hl] ?? null;
  if (!f.surlignage) {
    const shd = enfant(rPr, "shd");
    f.surlignage = couleurHex(attrW(shd, "fill"));
  }
  const sz = Number(attrW(enfant(rPr, "sz"), "val"));
  if (sz > 0) f.taille = `${sz / 2}pt`;
  const rf = enfant(rPr, "rFonts");
  f.police = attrW(rf, "ascii") ?? attrW(rf, "hAnsi") ?? null;
  const reste = rPr.cloneNode(true) as Element;
  for (const c of enfants(reste)) if (RPR_GERES.has(c.localName)) reste.removeChild(c);
  if (enfants(reste).length) f.rpr = xml(reste);
  return f;
}

function habiller(html: string, f: Fmt): string {
  let h = html;
  if (f.b) h = `<strong>${h}</strong>`;
  if (f.i) h = `<em>${h}</em>`;
  if (f.u) h = `<u>${h}</u>`;
  if (f.s) h = `<s>${h}</s>`;
  if (f.surlignage) h = `<mark data-color="${f.surlignage}" style="background-color: ${f.surlignage}; color: inherit">${h}</mark>`;
  const styles: string[] = [];
  if (f.couleur) styles.push(`color: ${f.couleur}`);
  if (f.taille) styles.push(`font-size: ${f.taille}`);
  if (f.police) styles.push(`font-family: ${f.police}`);
  if (styles.length || f.rpr) {
    const rpr = f.rpr ? ` data-docx-rpr="${echapper(f.rpr)}"` : "";
    h = `<span${styles.length ? ` style="${echapper(styles.join("; "))}"` : ""}${rpr}>${h}</span>`;
  }
  return h;
}

const LIBELLES: Record<string, string> = {
  drawing: "Image",
  pict: "Image",
  object: "Objet",
  AlternateContent: "Objet",
  footnoteReference: "Note",
  endnoteReference: "Note de fin",
  fldSimple: "Champ",
  sym: "Symbole",
  br: "Saut de page",
  oMath: "Équation",
  oMathPara: "Équation",
  sdt: "Contrôle",
};

class Importeur {
  pertes = new Map<string, number>();
  titres: Map<string, number>;
  listes: Map<string, Map<number, string>>;
  rels: ReturnType<typeof relations>;
  decls: Attr[] = [];
  constructor(private src: SourcesDocx) {
    this.titres = stylesTitres(src.stylesXml);
    this.listes = formatsListes(src.numberingXml);
    this.rels = relations(src.relsXml);
  }
  perte(quoi: string) {
    this.pertes.set(quoi, (this.pertes.get(quoi) ?? 0) + 1);
  }

  /** XML d'un élément gardé, avec les déclarations d'espaces de noms de la racine (préfixes
   *  conservés : mc:Ignorable / Requires y font référence par leur nom). */
  xml(el: Element): string {
    const copie = el.cloneNode(true) as Element;
    const prefixes = new Set<string>();
    for (const e of [copie, ...Array.from(copie.getElementsByTagName("*"))]) {
      if (e.prefix) prefixes.add(e.prefix);
      for (const a of Array.from(e.attributes)) {
        if (a.prefix && a.prefix !== "xmlns") prefixes.add(a.prefix);
        if (/^(Ignorable|Requires|ProcessContent|MustUnderstand)$/.test(a.localName)) {
          for (const p of a.value.split(/\s+/)) prefixes.add(p.split(":")[0]);
        }
      }
    }
    for (const a of this.decls) {
      if (prefixes.has(a.name.slice(6)) && !copie.hasAttribute(a.name)) copie.setAttributeNS("http://www.w3.org/2000/xmlns/", a.name, a.value);
    }
    return serialiser(copie);
  }

  /** Élément gardé tel quel, affiché comme une étiquette (ou une image). */
  brutEnLigne(el: Element, libelle?: string): string {
    const xml = echapper(this.xml(el));
    let rid: string | null = null;
    for (const b of Array.from(el.getElementsByTagName("*"))) {
      if (b.localName === "blip") rid = b.getAttributeNS(R_NS, "embed") ?? b.getAttribute("r:embed");
      else if (b.localName === "imagedata" && !rid) rid = b.getAttributeNS(R_NS, "id") ?? b.getAttribute("r:id");
      if (rid) break;
    }
    const src = rid ? this.src.imageDe?.(rid) : null;
    const nom = libelle ?? LIBELLES[el.localName] ?? (rid ? "Image" : "Élément");
    if (src) return `<img data-docx-brut="${xml}" data-libelle="${echapper(nom)}" src="${echapper(src)}" alt="${echapper(nom)}">`;
    const texte = (el.textContent ?? "").trim();
    return `<span data-docx-brut="${xml}" data-libelle="${echapper(nom)}">${echapper(texte ? `${nom} : ${texte.slice(0, 40)}` : nom)}</span>`;
  }

  /** Une course w:r : texte formaté et éléments gardés. */
  course(r: Element): string {
    const rPr = enfant(r, "rPr");
    const f = lireFmt(rPr, (e) => this.xml(e));
    let out = "";
    let texte = "";
    const vider = () => {
      if (texte) out += habiller(echapper(texte), f);
      texte = "";
    };
    for (const c of enfants(r)) {
      switch (c.localName) {
        case "rPr":
        case "lastRenderedPageBreak":
        case "softHyphen":
          break;
        case "t":
        case "delText":
          texte += c.textContent ?? "";
          break;
        case "tab":
        case "ptab":
          texte += "\t";
          break;
        case "noBreakHyphen":
          texte += "\u2011";
          break;
        case "cr":
          vider();
          out += "<br>";
          break;
        case "br":
          if (attrW(c, "type") === "page" || attrW(c, "type") === "column") {
            vider();
            out += this.brutEnLigne(this.courseSeule(r, rPr, c), attrW(c, "type") === "page" ? "Saut de page" : "Saut de colonne");
          } else {
            vider();
            out += "<br>";
          }
          break;
        case "fldChar":
        case "instrText":
          this.perte("champs calculés (leur texte est gardé)");
          break;
        case "commentReference":
          this.perte("commentaires");
          break;
        default:
          vider();
          out += this.brutEnLigne(this.courseSeule(r, rPr, c));
      }
    }
    vider();
    return out;
  }

  /** Copie de la course réduite à ses propriétés et à un seul enfant. */
  courseSeule(r: Element, rPr: Element | null, c: Element): Element {
    const copie = r.cloneNode(false) as Element;
    if (rPr) copie.appendChild(rPr.cloneNode(true));
    copie.appendChild(c.cloneNode(true));
    return copie;
  }

  /** Contenu en ligne d'un paragraphe (ou d'un lien, d'une insertion…). */
  enLigne(parent: Element): string {
    let out = "";
    for (const c of enfants(parent)) {
      switch (c.localName) {
        case "pPr":
        case "proofErr":
        case "permStart":
        case "permEnd":
          break;
        case "r":
          out += this.course(c);
          break;
        case "hyperlink": {
          const rid = c.getAttributeNS(R_NS, "id") ?? c.getAttribute("r:id");
          const ancre = attrW(c, "anchor");
          const href = rid ? this.rels.get(rid)?.cible : ancre ? `#${ancre}` : null;
          const contenu = this.enLigne(c);
          out += href ? `<a href="${echapper(href)}">${contenu}</a>` : contenu;
          break;
        }
        case "ins":
        case "moveTo":
          this.perte("suivi des modifications (insertions acceptées)");
          out += this.enLigne(c);
          break;
        case "del":
        case "moveFrom":
          this.perte("suivi des modifications (suppressions acceptées)");
          break;
        case "bookmarkStart":
          if (attrW(c, "name") !== "_GoBack") this.perte("signets");
          break;
        case "bookmarkEnd":
          break;
        case "commentRangeStart":
          this.perte("commentaires");
          break;
        case "commentRangeEnd":
          break;
        case "smartTag":
        case "customXml":
          out += this.enLigne(c);
          break;
        case "sdt": {
          const contenu = enfant(c, "sdtContent");
          if (contenu) {
            this.perte("contrôles de contenu (leur texte est gardé)");
            out += this.enLigne(contenu);
          }
          break;
        }
        default:
          out += this.brutEnLigne(c);
      }
    }
    return out;
  }

  /** Un paragraphe : balise (p / h1-h3), attributs et contenu ; liste éventuelle. */
  paragraphe(p: Element): { html: string; liste: { numId: string; ilvl: number; tag: "ul" | "ol" } | null } {
    const pPr = enfant(p, "pPr");
    const style = attrW(enfant(pPr, "pStyle"), "val");
    const niveau = style ? this.titres.get(style) ?? 0 : 0;
    const titre = niveau >= 1 && niveau <= 3 ? niveau : 0;
    const numPr = enfant(pPr, "numPr");
    const numId = attrW(enfant(numPr, "numId"), "val");
    const ilvl = Number(attrW(enfant(numPr, "ilvl"), "val") ?? 0) || 0;
    const fmt = numId && numId !== "0" ? this.listes.get(numId)?.get(ilvl) ?? this.listes.get(numId)?.get(0) : undefined;
    const liste = fmt && fmt !== "none" && !titre ? { numId: numId!, ilvl, tag: (fmt === "bullet" ? "ul" : "ol") as "ul" | "ol" } : null;
    const jc = attrW(enfant(pPr, "jc"), "val");
    const align =
      jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : jc === "both" || jc === "distribute" ? "justify" : null;
    let ppr: string | null = null;
    if (pPr) {
      const reste = pPr.cloneNode(true) as Element;
      for (const c of enfants(reste)) {
        if (c.localName === "jc" || (c.localName === "numPr" && liste) || (c.localName === "pStyle" && titre)) reste.removeChild(c);
      }
      if (enfants(reste).length) ppr = this.xml(reste);
    }
    const tag = titre ? `h${titre}` : "p";
    const attrs =
      (align ? ` style="text-align: ${align}"` : "") + (ppr ? ` data-docx-ppr="${echapper(ppr)}"` : "");
    return { html: `<${tag}${attrs}>${this.enLigne(p)}</${tag}>`, liste };
  }

  brutBloc(el: Element, libelle: string): string {
    const texte = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    return `<div data-docx-brut="${echapper(this.xml(el))}" data-libelle="${echapper(libelle)}">${echapper(
      texte ? `${libelle} : ${texte.slice(0, 120)}${texte.length > 120 ? "…" : ""}` : libelle,
    )}</div>`;
  }

  /** Tableau simple (sans cellules fusionnées ni tableau imbriqué) ; sinon gardé tel quel. */
  tableau(t: Element): string {
    const lignes = enfants(t, "tr");
    let simple = lignes.length > 0;
    for (const tr of lignes) {
      for (const c of enfants(tr)) {
        if (c.localName === "trPr" || c.localName === "tblPrEx") continue;
        if (c.localName !== "tc") simple = false;
        else {
          const tcPr = enfant(c, "tcPr");
          if (Number(attrW(enfant(tcPr, "gridSpan"), "val") ?? 1) > 1 || enfant(tcPr, "vMerge") || enfant(tcPr, "hMerge")) simple = false;
          for (const x of enfants(c)) {
            if (x.localName === "tcPr") continue;
            if (x.localName !== "p" || enfant(enfant(x, "pPr"), "numPr")) simple = false;
          }
        }
      }
    }
    if (!simple) return this.brutBloc(t, "Tableau (gardé tel quel, non modifiable ici)");
    const tblPr = enfant(t, "tblPr");
    const grille = enfant(t, "tblGrid");
    let out = `<table${tblPr ? ` data-docx-tblpr="${echapper(this.xml(tblPr))}"` : ""}${
      grille ? ` data-docx-grid="${echapper(this.xml(grille))}"` : ""
    }><tbody>`;
    for (const tr of lignes) {
      const trPr = enfant(tr, "trPr");
      out += `<tr${trPr ? ` data-docx-trpr="${echapper(this.xml(trPr))}"` : ""}>`;
      for (const tc of enfants(tr, "tc")) {
        const tcPr = enfant(tc, "tcPr");
        const paras = enfants(tc, "p").map((p) => this.paragraphe(p).html).join("") || "<p></p>";
        out += `<td${tcPr ? ` data-docx-tcpr="${echapper(this.xml(tcPr))}"` : ""}>${paras}</td>`;
      }
      out += "</tr>";
    }
    return `${out}</tbody></table>`;
  }

  corps(body: Element): string {
    let out = "";
    const pile: { tag: string }[] = [];
    const fermer = (jusqua: number) => {
      while (pile.length > jusqua) out += `</li></${pile.pop()!.tag}>`;
    };
    for (const c of enfants(body)) {
      if (c.localName === "p") {
        const { html, liste } = this.paragraphe(c);
        if (!liste) {
          fermer(0);
          out += html;
          continue;
        }
        const d = Math.min(liste.ilvl, pile.length);
        fermer(d + 1);
        if (pile.length === d + 1 && pile[d].tag !== liste.tag) fermer(d);
        if (pile.length === d + 1) out += `</li><li>${html}`;
        else {
          out += `<${liste.tag} data-docx-num="${echapper(liste.numId)}"><li>${html}`;
          pile.push({ tag: liste.tag });
        }
        continue;
      }
      fermer(0);
      switch (c.localName) {
        case "sectPr":
          break;
        case "tbl":
          out += this.tableau(c);
          break;
        case "bookmarkStart":
          this.perte("signets");
          break;
        case "bookmarkEnd":
        case "proofErr":
          break;
        case "sdt":
          out += this.brutBloc(c, "Bloc (table des matières ou contrôle)");
          break;
        default:
          out += this.brutBloc(c, "Élément");
      }
    }
    fermer(0);
    return out;
  }
}

/** HTML de l'éditeur pour un document Word, et ce qui serait perdu à l'enregistrement. */
export function docxVersHtml(src: SourcesDocx): ResultatImport {
  const doc = new DOMParser().parseFromString(src.documentXml, "application/xml");
  const body = enfant(doc.documentElement, "body");
  if (!body) throw new Error("document Word sans corps (w:body)");
  const imp = new Importeur(src);
  imp.decls = Array.from(doc.documentElement.attributes).filter((a) => a.name.startsWith("xmlns:"));
  const html = imp.corps(body) || "<p></p>";
  const pertes = [...imp.pertes].map(([quoi, n]) => (n > 1 ? `${quoi} (${n})` : quoi));
  return { html, pertes };
}

/** HTML de paragraphes de texte brut (lecture d'un .pages). */
export function htmlDeParagraphes(paras: string[]): string {
  return paras.map((p) => `<p>${echapper(p).replace(/\t/g, "&#9;")}</p>`).join("") || "<p></p>";
}
