// Copie d'une sélection qui traverse un bloc de code du chat.
// Le navigateur (selon le moteur) ne copie que la partie VISIBLE des lignes longues d'un
// bloc à défilement horizontal, et une sélection lâchée au bord droit coupe la ligne.
// Ici, quand la sélection entre ou sort d'un bloc `.bloc-copie > pre`, ses bornes situées
// dans le bloc sont étendues à la ligne entière, et le texte est reconstruit depuis le DOM
// (textContent, indépendant du rendu) : lignes complètes, retours à la ligne gardés,
// texte normal autour conservé.

const SEL_PRE = ".bloc-copie > pre";

function preDe(node: Node | null): HTMLPreElement | null {
  const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
  return (el?.closest(SEL_PRE) as HTMLPreElement | null) ?? null;
}

function textes(pre: Node): Text[] {
  const doc = pre.ownerDocument!;
  const w = doc.createTreeWalker(pre, 4 /* SHOW_TEXT */);
  const out: Text[] = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
  return out;
}

/** Position (nœud, décalage) → décalage dans le texte du bloc. */
function versDecalage(pre: Node, node: Node, off: number): number {
  if (node.nodeType !== 3) {
    // Point entre deux enfants : on compte le texte des enfants qui précèdent.
    const r = pre.ownerDocument!.createRange();
    r.setStart(pre, 0);
    r.setEnd(node, off);
    return r.toString().length;
  }
  let total = 0;
  for (const t of textes(pre)) {
    if (t === node) return total + off;
    total += t.data.length;
  }
  return total;
}

/** Décalage dans le texte du bloc → position (nœud texte, décalage). */
function versPoint(pre: Node, decalage: number): [Node, number] {
  let reste = decalage;
  const ts = textes(pre);
  for (const t of ts) {
    if (reste <= t.data.length) return [t, reste];
    reste -= t.data.length;
  }
  return [pre, pre.childNodes.length];
}

/** Étend les bornes de `range` situées dans un bloc de code jusqu'aux lignes entières,
 *  si la sélection traverse un bord du bloc. Rend true si un bloc est concerné. */
export function etendreAuxLignes(range: Range): boolean {
  const preDebut = preDe(range.startContainer);
  const preFin = preDe(range.endContainer);
  let touche = false;
  if (preDebut && preDebut !== preFin) {
    const texte = preDebut.textContent ?? "";
    const d = versDecalage(preDebut, range.startContainer, range.startOffset);
    const [n, o] = versPoint(preDebut, texte.lastIndexOf("\n", d - 1) + 1);
    range.setStart(n, o);
    touche = true;
  }
  if (preFin && preFin !== preDebut) {
    const texte = preFin.textContent ?? "";
    const d = versDecalage(preFin, range.endContainer, range.endOffset);
    // Point au tout début d'une ligne : la ligne n'est pas sélectionnée.
    if (d > 0 && texte[d - 1] !== "\n") {
      const fin = texte.indexOf("\n", d);
      const [n, o] = versPoint(preFin, fin < 0 ? texte.length : fin);
      range.setEnd(n, o);
    }
    touche = true;
  }
  if (!touche) {
    // Bloc entièrement à l'intérieur de la sélection ?
    const racine = range.commonAncestorContainer;
    const els = racine.nodeType === 1 ? (racine as Element).querySelectorAll(SEL_PRE) : null;
    touche = !!els && [...els].some((p) => range.intersectsNode(p));
  }
  return touche;
}

const BLOCS = new Set(["P", "DIV", "PRE", "LI", "UL", "OL", "TABLE", "THEAD", "TBODY", "TR", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "HR"]);

/** Texte brut d'un fragment : texte normal (espaces repliés), blocs séparés par des
 *  retours à la ligne, cellules par des tabulations, blocs de code tels quels. */
export function texteFragment(racine: Node): string {
  let out = "";
  const saut = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const visite = (n: Node, dansPre: boolean) => {
    if (n.nodeType === 3) {
      const t = (n as Text).data;
      if (dansPre) out += t;
      else {
        const plie = t.replace(/\s+/g, " ");
        out += out.endsWith("\n") || out.endsWith("\t") || out === "" || out.endsWith(" ") ? plie.replace(/^ /, "") : plie;
      }
      return;
    }
    if (n.nodeType !== 1 && n.nodeType !== 11) return;
    const el = n as Element;
    const tag = n.nodeType === 1 ? el.tagName : "";
    if (tag === "BUTTON" || tag === "SCRIPT" || tag === "STYLE") return; // ex. bouton « Copier » du bloc
    if (tag === "BR") {
      out += "\n";
      return;
    }
    const bloc = BLOCS.has(tag);
    if (bloc) saut();
    const enfants = [...n.childNodes];
    enfants.forEach((c, i) => {
      if ((tag === "TR") && i > 0 && c.nodeType === 1) out += "\t";
      visite(c, dansPre || tag === "PRE");
    });
    if (bloc) {
      if (tag === "PRE" && out.endsWith("\n")) return;
      saut();
    }
  };
  visite(racine, false);
  return out.replace(/[ \t]+\n/g, (m) => (m.includes("\t") ? m : "\n")).replace(/\n+$/, "\n").replace(/^\n+/, "");
}

/** Texte à copier pour une sélection, ou null si elle ne touche aucun bloc de code. */
export function texteCopie(range: Range): { texte: string; html: string } | null {
  const r = range.cloneRange();
  if (!etendreAuxLignes(r)) return null;
  const frag = r.cloneContents();
  const doc = r.startContainer.ownerDocument!;
  const boite = doc.createElement("div");
  boite.appendChild(frag.cloneNode(true));
  boite.querySelectorAll("button").forEach((b) => b.remove());
  const texte = texteFragment(frag).replace(/\n$/, "");
  return { texte, html: boite.innerHTML };
}

let installe = false;
/** Gestionnaire « copy » unique pour le document (appelé par chaque bloc de code). */
export function installerCopieSelection(doc: Document = document): void {
  if (installe) return;
  installe = true;
  doc.addEventListener("copy", (event: ClipboardEvent) => {
    if (event.defaultPrevented || !event.clipboardData) return;
    const cible = doc.activeElement;
    if (cible && cible.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const res = texteCopie(sel.getRangeAt(0));
    if (!res) return;
    event.clipboardData.setData("text/plain", res.texte);
    event.clipboardData.setData("text/html", res.html);
    event.preventDefault();
  });
}
