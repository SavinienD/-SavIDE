// axe:viewers — approximate PowerPoint (.pptx) parser. Reads only the XML
// parts it needs (via viewer_zip_read) and produces positioned text boxes,
// pictures and tables. Theme fonts, effects, SmartArt, charts and
// animations are not reproduced: the viewer says so explicitly.

import { readZipText, resolveZipPath } from "./bytes";

const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** EMU per typographic point. All geometry below is expressed in points. */
const EMU_PER_PT = 12700;

export type PptxBox = { x: number; y: number; w: number; h: number; rot: number };
export type PptxRun = {
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color?: string;
};
export type PptxParagraph = {
  runs: PptxRun[];
  align?: "left" | "center" | "right" | "justify";
  level: number;
  bullet: boolean;
  emptySize: number;
};
export type PptxShape =
  | {
      kind: "text";
      box: PptxBox;
      paragraphs: PptxParagraph[];
      fill?: string;
      border?: string;
      radius?: string;
      anchor?: string;
    }
  | { kind: "image"; box: PptxBox; target: string | null }
  | { kind: "table"; box: PptxBox; rows: string[][] }
  | { kind: "other"; box: PptxBox; label: string };
export type PptxSlide = {
  number: number;
  shapes: PptxShape[];
  background: string;
  title: string;
  lines: string[];
  hidden: boolean;
};
export type PptxDeck = { width: number; height: number; slides: PptxSlide[] };

// ---------------------------------------------------------------- XML ----

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("XML invalide");
  return doc;
}
export function kids(el: Element | null | undefined, name: string): Element[] {
  return el ? Array.from(el.children).filter((child) => child.localName === name) : [];
}
export function kid(el: Element | null | undefined, name: string): Element | null {
  return kids(el, name)[0] ?? null;
}
function at(el: Element | null | undefined, ...names: string[]): Element | null {
  let current = el ?? null;
  for (const name of names) current = kid(current, name);
  return current;
}
function all(root: Document | Element | null | undefined, name: string): Element[] {
  return root ? Array.from(root.getElementsByTagNameNS("*", name)) : [];
}
function num(el: Element | null, attr: string, fallback = 0): number {
  const value = Number(el?.getAttribute(attr));
  return Number.isFinite(value) && el?.hasAttribute(attr) ? value : fallback;
}
function relId(el: Element | null, name: string): string | null {
  return el?.getAttributeNS(R_NS, name) || el?.getAttribute(`r:${name}`) || null;
}

export type Rels = Map<string, { target: string; type: string; external: boolean }>;

/** Relationships of a part (`dir/_rels/name.rels`), targets resolved. */
export async function readRels(file: string, names: Set<string>, part: string): Promise<Rels> {
  const slash = part.lastIndexOf("/");
  const relsPath = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
  const rels: Rels = new Map();
  if (!names.has(relsPath)) return rels;
  for (const rel of all(parseXml(await readZipText(file, relsPath)), "Relationship")) {
    const external = rel.getAttribute("TargetMode") === "External";
    const target = rel.getAttribute("Target") ?? "";
    rels.set(rel.getAttribute("Id") ?? "", {
      target: external ? target : resolveZipPath(part, target),
      type: rel.getAttribute("Type") ?? "",
      external,
    });
  }
  return rels;
}

export function relOfType(rels: Rels, suffix: string): string | null {
  for (const rel of rels.values()) if (rel.type.endsWith(suffix)) return rel.target;
  return null;
}

// ------------------------------------------------------------- colours ----

type Palette = { theme: Record<string, string>; map: Record<string, string> };

function colorOf(holder: Element | null, palette: Palette): string | undefined {
  if (!holder) return undefined;
  const srgb = kid(holder, "srgbClr");
  if (srgb) return `#${srgb.getAttribute("val")}`;
  const scheme = kid(holder, "schemeClr");
  if (scheme) {
    const name = scheme.getAttribute("val") ?? "";
    return palette.theme[palette.map[name] ?? name];
  }
  const sys = kid(holder, "sysClr");
  if (sys) return `#${sys.getAttribute("lastClr") ?? "000000"}`;
  return kid(holder, "prstClr")?.getAttribute("val") ?? undefined;
}

