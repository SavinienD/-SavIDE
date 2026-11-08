// Design Mode du navigateur intégré : survol surligné, un clic choisit
// l'élément, Échap annule. Évalué par l'appli dans la page ; l'appli relit le choix
// (window.__axecodeDesign.prendre()) : la page n'a aucun moyen d'appeler l'appli.
(function () {
  "use strict";
  var CLE = "__axecodeDesign";
  var w = window;
  var d = document;
  if (w[CLE] && w[CLE].actif) return;

  var STYLES = [
    "display", "position", "width", "height", "margin", "padding", "color", "background-color",
    "border", "border-radius", "font-family", "font-size", "font-weight", "line-height",
    "text-align", "gap", "flex-direction", "justify-content", "align-items",
    "grid-template-columns", "box-shadow", "opacity", "z-index"
  ];
  var ATTRIBUTS = ["id", "class", "role", "aria-label", "name", "type", "href", "src", "alt", "placeholder", "title", "data-testid"];

  function echapper(t) {
    if (w.CSS && typeof w.CSS.escape === "function") return w.CSS.escape(t);
    return String(t).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, function (c) { return "\\" + c; });
  }

  function court(t, n) {
    t = String(t == null ? "" : t).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }

  function sansRequete(u) {
    try {
      var x = new URL(u, location.href);
      return x.origin === "null" ? x.protocol + x.pathname : x.origin + x.pathname;
    } catch (e) {
      return "";
    }
  }

  function unique(sel) {
    try {
      return d.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  }

  function selecteur(el) {
    if (el.id && unique("#" + echapper(el.id))) return "#" + echapper(el.id);
    var morceaux = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== d.body && cur !== d.documentElement && morceaux.length < 6) {
      if (cur.id && unique("#" + echapper(cur.id))) {
        morceaux.unshift("#" + echapper(cur.id));
        break;
      }
      var partie = cur.tagName.toLowerCase();
      var classes = Array.prototype.filter.call(cur.classList || [], function (c) {
        return /^[a-zA-Z_-][\w-]*$/.test(c) && c.length < 40;
      }).slice(0, 2);
      if (classes.length) partie += "." + classes.map(echapper).join(".");
      var parent = cur.parentElement;
      if (parent) {
        var memes = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
        if (memes.length > 1) partie += ":nth-of-type(" + (memes.indexOf(cur) + 1) + ")";
      }
      morceaux.unshift(partie);
      cur = parent;
    }
    return morceaux.join(" > ");
  }

  function htmlPropre(el) {
    var copie = el.cloneNode(true);
    var champs = copie.querySelectorAll ? copie.querySelectorAll("input, textarea") : [];
    Array.prototype.forEach.call(champs, function (c) { c.removeAttribute("value"); });
    if (copie.removeAttribute && /^(input|textarea)$/i.test(copie.tagName)) copie.removeAttribute("value");
    var html = copie.outerHTML || "";
    return html.length > 3000 ? html.slice(0, 3000) + "\n… (tronqué)" : html;
  }

  function decrire(el) {
    var r = el.getBoundingClientRect();
    var s = w.getComputedStyle(el);
    var styles = {};
    STYLES.forEach(function (p) {
      var v = s.getPropertyValue(p);
      if (v) styles[p] = court(v, 200);
    });
    var attributs = {};
    ATTRIBUTS.forEach(function (a) {
      var v = el.getAttribute(a);
      if (v == null || v === "") return;
      attributs[a] = a === "href" || a === "src" ? sansRequete(v) : court(v, 200);
    });
    return {
      url: sansRequete(location.href),
      titre: court(d.title, 200),
      balise: el.tagName.toLowerCase(),
      selecteur: selecteur(el),
      html: htmlPropre(el),
      texte: court(el.innerText || el.textContent, 300),
      largeur: Math.round(r.width),
      hauteur: Math.round(r.height),
      x: Math.round(r.left + w.scrollX),
      y: Math.round(r.top + w.scrollY),
      styles: styles,
      attributs: attributs
    };
  }

  var cadre = d.createElement("div");
  var etiquette = d.createElement("div");
  [
    [cadre, "position:fixed;pointer-events:none;z-index:2147483647;display:none;box-sizing:border-box;" +
      "border:2px solid #2563eb;background:rgba(37,99,235,.14);border-radius:2px;"],
    [etiquette, "position:fixed;pointer-events:none;z-index:2147483647;display:none;" +
      "font:12px/1.5 system-ui,sans-serif;color:#fff;background:#1e3a8a;padding:1px 6px;" +
      "border-radius:4px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;"]
  ].forEach(function (p) {
    p[0].style.cssText = p[1];
    p[0].setAttribute("data-axecode-design", "");
  });
  var curseurAvant = d.documentElement.style.cursor;
  var survole = null;
  var etat = { actif: true, annule: false, choix: null };

  function sous(e) {
    var chemin = e.composedPath ? e.composedPath() : [];
    var el = chemin.length ? chemin[0] : e.target;
    while (el && el.nodeType !== 1) el = el.parentNode;
    if (!el || el === cadre || el === etiquette) return null;
    return el;
  }

  function dessiner(el) {
    if (!el || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect();
    cadre.style.display = "block";
    cadre.style.left = r.left + "px";
    cadre.style.top = r.top + "px";
    cadre.style.width = Math.max(r.width, 1) + "px";
    cadre.style.height = Math.max(r.height, 1) + "px";
    var nom = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
      (el.classList && el.classList.length ? "." + Array.prototype.slice.call(el.classList, 0, 2).join(".") : "");
    etiquette.textContent = court(nom, 60) + "  " + Math.round(r.width) + " × " + Math.round(r.height);
    etiquette.style.display = "block";
    etiquette.style.left = Math.max(0, r.left) + "px";
    etiquette.style.top = (r.top > 24 ? r.top - 22 : r.bottom + 4) + "px";
  }

  function bloquer(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function bouger(e) {
    var el = sous(e);
    if (el && el !== survole) {
      survole = el;
      dessiner(el);
    }
  }

  function clic(e) {
    bloquer(e);
    var el = sous(e) || survole;
    if (el) {
      try {
        etat.choix = decrire(el);
      } catch (erreur) {
        etat.choix = null;
      }
    }
    arreter();
  }

  function clavier(e) {
    if (e.key === "Escape") {
      bloquer(e);
      etat.annule = true;
      arreter();
    }
  }

  function defiler() {
    if (survole) dessiner(survole);
  }

  var ecoutes = [
    ["pointermove", bouger], ["mousemove", bouger], ["mouseover", bouger],
    ["pointerdown", bloquer], ["mousedown", bloquer], ["pointerup", bloquer], ["mouseup", bloquer],
    ["click", clic], ["dblclick", bloquer], ["contextmenu", bloquer], ["keydown", clavier], ["scroll", defiler]
  ];

  function arreter() {
    if (!etat.actif) return;
    etat.actif = false;
    ecoutes.forEach(function (p) { w.removeEventListener(p[0], p[1], true); });
    if (cadre.parentNode) cadre.parentNode.removeChild(cadre);
    if (etiquette.parentNode) etiquette.parentNode.removeChild(etiquette);
    d.documentElement.style.cursor = curseurAvant;
  }

  ecoutes.forEach(function (p) { w.addEventListener(p[0], p[1], true); });
  d.documentElement.appendChild(cadre);
  d.documentElement.appendChild(etiquette);
  d.documentElement.style.cursor = "crosshair";

  etat.prendre = function () {
    var c = etat.choix;
    etat.choix = null;
    return { actif: etat.actif, annule: etat.annule, choix: c };
  };
  etat.arreter = function () {
    arreter();
    return { actif: false };
  };
  w[CLE] = etat;
})();
