// Bibliothèque injectée dans la page du navigateur intégré (lot 186) : lecture compacte
// de la page (texte + éléments interactifs numérotés e1, e2…) et actions de l'agent.
// Évaluée par l'appli (evaluate_script de la vue web) : la page ne reçoit aucune API
// de l'appli, et tout ce que cette bibliothèque renvoie est traité comme une donnée.
(function () {
  "use strict";
  var CLE = "__axecodeNavigateur";
  var VERSION = 1;
  var w = window;
  if (w[CLE] && w[CLE].version === VERSION) return;

  var etat = { compteur: 0, refs: new Map(), parElement: new WeakMap(), styles: new Map() };

  var ROLES = {
    button: "bouton", link: "lien", checkbox: "case à cocher", radio: "bouton radio",
    tab: "onglet", menuitem: "élément de menu", menuitemcheckbox: "élément de menu",
    menuitemradio: "élément de menu", option: "option", "switch": "interrupteur",
    combobox: "liste déroulante", textbox: "champ", searchbox: "champ de recherche",
    slider: "curseur", spinbutton: "champ nombre", treeitem: "élément d'arbre"
  };
  var TYPES = {
    checkbox: "case à cocher", radio: "bouton radio", submit: "bouton", button: "bouton",
    reset: "bouton", image: "bouton", password: "champ mot de passe", email: "champ e-mail",
    search: "champ de recherche", number: "champ nombre", tel: "champ téléphone",
    url: "champ adresse", date: "champ date", time: "champ heure", "datetime-local": "champ date",
    month: "champ date", week: "champ date", file: "choix de fichier", range: "curseur",
    color: "choix de couleur"
  };
  var IGNORES = { script: 1, style: 1, noscript: 1, template: 1, head: 1, meta: 1, link: 1, svg: 1, canvas: 1 };

  function court(t, n) {
    t = String(t == null ? "" : t).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }

  function style(el) {
    var s = etat.styles.get(el);
    if (!s) {
      s = w.getComputedStyle(el);
      etat.styles.set(el, s);
    }
    return s;
  }

  function cache(el) {
    var s = style(el);
    return s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse";
  }

  function visible(el) {
    if (!el || !el.isConnected || cache(el)) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || el.getClientRects().length > 0;
  }

  function balise(el) {
    return (el.tagName || "").toLowerCase();
  }

  function typeDe(el) {
    return (el.getAttribute("type") || "text").toLowerCase();
  }

  function interactif(el) {
    var tag = balise(el);
    if (tag === "a") return el.hasAttribute("href");
    if (tag === "button" || tag === "select" || tag === "textarea" || tag === "summary") return true;
    if (tag === "input") return typeDe(el) !== "hidden";
    var role = (el.getAttribute("role") || "").toLowerCase();
    if (ROLES[role]) return true;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return true;
    if (el.hasAttribute("onclick")) return true;
    var ti = el.getAttribute("tabindex");
    if (ti !== null && ti !== "" && Number(ti) >= 0) return true;
    // Élément cliquable d'une appli (écouteur JavaScript) : curseur « main » qui
    // ne vient pas d'un parent déjà cliquable.
    if (style(el).cursor === "pointer") {
      var parent = el.parentElement;
      return !(parent && style(parent).cursor === "pointer");
    }
    return false;
  }

  function genre(el) {
    var role = (el.getAttribute("role") || "").toLowerCase();
    if (ROLES[role]) return ROLES[role];
    var tag = balise(el);
    if (tag === "a") return "lien";
    if (tag === "button" || tag === "summary") return "bouton";
    if (tag === "select") return "liste déroulante";
    if (tag === "textarea") return "zone de texte";
    if (tag === "input") return TYPES[typeDe(el)] || "champ";
    if (el.isContentEditable) return "zone éditable";
    return "élément cliquable";
  }

  function nom(el) {
    var t = el.getAttribute("aria-label");
    if (t && t.trim()) return t;
    var ids = el.getAttribute("aria-labelledby");
    if (ids) {
      t = ids.split(/\s+/).map(function (id) {
        var x = document.getElementById(id);
        return x ? x.textContent : "";
      }).join(" ");
      if (t.trim()) return t;
    }
    if (el.labels && el.labels.length) {
      t = Array.prototype.map.call(el.labels, function (l) { return l.innerText || l.textContent; }).join(" ");
      if (t.trim()) return t;
    }
    var tag = balise(el);
    if (tag === "input") {
      var type = typeDe(el);
      if (type === "submit" || type === "button" || type === "reset") return el.value || (type === "submit" ? "Envoyer" : "");
      if (type === "image") return el.getAttribute("alt") || "";
      return el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "";
    }
    if (tag === "textarea" || tag === "select") {
      return el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "";
    }
    t = el.innerText || el.textContent || "";
    if (!t.trim()) {
      var img = el.querySelector && el.querySelector("img[alt]");
      if (img) t = img.getAttribute("alt");
    }
    return t && t.trim() ? t : el.getAttribute("title") || "";
  }

  function lien(el) {
    var href = el.getAttribute("href") || "";
    try {
      var u = new URL(href, location.href);
      if (u.origin === location.origin) return court(u.pathname + u.search + u.hash, 80);
      return court(u.href, 80);
    } catch (e) {
      return court(href, 80);
    }
  }

  function details(el) {
    var tag = balise(el);
    var morceaux = [];
    if (tag === "input" || tag === "textarea") {
      var type = typeDe(el);
      if (type === "checkbox" || type === "radio") {
        morceaux.push(el.checked ? "(cochée)" : "(non cochée)");
      } else if (type === "password") {
        morceaux.push(el.value ? "(rempli)" : "(vide)");
      } else if (type !== "submit" && type !== "button" && type !== "reset" && type !== "image" && type !== "file") {
        morceaux.push(el.value ? "= « " + court(el.value, 80) + " »" : "(vide)");
      }
    } else if (tag === "select") {
      var opt = el.options && el.options[el.selectedIndex];
      morceaux.push(opt ? "= « " + court(opt.text, 60) + " »" : "(vide)");
    } else if (tag === "a") {
      morceaux.push("→ " + lien(el));
    }
    var aria = el.getAttribute("aria-checked");
    if (aria === "true") morceaux.push("(cochée)");
    var ouvert = el.getAttribute("aria-expanded");
    if (ouvert === "true") morceaux.push("(ouvert)");
    if (ouvert === "false") morceaux.push("(fermé)");
    if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current")) morceaux.push("(actif)");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") morceaux.push("(désactivé)");
    return morceaux.join(" ");
  }

  function decrire(el) {
    if (!el || el.nodeType !== 1) return "";
    var n = court(nom(el), 80);
    return genre(el) + (n ? " « " + n + " »" : "");
  }

  function refDe(el) {
    var r = etat.parElement.get(el);
    if (!r) {
      etat.compteur += 1;
      r = "e" + etat.compteur;
      etat.parElement.set(el, r);
    }
    etat.refs.set(r, el);
    return r;
  }

  function bloc(el) {
    var cur = el;
    while (cur && cur.nodeType === 1) {
      var d = style(cur).display;
      if (d && d !== "inline" && d !== "inline-block" && d !== "contents") return cur;
      cur = cur.parentElement;
    }
    return document.body;
  }

  function lire(options) {
    options = options || {};
    var maxElements = Math.max(1, Math.min(Number(options.max_elements) || 150, 1000));
    var maxCaracteres = Math.max(500, Math.min(Number(options.max_caracteres) || 8000, 60000));
    var racine = document.body || document.documentElement;
    if (options.selecteur) {
      racine = document.querySelector(String(options.selecteur));
      if (!racine) throw new Error("aucun élément pour le sélecteur " + options.selecteur);
    }
    etat.refs = new Map();
    etat.styles = new Map();
    var lignes = [];
    var total = 0;
    var elements = 0;
    var tronque = false;
    var tampon = "";
    var blocCourant = null;

    function ajouter(ligne) {
      if (!ligne) return;
      if (total + ligne.length > maxCaracteres) {
        tronque = true;
        return;
      }
      total += ligne.length + 1;
      lignes.push(ligne);
    }
    function vider() {
      var t = court(tampon, 300);
      tampon = "";
      blocCourant = null;
      if (t) ajouter(t);
    }

    function parcourir(noeud) {
      var enfant = noeud.firstChild;
      while (enfant && !tronque) {
        visiter(enfant);
        enfant = enfant.nextSibling;
      }
    }

    function visiter(n) {
      if (tronque) return;
      if (n.nodeType === 3) {
        var texte = n.nodeValue;
        if (!texte || !texte.trim()) return;
        var b = n.parentElement ? bloc(n.parentElement) : null;
        if (b !== blocCourant) {
          vider();
          blocCourant = b;
        }
        tampon += " " + texte;
        return;
      }
      if (n.nodeType !== 1) return;
      var tag = balise(n);
      if (IGNORES[tag]) return;
      if (cache(n)) return;
      if (tag === "iframe" || tag === "frame") {
        vider();
        ajouter("[cadre] " + court(n.getAttribute("src") || n.getAttribute("title") || "", 80));
        return;
      }
      if (/^h[1-6]$/.test(tag)) {
        vider();
        var titre = court(n.innerText || n.textContent, 200);
        if (titre) ajouter(new Array(Number(tag[1]) + 1).join("#") + " " + titre);
        return;
      }
      if (interactif(n)) {
        // Élément d'interface sans taille (menu replié, lien d'évitement) : caché.
        if (!visible(n)) return;
        vider();
        if (elements >= maxElements) {
          tronque = true;
          return;
        }
        elements += 1;
        var ligne = "[" + refDe(n) + "] " + decrire(n);
        var plus = details(n);
        ajouter(plus ? ligne + " " + plus : ligne);
        return;
      }
      if (n.shadowRoot) parcourir(n.shadowRoot);
      parcourir(n);
    }

    if (racine) parcourir(racine);
    vider();
    return {
      url: location.href,
      titre: document.title || "",
      lignes: lignes,
      elements: elements,
      tronque: tronque
    };
  }

  function element(ref) {
    var el = etat.refs.get(String(ref));
    if (!el || !el.isConnected) {
      throw new Error("élément " + ref + " introuvable : relisez la page avec lire()");
    }
    return el;
  }

  function evenementSouris(el, type, x, y) {
    var init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: w };
    try {
      if (type.indexOf("pointer") === 0 && typeof PointerEvent === "function") {
        init.pointerId = 1;
        init.pointerType = "mouse";
        init.isPrimary = true;
        el.dispatchEvent(new PointerEvent(type, init));
      } else if (type.indexOf("pointer") !== 0) {
        el.dispatchEvent(new MouseEvent(type, init));
      }
    } catch (e) {
      /* évènement non pris en charge par cette page : on continue */
    }
  }

  function cliquer(ref) {
    var el = element(ref);
    if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2;
    var y = r.top + r.height / 2;
    evenementSouris(el, "pointerdown", x, y);
    evenementSouris(el, "mousedown", x, y);
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    evenementSouris(el, "pointerup", x, y);
    evenementSouris(el, "mouseup", x, y);
    el.click();
    return { ok: true, element: decrire(el) };
  }

  function poserValeur(el, valeur) {
    var proto = balise(el) === "textarea" ? w.HTMLTextAreaElement.prototype
      : balise(el) === "select" ? w.HTMLSelectElement.prototype : w.HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, "value");
    if (d && d.set) d.set.call(el, valeur);
    else el.value = valeur;
  }

  function signalerSaisie(el, texte) {
    var evt;
    try {
      evt = new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: texte });
    } catch (e) {
      evt = new Event("input", { bubbles: true });
    }
    el.dispatchEvent(evt);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function remplir(ref, texte) {
    var el = element(ref);
    texte = String(texte == null ? "" : texte);
    if (el.scrollIntoView) el.scrollIntoView({ block: "center" });
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    var tag = balise(el);
    if (tag === "select") {
      var options = Array.prototype.slice.call(el.options);
      var voulu = texte.trim().toLowerCase();
      var opt = options.filter(function (o) { return o.value === texte; })[0]
        || options.filter(function (o) { return court(o.text, 200).toLowerCase() === voulu; })[0]
        || options.filter(function (o) { return o.text.toLowerCase().indexOf(voulu) >= 0; })[0];
      if (!opt) throw new Error("aucune option « " + texte + " » dans cette liste");
      poserValeur(el, opt.value);
      signalerSaisie(el, texte);
    } else if (tag === "input" || tag === "textarea") {
      var type = typeDe(el);
      if (type === "checkbox" || type === "radio") {
        var cocher = /^(1|oui|vrai|true|on|x|cochée?)$/i.test(texte.trim());
        if (el.checked !== cocher) el.click();
        return { ok: true, element: decrire(el) };
      }
      if (type === "file") throw new Error("un choix de fichier ne se remplit pas depuis l'agent");
      poserValeur(el, texte);
      signalerSaisie(el, texte);
    } else if (el.isContentEditable) {
      var selection = w.getSelection();
      var plage = document.createRange();
      plage.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(plage);
      var fait = false;
      try {
        fait = document.execCommand && document.execCommand("insertText", false, texte);
      } catch (e) {
        fait = false;
      }
      if (!fait) {
        el.textContent = texte;
        signalerSaisie(el, texte);
      }
    } else {
      throw new Error("cet élément ne se remplit pas (" + genre(el) + ")");
    }
    return { ok: true, element: decrire(el) };
  }

  var TOUCHES = {
    "entrée": ["Enter", "Enter", 13], entree: ["Enter", "Enter", 13], enter: ["Enter", "Enter", 13],
    tab: ["Tab", "Tab", 9], tabulation: ["Tab", "Tab", 9],
    "échap": ["Escape", "Escape", 27], echap: ["Escape", "Escape", 27], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
    espace: [" ", "Space", 32], space: [" ", "Space", 32],
    "retour arrière": ["Backspace", "Backspace", 8], backspace: ["Backspace", "Backspace", 8],
    suppr: ["Delete", "Delete", 46], "delete": ["Delete", "Delete", 46],
    "flèche bas": ["ArrowDown", "ArrowDown", 40], bas: ["ArrowDown", "ArrowDown", 40], arrowdown: ["ArrowDown", "ArrowDown", 40],
    "flèche haut": ["ArrowUp", "ArrowUp", 38], haut: ["ArrowUp", "ArrowUp", 38], arrowup: ["ArrowUp", "ArrowUp", 38],
    "flèche gauche": ["ArrowLeft", "ArrowLeft", 37], gauche: ["ArrowLeft", "ArrowLeft", 37], arrowleft: ["ArrowLeft", "ArrowLeft", 37],
    "flèche droite": ["ArrowRight", "ArrowRight", 39], droite: ["ArrowRight", "ArrowRight", 39], arrowright: ["ArrowRight", "ArrowRight", 39],
    "début": ["Home", "Home", 36], debut: ["Home", "Home", 36], home: ["Home", "Home", 36],
    fin: ["End", "End", 35], end: ["End", "End", 35],
    "page suivante": ["PageDown", "PageDown", 34], pagedown: ["PageDown", "PageDown", 34],
    "page précédente": ["PageUp", "PageUp", 33], pageup: ["PageUp", "PageUp", 33]
  };

  function focusables() {
    var liste = document.querySelectorAll(
      "a[href], button, input, select, textarea, summary, [tabindex], [contenteditable='true'], [contenteditable='']"
    );
    return Array.prototype.filter.call(liste, function (el) {
      var ti = el.getAttribute("tabindex");
      if (ti !== null && Number(ti) < 0) return false;
      if (el.disabled || (balise(el) === "input" && typeDe(el) === "hidden")) return false;
      return visible(el);
    });
  }

  function focusSuivant(depuis, sens) {
    var liste = focusables();
    if (!liste.length) return;
    var i = liste.indexOf(depuis);
    var suivant = liste[(i < 0 ? (sens > 0 ? -1 : 0) : i) + sens];
    if (!suivant) suivant = sens > 0 ? liste[0] : liste[liste.length - 1];
    if (suivant && suivant.focus) suivant.focus();
  }

  function insererCaractere(el, texte) {
    var debut = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
    var fin = typeof el.selectionEnd === "number" ? el.selectionEnd : el.value.length;
    poserValeur(el, el.value.slice(0, debut) + texte + el.value.slice(fin));
    try {
      el.setSelectionRange(debut + texte.length, debut + texte.length);
    } catch (e) {
      /* champ sans sélection (nombre, e-mail) */
    }
    signalerSaisie(el, texte);
  }

  function actionParDefaut(cible, cle, maj) {
    var tag = balise(cible);
    var champ = tag === "textarea" || (tag === "input" && !/^(checkbox|radio|submit|button|reset|image|file|range|color)$/.test(typeDe(cible)));
    if (cle === "Enter") {
      if (tag === "input" && cible.form && champ) {
        if (cible.form.requestSubmit) cible.form.requestSubmit();
        else cible.form.submit();
      } else if (tag === "textarea") {
        insererCaractere(cible, "\n");
      } else if (tag === "a" || tag === "button" || tag === "summary" || (cible.getAttribute && cible.getAttribute("role") === "button")) {
        cible.click();
      }
    } else if (cle === " ") {
      if (champ) insererCaractere(cible, " ");
      else if (tag === "button" || tag === "input" || (cible.getAttribute && /^(button|checkbox|switch|radio)$/.test(cible.getAttribute("role") || ""))) cible.click();
    } else if (cle === "Tab") {
      focusSuivant(cible, maj ? -1 : 1);
    } else if (cle === "Backspace" && champ) {
      var d = typeof cible.selectionStart === "number" ? cible.selectionStart : cible.value.length;
      var f = typeof cible.selectionEnd === "number" ? cible.selectionEnd : cible.value.length;
      if (d === f && d > 0) d -= 1;
      poserValeur(cible, cible.value.slice(0, d) + cible.value.slice(f));
      signalerSaisie(cible, "");
    } else if (cle.length === 1 && champ) {
      insererCaractere(cible, cle);
    }
  }

  function touche(nom) {
    var brut = String(nom == null ? "" : nom).trim();
    var cle = brut.toLowerCase();
    var maj = false;
    if (/^(maj|shift)\s*\+\s*/.test(cle)) {
      maj = true;
      cle = cle.replace(/^(maj|shift)\s*\+\s*/, "");
      brut = brut.replace(/^(maj|shift)\s*\+\s*/i, "");
    }
    var t = TOUCHES[cle];
    if (!t && brut.length === 1) {
      var code = /[a-z]/i.test(brut) ? "Key" + brut.toUpperCase() : /[0-9]/.test(brut) ? "Digit" + brut : "";
      t = [brut, code, brut.toUpperCase().charCodeAt(0)];
    }
    if (!t) throw new Error("touche inconnue : " + nom + " (exemples : Entrée, Tab, Échap, Flèche bas, a)");
    var cible = document.activeElement || document.body;
    var init = { key: t[0], code: t[1], keyCode: t[2], which: t[2], bubbles: true, cancelable: true, composed: true, shiftKey: maj };
    var acceptee = cible.dispatchEvent(new KeyboardEvent("keydown", init));
    if (t[0] === "Enter" || t[0].length === 1) {
      acceptee = cible.dispatchEvent(new KeyboardEvent("keypress", init)) && acceptee;
    }
    if (acceptee) actionParDefaut(cible, t[0], maj);
    (document.activeElement || cible).dispatchEvent(new KeyboardEvent("keyup", init));
    return { ok: true, focus: decrire(document.activeElement) };
  }

  function trouver(cible) {
    cible = String(cible == null ? "" : cible);
    if (!cible.trim()) throw new Error("texte ou sélecteur vide");
    var el = null;
    try {
      el = document.querySelector(cible);
    } catch (e) {
      el = null;
    }
    if (el && visible(el)) return { trouve: true, par: "sélecteur" };
    var corps = document.body;
    var texte = corps ? corps.innerText || corps.textContent || "" : "";
    if (texte.toLowerCase().indexOf(cible.toLowerCase()) >= 0) return { trouve: true, par: "texte" };
    return { trouve: false };
  }

  function resume() {
    return { url: location.href, titre: document.title || "", pret: document.readyState };
  }

  var api = {
    version: VERSION,
    lire: lire,
    cliquer: cliquer,
    remplir: remplir,
    touche: touche,
    trouver: trouver,
    resume: resume
  };
  try {
    Object.defineProperty(w, CLE, { value: api, configurable: true, enumerable: false, writable: false });
  } catch (e) {
    w[CLE] = api;
  }
})();