/** Solid colour of a fill container (solidFill, or first gradient stop). */
function fillOf(container: Element | null, palette: Palette): string | undefined {
  const solid = kid(container, "solidFill");
  if (solid) return colorOf(solid, palette);
  const stop = at(container, "gradFill", "gsLst", "gs");
  return stop ? colorOf(stop, palette) : undefined;
}

function parseTheme(doc: Document | null): Record<string, string> {
  const out: Record<string, string> = {};
  const scheme = all(doc, "clrScheme")[0];
  for (const entry of Array.from(scheme?.children ?? [])) {
    const value = kid(entry, "srgbClr")?.getAttribute("val") ?? kid(entry, "sysClr")?.getAttribute("lastClr");
    if (value) out[entry.localName] = `#${value}`;
  }
  return out;
}

// ---------------------------------------------------------------- text ----

const ALIGN: Record<string, PptxParagraph["align"]> = {
  l: "left",
  ctr: "center",
  r: "right",
  just: "justify",
  dist: "justify",
};

type TextDefaults = { sizeFor: (level: number) => number; color?: string; bullets: boolean };

function parseParagraphs(txBody: Element | null, palette: Palette, defaults: TextDefaults): PptxParagraph[] {
  const bodyPr = kid(txBody, "bodyPr");
  const scale = num(kid(bodyPr, "normAutofit"), "fontScale", 100000) / 100000;
  return kids(txBody, "p").map((p) => {
    const pPr = kid(p, "pPr");
    const level = num(pPr, "lvl");
    const base = defaults.sizeFor(level);
    const runs: PptxRun[] = [];
    for (const child of Array.from(p.children)) {
      if (child.localName === "br") {
        runs.push({ text: "\n", size: base * scale, bold: false, italic: false, underline: false });
        continue;
      }
      if (child.localName !== "r" && child.localName !== "fld") continue;
      const rPr = kid(child, "rPr");
      runs.push({
        text: kid(child, "t")?.textContent ?? "",
        size: (rPr?.hasAttribute("sz") ? num(rPr, "sz") / 100 : base) * scale,
        bold: rPr?.getAttribute("b") === "1",
        italic: rPr?.getAttribute("i") === "1",
        underline: (rPr?.getAttribute("u") ?? "none") !== "none",
        color: colorOf(kid(rPr, "solidFill"), palette) ?? defaults.color,
      });
    }
    const end = kid(p, "endParaRPr");
    const explicitBullet = Boolean(kid(pPr, "buChar") || kid(pPr, "buAutoNum"));
    return {
      runs,
      align: ALIGN[pPr?.getAttribute("algn") ?? ""],
      level,
      bullet: kid(pPr, "buNone") ? false : explicitBullet || defaults.bullets,
      emptySize: (end?.hasAttribute("sz") ? num(end, "sz") / 100 : base) * scale,
    };
  });
}

export function plainText(paragraphs: PptxParagraph[]): string[] {
  return paragraphs
    .map((p) => p.runs.map((r) => r.text).join("").trim())
    .filter(Boolean);
}

// ------------------------------------------------------------- shapes ----

type Placeholder = { box?: PptxBox; size?: number; anchor?: string };
type Layer = { placeholders: Map<string, Placeholder>; background?: string };

function xfrmBox(xfrm: Element | null): PptxBox | undefined {
  const off = kid(xfrm, "off");
  const ext = kid(xfrm, "ext");
  if (!off || !ext) return undefined;
  return {
    x: num(off, "x") / EMU_PER_PT,
    y: num(off, "y") / EMU_PER_PT,
    w: num(ext, "cx") / EMU_PER_PT,
    h: num(ext, "cy") / EMU_PER_PT,
    rot: num(xfrm, "rot") / 60000,
  };
}

