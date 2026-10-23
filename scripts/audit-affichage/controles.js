// Controles automatiques de l'affichage, executes DANS la page (apres rendu et polices).
// window.__auditerAffichage(options) -> { defauts: [...], exceptes: [...], mesures }
// Regles :
//   texte-coupe          texte rogne par un conteneur qui ne defile pas (sans « … » voulu)
//   texte-deborde        texte qui sort de son bouton / onglet (sans etre rogne)
//   chevauchement        deux elements interactifs visibles qui se recouvrent
//   hors-ecran           element interactif en partie hors de la fenetre
//   hors-conteneur       element interactif rogne (ou pousse dehors) par son conteneur
//   libelle-2-lignes     libelle court de bouton / onglet / titre passe sur deux lignes
//   cible-petite         cible cliquable de moins de 20 px
//   defilement-horizontal barre de defilement horizontale inattendue
//   volet-non-rempli     volet de la barre laterale qui laisse une zone vide sous lui
//   chargement-bloque    « Ouverture de la conversation… » (ou « Chargement… ») encore affiche
(() => {
  const TOL = 1.01;
  const SEL_INTERACTIF = [
    "button", "a[href]", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=tab]", "[role=menuitem]", "[role=option]", "[role=checkbox]", "[role=switch]",
  ].join(",");
  const SEL_CONTROLE = "button, [role=button], [role=tab], [role=menuitem], summary, select, label, a[href]";
  const SEL_TITRE = "h1, h2, h3, h4, h5, h6, [class*=title], [class*=titre], [class*=head], [class*=label], [class*=tab], [class*=onglet], [class*=badge], [class*=chip], [class*=pill]";
  const SEL_IGNORE = ".xterm, .monaco-editor, iframe, canvas, .banc-audit-calque";

  const css = (el) => getComputedStyle(el);
  const visible = (el) =>
    typeof el.checkVisibility === "function"
      ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })
      : el.getClientRects().length > 0;

  function decrire(el) {
    const morceaux = [];
    let cur = el;
    for (let i = 0; cur && i < 4 && cur !== document.body && cur !== document.documentElement; i += 1) {
      let s = cur.tagName.toLowerCase();
      const cls = [...cur.classList].filter((c) => !/\d{3,}|^(is|has)-/.test(c)).slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      morceaux.unshift(s);
      cur = cur.parentElement;
    }
    return morceaux.join(" > ");
  }
  function libelle(el) {
    const t = (el.getAttribute?.("aria-label") || el.innerText || el.value || el.getAttribute?.("title") || "").trim();
    return t.replace(/\s+/g, " ").slice(0, 70);
  }
  const R = (l, t, r, b) => ({ l, t, r, b });
  const depuis = (d) => R(d.left, d.top, d.right, d.bottom);
  const inter = (a, b) => R(Math.max(a.l, b.l), Math.max(a.t, b.t), Math.min(a.r, b.r), Math.min(a.b, b.b));
  const aire = (a) => Math.max(0, a.r - a.l) * Math.max(0, a.b - a.t);
  const vide = (a) => a.r - a.l <= 0.5 || a.b - a.t <= 0.5;
  const arrondi = (a) => ({ x: Math.round(a.l), y: Math.round(a.t), l: Math.round(a.r - a.l), h: Math.round(a.b - a.t) });

  // Boite de rognage (padding box, sans barre de defilement) d'un element.
  function boiteRognage(el) {
    const r = el.getBoundingClientRect();
    const s = css(el);
    const gauche = r.left + parseFloat(s.borderLeftWidth || "0");
    const haut = r.top + parseFloat(s.borderTopWidth || "0");
    return R(gauche, haut, gauche + el.clientWidth, haut + el.clientHeight);
  }

  // Chaine des ancetres qui rognent `el`, en suivant les blocs conteneurs
  // (un element en position absolue ou fixe echappe aux ancetres non positionnes).
  function rogneurs(el, inclureSoi) {
    const out = [];
    const ajouter = (a, s) => {
      const peint = /paint|strict|content/.test(s.contain || "");
      const cx = s.overflowX !== "visible" || peint;
      const cy = s.overflowY !== "visible" || peint;
      if (!cx && !cy) return;
      out.push({
        el: a, s, cx, cy,
        sx: s.overflowX === "auto" || s.overflowX === "scroll",
        sy: s.overflowY === "auto" || s.overflowY === "scroll",
      });
    };
    let s0 = css(el);
    if (inclureSoi) ajouter(el, s0);
    let mode = s0.position === "absolute" ? "abs" : s0.position === "fixed" ? "fixe" : "flux";
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = css(a);
      const blocFixe = s.transform !== "none" || s.filter !== "none" || s.perspective !== "none" || /paint|layout|strict|content/.test(s.contain || "") || (s.backdropFilter && s.backdropFilter !== "none");
      const blocAbs = s.position !== "static" || blocFixe;
      const compte = mode === "flux" || (mode === "abs" && blocAbs) || (mode === "fixe" && blocFixe);
      if (!compte) continue;
      ajouter(a, s);
      mode = s.position === "absolute" ? "abs" : s.position === "fixed" ? "fixe" : "flux";
    }
    return { chaine: out, fixe: mode === "fixe" };
  }

  const ecran = () => R(0, 0, document.documentElement.clientWidth, document.documentElement.clientHeight);

  // Une partie de `r` est-elle avant l'origine de la zone qui defile `c` (au-dessus
  // ou a gauche, la ou le defilement ne mene jamais) ?
  function avantOrigine(c, r) {
    if (!c.sx && !c.sy) return false;
    if (/reverse/.test(c.s.flexDirection) || c.s.direction === "rtl") return false;
    const b = boiteRognage(c.el);
    return (c.sy && r.t - b.t + c.el.scrollTop < -1.5) || (c.sx && r.l - b.l + c.el.scrollLeft < -1.5);
  }

  function rectVisible(el, rect) {
    let v = rect ?? depuis(el.getBoundingClientRect());
    for (const c of rogneurs(el, false).chaine) {
      const b = boiteRognage(c.el);
      v = R(c.cx ? Math.max(v.l, b.l) : v.l, c.cy ? Math.max(v.t, b.t) : v.t, c.cx ? Math.min(v.r, b.r) : v.r, c.cy ? Math.min(v.b, b.b) : v.b);
      if (vide(v)) return v;
    }
    return inter(v, ecran());
  }

  function exceptionPour(regle, el, exceptions, situation) {
    for (const ex of exceptions) {
      if (ex.regle !== regle && ex.regle !== "*") continue;
      if (ex.situation && !new RegExp(ex.situation).test(situation)) continue;
      try {
        if (el && el.closest && el.closest(ex.selecteur)) return ex;
      } catch {
        /* selecteur invalide : ignore */
      }
    }
    return null;
  }

  function touche(el, x, y) {
    const cible = document.elementFromPoint(x, y);
    return !!cible && (cible === el || el.contains(cible));
  }
  function visibleQuelquePart(el, v) {
    const pas = [0.2, 0.5, 0.8];
    for (const fx of pas) for (const fy of pas) {
      if (touche(el, v.l + (v.r - v.l) * fx, v.t + (v.b - v.t) * fy)) return true;
    }
    return false;
  }

  function textesParParent(racine) {
    const parents = new Map();
    const marche = document.createTreeWalker(racine, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n = marche.nextNode(); n; n = marche.nextNode()) {
      const p = n.parentElement;
      if (!p) continue;
      if (!parents.has(p)) parents.set(p, []);
      parents.get(p).push(n);
    }
    return parents;
  }

  function mesureTexte(noeuds) {
    const range = document.createRange();
    let u = null;
    let lignesMax = 0;
    for (const n of noeuds) {
      range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
      const hauts = [];
      for (const r of rects) {
        if (!hauts.some((h) => Math.abs(h - r.top) < r.height * 0.5)) hauts.push(r.top);
        u = u ? R(Math.min(u.l, r.left), Math.min(u.t, r.top), Math.max(u.r, r.right), Math.max(u.b, r.bottom)) : depuis(r);
      }
      lignesMax = Math.max(lignesMax, hauts.length);
    }
    return { rect: u, lignes: lignesMax };
  }

  window.__auditerAffichage = function auditer(options = {}) {
    const exceptions = options.exceptions ?? [];
    const situation = options.situation ?? "";
    const defauts = [];
    const exceptes = [];
    const vus = new Set();
    const noter = (regle, el, detail, rect, gravite) => {
      const cle = regle + "|" + decrire(el) + "|" + libelle(el).slice(0, 30);
      if (vus.has(cle)) return;
      vus.add(cle);
      const d = { regle, element: decrire(el), libelle: libelle(el), detail, rect: arrondi(rect ?? depuis(el.getBoundingClientRect())), gravite, cle };
      const ex = exceptionPour(regle, el, exceptions, situation);
      if (ex) exceptes.push({ ...d, raison: ex.raison });
      else defauts.push(d);
    };
    const ignore = (el) => !!el.closest(SEL_IGNORE);
    const vp = ecran();

    // 1. Textes : coupes, debordants, sur deux lignes.
    for (const [T, noeuds] of textesParParent(document.body)) {
      if (ignore(T) || !visible(T)) continue;
      const { rect: tr, lignes } = mesureTexte(noeuds);
      if (!tr) continue;
      const { chaine } = rogneurs(T, true);
      let entierementCache = false;
      let horsH = false;
      let horsV = false;
      let illisible = null;
      for (const c of chaine) {
        const b = boiteRognage(c.el);
        // « … » qui ne laisse presque rien lire (moins de 2,5 caracteres environ).
        if (c.cx && !illisible && c.s.textOverflow === "ellipsis" && (c.el === T || c.el.contains(T)) && tr.r - tr.l > b.r - b.l + 1) {
          const fs = parseFloat(css(T).fontSize) || 12;
          if (b.r - b.l < Math.min(tr.r - tr.l, 2.5 * fs) - 1) illisible = { largeur: Math.max(0, b.r - b.l) };
          if (b.r - b.l < 2) continue;
        }
        if (b.r - b.l < 2 || b.b - b.t < 2) { entierementCache = true; break; }
        const depD = tr.r - b.r, depG = b.l - tr.l, depB = tr.b - b.b, depH = b.t - tr.t;
        const coupeH = c.cx && (depD > TOL || depG > TOL);
        const coupeV = c.cy && (depB > TOL + 1 || depH > TOL + 1);
        const toutDehorsH = tr.l >= b.r - 0.5 || tr.r <= b.l + 0.5;
        const toutDehorsV = tr.t >= b.b - 0.5 || tr.b <= b.t + 0.5;
        // Avant l'origine d'une zone qui defile (au-dessus ou a gauche) : on n'y arrive jamais.
        if (avantOrigine(c, tr)) {
          noter("hors-conteneur", T, `au-dessus ou à gauche de la zone qui défile ${decrire(c.el)} : inaccessible`, tr, 3);
          entierementCache = true;
          break;
        }
        if (toutDehorsV && c.cy) { entierementCache = true; break; }
        if (coupeH && !horsH) {
          horsH = true;
          if (c.sx) { /* le conteneur defile : rien de cache pour de bon */ }
          else if (toutDehorsH) noter("hors-conteneur", T, `texte entierement pousse hors de ${decrire(c.el)}`, tr, 3);
          else if (css(c.el).textOverflow === "ellipsis" && (c.el === T || c.el.contains(T))) { /* « … » voulu */ }
          else noter("texte-coupe", T, `rogne de ${Math.round(Math.max(depD, depG))} px par ${decrire(c.el)}`, tr, 3);
        }
        if (coupeV && !horsV) {
          horsV = true;
          const s = css(c.el);
          if (c.sy || toutDehorsV) { /* defilement vertical normal */ }
          else if (s.webkitLineClamp && s.webkitLineClamp !== "none") { /* coupe voulue (line-clamp) */ }
          else if (s.textOverflow === "ellipsis" && lignes <= 1) { /* « … » voulu */ }
          else noter("texte-coupe", T, `rogne en hauteur de ${Math.round(Math.max(depB, depH))} px par ${decrire(c.el)}`, tr, 3);
        }
      }
      if (entierementCache) continue;
      const v = inter(tr, vp);
      if (vide(v)) continue;
      if (illisible) noter("texte-illisible", T, `« … » : ${Math.round(illisible.largeur)} px visibles sur ${Math.round(tr.r - tr.l)} px`, tr, 3);
      const controle = T.closest(SEL_CONTROLE);
      if (controle && !ignore(controle)) {
        const cr = depuis(controle.getBoundingClientRect());
        const s = css(controle);
        // Partie du texte reellement peinte : rognee par les conteneurs situes DANS le controle.
        let tv = tr;
        for (const c of chaine) {
          if (c.el !== controle && !controle.contains(c.el)) break;
          if (c.el === controle) break;
          const b = boiteRognage(c.el);
          tv = R(c.cx ? Math.max(tv.l, b.l) : tv.l, c.cy ? Math.max(tv.t, b.t) : tv.t, c.cx ? Math.min(tv.r, b.r) : tv.r, c.cy ? Math.min(tv.b, b.b) : tv.b);
        }
        if (s.overflowX === "visible" && !vide(tv) && (tv.r - cr.r > TOL + 1 || cr.l - tv.l > TOL + 1)) {
          noter("texte-deborde", controle, `le texte depasse de ${Math.round(Math.max(tv.r - cr.r, cr.l - tv.l))} px`, tv, 3);
        }
        const court = (controle.innerText || "").trim().length <= 60;
        if (lignes >= 2 && court && css(T).whiteSpace !== "pre") {
          noter("libelle-2-lignes", controle, `${lignes} lignes`, tr, 2);
        }
      } else if (lignes >= 2 && T.closest(SEL_TITRE) && (T.innerText || "").trim().length <= 60 && !T.closest(".md")) {
        noter("libelle-2-lignes", T, `${lignes} lignes`, tr, 2);
      }
    }

    // 2. Elements interactifs : chevauchements, hors ecran / conteneur, petites cibles.
    const inter_ = [];
    for (const el of document.querySelectorAll(SEL_INTERACTIF)) {
      if (ignore(el) || !visible(el)) continue;
      if (el.closest("[inert], [aria-hidden=true]")) continue;
      const r = depuis(el.getBoundingClientRect());
      if (r.r - r.l < 1 || r.b - r.t < 1) continue;
      const v = rectVisible(el, r);
      if (vide(v)) {
        // Entierement cache : pousse hors d'une barre visible (meme hauteur) ?
        const { chaine } = rogneurs(el, false);
        for (const c of chaine) {
          const b = boiteRognage(c.el);
          if (avantOrigine(c, r)) {
            noter("hors-conteneur", el, `au-dessus ou à gauche de la zone qui défile ${decrire(c.el)} : inaccessible`, r, 3);
            break;
          }
          if (c.sx || c.sy || b.r - b.l < 2 || b.b - b.t < 2) break;
          const memeRangee = r.t < b.b && r.b > b.t;
          if (memeRangee && (r.l >= b.r - 0.5 || r.r <= b.l + 0.5) && c.cx) {
            noter("hors-conteneur", el, `pousse hors de ${decrire(c.el)}`, r, 3);
          }
          break;
        }
        continue;
      }
      inter_.push({ el, r, v });
      // Rogne en partie ?
      const coupeL = r.r - r.l - (v.r - v.l) > 1.5;
      const coupeH = r.b - r.t - (v.b - v.t) > 1.5;
      if (coupeL || coupeH) {
        const horsVp = r.r > vp.r + 1 || r.l < vp.l - 1 || r.b > vp.b + 1 || r.t < vp.t - 1;
        const { chaine } = rogneurs(el, false);
        let parDefilement = false;
        let rogneur = null;
        for (const c of chaine) {
          const b = boiteRognage(c.el);
          const cH = c.cx && (r.r > b.r + 1 || r.l < b.l - 1);
          const cV = c.cy && (r.b > b.b + 1 || r.t < b.t - 1);
          if (!cH && !cV) continue;
          if ((cH && c.sx) || (cV && c.sy)) parDefilement = true;
          rogneur = c;
          break;
        }
        if (!parDefilement) {
          if (rogneur) noter("hors-conteneur", el, `rogne par ${decrire(rogneur.el)}`, r, 3);
          else if (horsVp) noter("hors-ecran", el, "en partie hors de la fenetre", r, 3);
        } else if (rogneur && avantOrigine(rogneur, r)) {
          noter("hors-conteneur", el, `au-dessus ou à gauche de la zone qui défile ${decrire(rogneur.el)} : inaccessible`, r, 3);
        }
      }
      // Petite cible (moins de 20 px), en tenant compte d'une zone de clic elargie.
      // (Un element en partie cache par un conteneur qui defile se mesure une fois amene dans la vue.)
      const l = r.r - r.l, h = r.b - r.t;
      const enPartieDefile = (coupeL || coupeH) && rogneurs(el, false).chaine.some((c) => c.sx || c.sy);
      if ((l < 19.5 || h < 19.5) && !enPartieDefile) {
        const lien = el.tagName === "A" && el.closest("p, li, td, .md, .msg__body");
        const caseDansLabel = el.matches("input[type=checkbox], input[type=radio]") && (() => {
          const lab = el.closest("label");
          if (!lab) return false;
          const lr = lab.getBoundingClientRect();
          return lr.width >= 19.5 && lr.height >= 19.5;
        })();
        if (!lien && !caseDansLabel) {
          const cx = (r.l + r.r) / 2, cy = (r.t + r.b) / 2;
          const pts = [];
          if (l < 19.5) pts.push([cx - 9.5, cy], [cx + 9.5, cy]);
          if (h < 19.5) pts.push([cx, cy - 9.5], [cx, cy + 9.5]);
          const elargie = pts.every(([x, y]) => touche(el, x, y));
          if (!elargie) noter("cible-petite", el, `${Math.round(l)}×${Math.round(h)} px`, r, 1);
        }
      }
    }
    // Chevauchements (paires sans lien de parente, toutes deux visibles).
    inter_.sort((a, b) => a.v.l - b.v.l);
    const visQ = new Map();
    const estVis = (o) => {
      if (!visQ.has(o.el)) visQ.set(o.el, visibleQuelquePart(o.el, o.v));
      return visQ.get(o.el);
    };
    for (let i = 0; i < inter_.length; i += 1) {
      const a = inter_[i];
      for (let j = i + 1; j < inter_.length; j += 1) {
        const b = inter_[j];
        if (b.v.l >= a.v.r) break;
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const x = inter(a.v, b.v);
        if (x.r - x.l <= 2 || x.b - x.t <= 2) continue;
        if (!estVis(a) || !estVis(b)) continue;
        const d = `${decrire(a.el)} « ${libelle(a.el).slice(0, 30)} » / ${decrire(b.el)} « ${libelle(b.el).slice(0, 30)} » (${Math.round(x.r - x.l)}×${Math.round(x.b - x.t)} px)`;
        const ex = exceptionPour("chevauchement", a.el, exceptions, situation) || exceptionPour("chevauchement", b.el, exceptions, situation);
        const cle = "chevauchement|" + decrire(a.el) + "|" + decrire(b.el);
        if (vus.has(cle)) continue;
        vus.add(cle);
        const def = { regle: "chevauchement", element: decrire(a.el), libelle: libelle(a.el), autre: decrire(b.el), detail: d, rect: arrondi(x), gravite: 3, cle };
        if (ex) exceptes.push({ ...def, raison: ex.raison });
        else defauts.push(def);
      }
    }

    // 3. Defilement horizontal inattendu.
    const se = document.scrollingElement;
    if (se && se.scrollWidth > se.clientWidth + 1) {
      noter("defilement-horizontal", document.body, `page : ${se.scrollWidth} > ${se.clientWidth} px`, vp, 2);
    }
    for (const el of document.querySelectorAll("body *")) {
      if (el.scrollWidth <= el.clientWidth + 1 || el.clientWidth === 0) continue;
      const s = css(el);
      if (!(s.overflowX === "auto" || s.overflowX === "scroll")) continue;
      if (ignore(el) || !visible(el)) continue;
      // Barre masquee (bande d'onglets qui defile a la molette) : pas de barre affichee.
      const barre = el.offsetHeight - el.clientHeight - parseFloat(s.borderTopWidth || "0") - parseFloat(s.borderBottomWidth || "0");
      if (barre < 1) continue;
      const v = rectVisible(el);
      if (vide(v)) continue;
      noter("defilement-horizontal", el, `${el.scrollWidth} > ${el.clientWidth} px`, v, 2);
    }

    // 4. Chargement qui reste affiche.
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length > 2) continue;
      const t = (el.textContent || "").trim();
      if (!/^(Ouverture de la conversation…|Chargement…|Loading…)$/.test(t)) continue;
      if (!visible(el) || vide(rectVisible(el))) continue;
      noter("chargement-bloque", el, t, null, 2);
    }
    // Même règle repérée par sélecteur (libellés traduits) : message d'attente d'une
    // colonne de conversation (« … » final, aucun bouton) encore affiché.
    for (const el of document.querySelectorAll(".onglets-chat__absent")) {
      if (el.querySelector("button") || !/…\s*$/.test(el.textContent || "")) continue;
      if (!visible(el) || vide(rectVisible(el))) continue;
      noter("chargement-bloque", el, (el.textContent || "").trim(), null, 2);
    }
    // 5. Volet de la barre laterale qui ne remplit pas son emplacement (liste coupee
    //    au-dessus d'une grande zone vide : explorateur a topSplit % de topSplit %).
    for (const el of document.querySelectorAll(".sidebar__section > .sidebar__section, .volet-flottant .sidebar__section")) {
      if (ignore(el) || !visible(el)) continue;
      const p = el.parentElement;
      if (!p || p.children.length !== 1) continue;
      const hp = p.clientHeight, he = el.getBoundingClientRect().height;
      if (hp > 0 && he < hp - 4) noter("volet-non-rempli", el, `${Math.round(he)} px sur ${Math.round(hp)} px`, null, 3);
    }
    return { defauts, exceptes, mesures: { largeur: vp.r, hauteur: vp.b, interactifs: inter_.length } };
    // terminal-coupe : la dernière ligne du terminal (invite, barre d'état d'un
    // programme plein écran) doit tenir entière dans la zone visible du volet.
    // (tous les terminaux xterm : terminal local du volet, terminal Git, terminal du service).
    window.__mesureTerminal = [];
    for (const vue of document.querySelectorAll(".xterm")) {
      if (!visible(vue)) continue;
      const derniere = vue.querySelector(".xterm-rows")?.lastElementChild;
      if (!derniere) continue;
      // Bas visible : bas du contenu de l'hôte et de .xterm (marges intérieures exclues :
      // une ligne posée sur la marge est rognée à l'œil), ou plus haut si un ancêtre rogne.
      const hote = vue.parentElement;
      const sh = css(hote);
      const sx = css(vue);
      let basVisible = Math.min(
        hote.getBoundingClientRect().bottom - (parseFloat(sh.borderBottomWidth) || 0) - (parseFloat(sh.paddingBottom) || 0),
        vue.getBoundingClientRect().bottom - (parseFloat(sx.borderBottomWidth) || 0) - (parseFloat(sx.paddingBottom) || 0),
      );
      for (let a = hote.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        if (css(a).overflowY !== "visible") basVisible = Math.min(basVisible, a.getBoundingClientRect().bottom);
      }
      basVisible = Math.min(basVisible, window.innerHeight);
      const rl = derniere.getBoundingClientRect();
      window.__mesureTerminal.push({ lignes: derniere.parentElement.childElementCount, bas: +rl.bottom.toFixed(1), basVisible: +basVisible.toFixed(1) });
      if (rl.height > 0 && rl.bottom > basVisible + 0.5) {
        noter("terminal-coupe", derniere, `dernière ligne : bas ${rl.bottom.toFixed(1)} > bas visible ${basVisible.toFixed(1)}`, depuis(rl), 2);
      }
    }
    return { defauts, exceptes, mesures: { largeur: vp.r, hauteur: vp.b, interactifs: inter_.length, terminal: window.__mesureTerminal ?? null } };
  };

  // Un texte est-il lisible a l'ecran (dans la fenetre, pas cache par un conteneur ni
  // parti hors d'une zone qui defile) ? Sert a la regle texte-disparu du lanceur.
  window.__texteVisible = function texteVisible(texte) {
    const debut = texte.slice(0, 40);
    const marche = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = marche.nextNode(); n; n = marche.nextNode()) {
      const v = n.nodeValue || "";
      const i = v.indexOf(debut);
      if (i < 0) continue;
      const p = n.parentElement;
      if (!p || !visible(p)) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + debut.length);
      const rr = range.getBoundingClientRect();
      if (rr.width < 1 || rr.height < 1) continue;
      if (!vide(rectVisible(p, depuis(rr)))) return true;
    }
    return false;
  };

  // Texte agrandi (+10 % par defaut) : chaque element recoit sa taille calculee x facteur.
  window.__agrandirTexte = function agrandir(facteur = 1.1) {
    const tous = [...document.querySelectorAll("body, body *")];
    const tailles = tous.map((el) => parseFloat(css(el).fontSize) || 0);
    const avant = [];
    tous.forEach((el, i) => {
      if (!(tailles[i] > 0)) return;
      avant.push([el, el.style.getPropertyValue("font-size"), el.style.getPropertyPriority("font-size")]);
      el.style.setProperty("font-size", `${(tailles[i] * facteur).toFixed(2)}px`, "important");
    });
    window.__texteAvant = avant;
    return tous.length;
  };
  // Libellés allongés (+30 % par défaut, 3 caractères au moins) : marge pour la
  // traduction française (≈ 30 % plus longue) et pour des polices plus larges.
  // Seuls les textes courts d'interface (boutons, onglets, titres, étiquettes) sont
  // allongés, jamais le contenu (messages, code, chemins, noms, éditeurs, terminal).
  const SEL_LIBELLE = SEL_CONTROLE + ", " + SEL_TITRE + ", option, th, legend, dt";
  const EXCLU_LIBELLE = [
    ".md", "textarea", "input", "select", "code", "pre", "kbd", ".xterm", ".monaco-editor",
    ".tree-row__name", ".conv-row__title", ".onglets-chat__titre", ".axe-agents__name",
    ".tool-card__title", ".repl-card__code", ".repl-card__summary", ".filechange__path",
    ".tool-read-inline__path", ".titlebar__brand-name", ".titlebar__email", ".banc-audit-calque",
    ".welcome__recent-name", ".sidebar__head-title", ".axe-agents__model",
  ].join(", ");
  window.__allongerLibelles = function allonger(facteur = 1.3) {
    const avant = [];
    const marche = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = marche.nextNode(); n; n = marche.nextNode()) {
      const t = n.nodeValue || "";
      const net = t.trim();
      if (net.length < 3 || net.length > 40) continue;
      if ((net.match(/[A-Za-zÀ-ÿ]/g) || []).length < 3) continue;
      if (/@|\\|\/|https?:|\.[a-z]{2,4}$/i.test(net)) continue;
      if (/^[\w.]+(-[\w.]+){2,}$/.test(net)) continue; // identifiant (modèle, nom d'agent) : une donnée
      const p = n.parentElement;
      if (!p || p.closest(EXCLU_LIBELLE)) continue;
      // Le libellé doit être le texte du contrôle ou du titre lui-même (3 niveaux au plus),
      // pas n'importe quel texte d'un panneau dont un ancêtre lointain s'appelle « …tab… ».
      let hote = null;
      for (let a = p, k = 0; a && k < 3; a = a.parentElement, k += 1) {
        if (a.matches(SEL_LIBELLE)) { hote = a; break; }
      }
      if (!hote) continue;
      const ajout = Math.max(3, Math.ceil(net.length * (facteur - 1)));
      const source = net.replace(/\s+/g, "");
      let suffixe = "";
      while (suffixe.length < ajout) suffixe += source;
      avant.push([n, t]);
      n.nodeValue = t.replace(/(\s*)$/, suffixe.slice(0, ajout) + "$1");
    }
    window.__libellesAvant = avant;
    return avant.length;
  };
  window.__retablirLibelles = function retablirLibelles() {
    for (const [n, t] of window.__libellesAvant ?? []) n.nodeValue = t;
    window.__libellesAvant = [];
  };
  window.__retablirTexte = function retablir() {
    for (const [el, valeur, priorite] of window.__texteAvant ?? []) {
      if (valeur) el.style.setProperty("font-size", valeur, priorite);
      else el.style.removeProperty("font-size");
    }
    window.__texteAvant = [];
  };

  // Calque d'annotation : un cadre rouge numerote par defaut.
  window.__annoterDefauts = function annoter(defauts) {
    const calque = document.createElement("div");
    calque.className = "banc-audit-calque";
    calque.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    defauts.forEach((d, i) => {
      const b = document.createElement("div");
      b.style.cssText = `position:fixed;left:${d.rect.x - 2}px;top:${d.rect.y - 2}px;width:${d.rect.l + 4}px;height:${d.rect.h + 4}px;outline:2px solid #ff2d55;background:rgba(255,45,85,0.12)`;
      const n = document.createElement("span");
      n.textContent = String(i + 1);
      n.style.cssText = "position:absolute;left:-2px;top:-16px;font:bold 11px/14px sans-serif;color:#fff;background:#ff2d55;padding:0 3px;border-radius:3px";
      b.appendChild(n);
      calque.appendChild(b);
    });
    document.body.appendChild(calque);
  };
  window.__retirerAnnotations = function retirer() {
    for (const c of document.querySelectorAll(".banc-audit-calque")) c.remove();
  };
})();