function placeholderOf(sp: Element): Element | null {
  const nv = Array.from(sp.children).find((c) => c.localName.startsWith("nv"));
  return at(nv, "nvPr", "ph");
}

function placeholderKeys(ph: Element): string[] {
  const type = ph.getAttribute("type") ?? "body";
  const keys: string[] = [];
  if (ph.hasAttribute("idx")) keys.push(`idx:${ph.getAttribute("idx")}`);
  keys.push(`type:${type}`);
  if (type === "ctrTitle") keys.push("type:title");
  if (type === "subTitle" || type === "obj") keys.push("type:body");
  return keys;
}

function indexLayer(doc: Document, palette: Palette | null): Layer {
  const placeholders = new Map<string, Placeholder>();
  for (const sp of all(doc, "sp")) {
    const ph = placeholderOf(sp);
    if (!ph) continue;
    const lvl1 = at(sp, "txBody", "lstStyle", "lvl1pPr", "defRPr");
    const entry: Placeholder = {
      box: xfrmBox(at(sp, "spPr", "xfrm")),
      size: lvl1?.hasAttribute("sz") ? num(lvl1, "sz") / 100 : undefined,
      anchor: at(sp, "txBody", "bodyPr")?.getAttribute("anchor") ?? undefined,
    };
    for (const key of placeholderKeys(ph)) if (!placeholders.has(key)) placeholders.set(key, entry);
  }
  return { placeholders, background: palette ? backgroundOf(doc, palette) : undefined };
}

function backgroundOf(doc: Document, palette: Palette): string | undefined {
  const bg = all(doc, "bg")[0];
  if (!bg) return undefined;
  const fromPr = fillOf(kid(bg, "bgPr"), palette);
  return fromPr ?? colorOf(kid(bg, "bgRef"), palette);
}

type Context = {
  palette: Palette;
  rels: Rels;
  layers: Layer[];
  sizes: { title: number; body: number[]; other: number };
  textColor?: string;
  bodyBullets: boolean;
};

function inherited(ph: Element | null, ctx: Context): Placeholder {
  const merged: Placeholder = {};
  if (!ph) return merged;
  for (const layer of ctx.layers) {
    for (const key of placeholderKeys(ph)) {
      const found = layer.placeholders.get(key);
      if (!found) continue;
      merged.box ??= found.box;
      merged.size ??= found.size;
      merged.anchor ??= found.anchor;
      break;
    }
  }
  return merged;
}

type Transform = (box: PptxBox) => PptxBox;
const identity: Transform = (box) => box;

function parseShape(el: Element, ctx: Context, map: Transform, out: PptxShape[]) {
  const name = el.localName;
  if (name === "grpSp") {
    const xfrm = at(el, "grpSpPr", "xfrm");
    const box = xfrmBox(xfrm);
    const chOff = kid(xfrm, "chOff");
    const chExt = kid(xfrm, "chExt");
    let inner = map;
    if (box && chOff && chExt && num(chExt, "cx") && num(chExt, "cy")) {
      const cx = num(chOff, "x") / EMU_PER_PT;
      const cy = num(chOff, "y") / EMU_PER_PT;
      const sx = box.w / (num(chExt, "cx") / EMU_PER_PT);
      const sy = box.h / (num(chExt, "cy") / EMU_PER_PT);
      inner = (b) =>
        map({ x: box.x + (b.x - cx) * sx, y: box.y + (b.y - cy) * sy, w: b.w * sx, h: b.h * sy, rot: b.rot });
    }
    for (const child of Array.from(el.children)) parseShape(child, ctx, inner, out);
    return;
  }
  if (name === "pic") {
    const box = xfrmBox(at(el, "spPr", "xfrm"));
    const embed = relId(at(el, "blipFill", "blip"), "embed");
    const rel = embed ? ctx.rels.get(embed) : undefined;
    if (box) out.push({ kind: "image", box: map(box), target: rel && !rel.external ? rel.target : null });
    return;
  }
  if (name === "graphicFrame") {
    const box = xfrmBox(kid(el, "xfrm"));
    if (!box) return;
    const data = at(el, "graphic", "graphicData");
    const table = kid(data, "tbl");
    if (table) {
      const rows = kids(table, "tr").map((tr) =>
        kids(tr, "tc").map((tc) => all(tc, "t").map((t) => t.textContent ?? "").join(" ").trim()),
      );
      out.push({ kind: "table", box: map(box), rows });
      return;
    }
    const uri = data?.getAttribute("uri") ?? "";
    const label = uri.includes("chart") ? "Graphique" : uri.includes("diagram") ? "SmartArt" : "Objet incorporé";
    out.push({ kind: "other", box: map(box), label });
    return;
  }
  if (name !== "sp") return;

  const ph = placeholderOf(el);
  const base = inherited(ph, ctx);
  const own = xfrmBox(at(el, "spPr", "xfrm"));
  const box = own ?? base.box;
  if (!box) return;
  const type = ph ? ph.getAttribute("type") ?? "body" : null;
  const isTitle = type === "title" || type === "ctrTitle";
  const bodyLike = Boolean(ph) && !isTitle && !["dt", "ftr", "sldNum", "subTitle"].includes(type ?? "");
  const txBody = kid(el, "txBody");
  const paragraphs = parseParagraphs(txBody, ctx.palette, {
    sizeFor: (level) =>
      base.size ?? (isTitle ? ctx.sizes.title : ph ? ctx.sizes.body[level] ?? ctx.sizes.body[0] : ctx.sizes.other),
    color: ctx.textColor,
    bullets: bodyLike && ctx.bodyBullets,
  });
  const spPr = kid(el, "spPr");
  const isTextBox = at(el, "nvSpPr", "cNvSpPr")?.getAttribute("txBox") === "1";
  let fill = kid(spPr, "noFill") ? undefined : fillOf(spPr, ctx.palette);
  if (!fill && !kid(spPr, "noFill") && !ph && !isTextBox) {
    fill = colorOf(at(el, "style", "fillRef"), ctx.palette);
  }
  const line = kid(spPr, "ln");
  const border = line && !kid(line, "noFill") ? fillOf(line, ctx.palette) : undefined;
  const geometry = at(spPr, "prstGeom")?.getAttribute("prst");
  const hasText = paragraphs.some((p) => p.runs.some((r) => r.text.trim()));
  if (!hasText && !fill && !border) return;
  out.push({
    kind: "text",
    box: map(box),
    paragraphs,
    fill,
    border,
    radius: geometry === "ellipse" ? "50%" : geometry === "roundRect" ? "8%" : undefined,
    anchor: at(txBody, "bodyPr")?.getAttribute("anchor") ?? base.anchor,
  });
}

// --------------------------------------------------------------- deck ----

function styleSize(style: Element | null, level: number, fallback: number): number {
  const def = at(style, `lvl${level + 1}pPr`, "defRPr");
  return def?.hasAttribute("sz") ? num(def, "sz") / 100 : fallback;
}

type MasterInfo = { layer: Layer; palette: Palette; sizes: Context["sizes"]; textColor?: string; bodyBullets: boolean };

export async function parsePptx(file: string, names: Set<string>): Promise<PptxDeck> {
  const presPath = "ppt/presentation.xml";
  if (!names.has(presPath)) throw new Error("presentation.xml introuvable : ce n’est pas un PowerPoint valide.");
  const pres = parseXml(await readZipText(file, presPath));
  const presRels = await readRels(file, names, presPath);
  const size = all(pres, "sldSz")[0];
  const width = num(size ?? null, "cx", 9144000) / EMU_PER_PT;
  const height = num(size ?? null, "cy", 6858000) / EMU_PER_PT;

  const masters = new Map<string, Promise<MasterInfo>>();
  const loadMaster = (path: string) => {
    if (!masters.has(path)) {
      masters.set(
        path,
        (async () => {
          const doc = parseXml(await readZipText(file, path));
          const rels = await readRels(file, names, path);
          const themePath = relOfType(rels, "/theme");
          const theme = themePath && names.has(themePath) ? parseXml(await readZipText(file, themePath)) : null;
          const clrMap = all(doc, "clrMap")[0];
          const map: Record<string, string> = {};
          for (const attr of Array.from(clrMap?.attributes ?? [])) map[attr.localName] = attr.value;
          const palette: Palette = { theme: parseTheme(theme), map };
          const txStyles = all(doc, "txStyles")[0] ?? null;
          const body = kid(txStyles, "bodyStyle");
          return {
            layer: indexLayer(doc, palette),
            palette,
            sizes: {
              title: styleSize(kid(txStyles, "titleStyle"), 0, 44),
              body: Array.from({ length: 9 }, (_, level) => styleSize(body, level, level ? 20 : 28)),
              other: styleSize(kid(txStyles, "otherStyle"), 0, 18),
            },
            textColor: colorOf(at(body, "lvl1pPr", "defRPr", "solidFill"), palette),
            bodyBullets: Boolean(at(body, "lvl1pPr", "buChar") || at(body, "lvl1pPr", "buAutoNum")),
          };
        })(),
      );
    }
    return masters.get(path)!;
  };
  const layouts = new Map<string, Promise<{ layer: Layer; master: MasterInfo | null }>>();
  const loadLayout = (path: string) => {
    if (!layouts.has(path)) {
      layouts.set(
        path,
        (async () => {
          const doc = parseXml(await readZipText(file, path));
          const masterPath = relOfType(await readRels(file, names, path), "/slideMaster");
          const master = masterPath && names.has(masterPath) ? await loadMaster(masterPath) : null;
          return { layer: indexLayer(doc, master?.palette ?? null), master };
        })(),
      );
    }
    return layouts.get(path)!;
  };

  const slidePaths = all(pres, "sldId")
    .map((el) => presRels.get(relId(el, "id") ?? "")?.target)
    .filter((path): path is string => Boolean(path && names.has(path)));

  const slides: PptxSlide[] = [];
  for (const [index, path] of slidePaths.entries()) {
    const doc = parseXml(await readZipText(file, path));
    const rels = await readRels(file, names, path);
    const layoutPath = relOfType(rels, "/slideLayout");
    const layout = layoutPath && names.has(layoutPath) ? await loadLayout(layoutPath) : null;
    const master = layout?.master ?? null;
    const palette = master?.palette ?? { theme: {}, map: {} };
    const ctx: Context = {
      palette,
      rels,
      layers: [layout?.layer, master?.layer].filter((layer): layer is Layer => Boolean(layer)),
      sizes: master?.sizes ?? { title: 44, body: [28, 24, 20, 20, 20, 20, 20, 20, 20], other: 18 },
      textColor: master?.textColor,
      bodyBullets: master?.bodyBullets ?? true,
    };
    const shapes: PptxShape[] = [];
    const tree = at(all(doc, "cSld")[0] ?? null, "spTree");
    for (const child of Array.from(tree?.children ?? [])) parseShape(child, ctx, identity, shapes);
    let title = "";
    const lines: string[] = [];
    const textOnly: TextDefaults = { sizeFor: () => 18, bullets: false };
    for (const child of all(tree, "sp")) {
      const text = plainText(parseParagraphs(kid(child, "txBody"), palette, textOnly));
      const type = placeholderOf(child)?.getAttribute("type");
      if (!title && (type === "title" || type === "ctrTitle")) title = text.join(" ");
      else lines.push(...text);
    }
    for (const shape of shapes) if (shape.kind === "table") lines.push(...shape.rows.map((r) => r.join(" | ")));
    // Decks generated by other tools often skip title placeholders.
    if (!title && lines.length) title = lines.shift() ?? "";
    slides.push({
      number: index + 1,
      shapes,
      background: backgroundOf(doc, palette) ?? layout?.layer.background ?? master?.layer.background ?? "#ffffff",
      title,
      lines,
      hidden: doc.documentElement.getAttribute("show") === "0",
    });
  }
  return { width, height, slides };
}