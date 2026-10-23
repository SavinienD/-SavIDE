import { useEffect, useState } from "react";
import {
  AXE_ACCENT,
  AXE_DEFAULT_BG,
  AXE_PRESETS,
  contrastRatio,
  currentThemeVars,
  isDarkBg,
  loadThemeBg,
  normalizeBg,
  onThemeChange,
  setThemeBg,
} from "./theme";
import {
  loadTextScale,
  onTextScaleChange,
  setTextScale,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SCALE_STEP,
  loadUiZoom,
  onUiZoomChange,
  setUiZoom,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  UI_ZOOM_STEP,
} from "./zoom"; // axe:zoom

/** Settings > Apparence: text size, Axe presets, free background picker and a live mini-IDE preview. */
export function AppearanceSection() {
  const [bg, setBg] = useState<string>(() => loadThemeBg());
  const [draft, setDraft] = useState<string>(bg);
  const [textScale, setTextScaleState] = useState<number>(() => loadTextScale());

  useEffect(() => onThemeChange((value) => {
    setBg(value);
    setDraft(value);
  }), []);
  useEffect(() => onTextScaleChange(setTextScaleState), []);
  const [uiZoom, setUiZoomState] = useState<number>(() => loadUiZoom()); // axe:zoom-origine
  useEffect(() => onUiZoomChange((z) => { setUiZoomState(z); setUiZoomDraft(null); }), []);
  // axe:zoom-curseur — pendant le glisser, seule la valeur affichée bouge ;
  // le zoom natif est appliqué au relâchement (pointerup / clavier / blur).
  const [uiZoomDraft, setUiZoomDraft] = useState<number | null>(null);
  const commitUiZoom = () => {
    if (uiZoomDraft !== null && uiZoomDraft !== uiZoom) setUiZoom(uiZoomDraft);
    setUiZoomDraft(null);
  };
  const shownUiZoom = uiZoomDraft ?? uiZoom;

  const commitDraft = () => setThemeBg(normalizeBg(draft));
  const vars = currentThemeVars();
  const textContrast = contrastRatio(vars["--text-0"], bg);
  const dimContrast = contrastRatio(vars["--text-2"], bg);
  const readable = dimContrast >= 4.5;

  return (
    <div className="axe-appearance">
      <header>
        <h2>Apparence</h2>
        <p className="axe-appearance__hint">
          Une seule couleur de fond pilote toute l'interface : panneaux, bordures, textes, éditeur
          et terminal en sont dérivés, en version claire ou sombre selon sa luminosité.
          L'accent reste l'orange Axe.
        </p>
      </header>

      {/* axe:zoom-origine — zoom de toute l'interface, celui d'origine de SavIDE */}
      <section className="axe-appearance__block">
        <h3>Zoom de l'interface</h3>
        <div className="axe-appearance__row">
          <input
            type="range"
            className="axe-appearance__zoom"
            aria-label="Zoom de l'interface"
            min={UI_ZOOM_MIN * 100}
            max={UI_ZOOM_MAX * 100}
            step={UI_ZOOM_STEP * 100}
            value={Math.round(shownUiZoom * 100)}
            onChange={(e) => setUiZoomDraft(Number(e.target.value) / 100)}
            onPointerUp={commitUiZoom}
            onKeyUp={commitUiZoom}
            onBlur={commitUiZoom}
          />
          <span className="axe-appearance__zoom-value">{Math.round(shownUiZoom * 100)} %</span>
          <button
            type="button"
            className="axe-appearance__button"
            disabled={uiZoom === 1}
            onClick={() => setUiZoom(1)}
          >
            100 %
          </button>
        </div>
        <span className="axe-appearance__hint">
          Agrandit ou réduit toute la fenêtre (le zoom d'origine de SavIDE). Glissez le curseur à la souris, ou Ctrl +, Ctrl −, Ctrl 0.
        </span>
      </section>

      <section className="axe-appearance__block">
        <h3>Taille du texte du chat et des documents</h3>
        <div className="axe-appearance__row">
          <input
            type="range"
            className="axe-appearance__zoom"
            aria-label="Taille du texte"
            min={TEXT_SCALE_MIN * 100}
            max={TEXT_SCALE_MAX * 100}
            step={TEXT_SCALE_STEP * 100}
            value={Math.round(textScale * 100)}
            onChange={(e) => setTextScale(Number(e.target.value) / 100)}
          />
          <span className="axe-appearance__zoom-value">{Math.round(textScale * 100)} %</span>
          <button
            type="button"
            className="axe-appearance__button"
            disabled={textScale === 1}
            onClick={() => setTextScale(1)}
          >
            100 %
          </button>
        </div>
        <span className="axe-appearance__hint">
          N'agrandit que les caractères du chat et des documents ouverts : barre de titre, listes, boutons et panneaux gardent exactement leur taille.
        </span>
      </section>

      <section className="axe-appearance__block">
        <h3>Préréglages</h3>
        <div className="axe-appearance__presets">
          {AXE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="axe-appearance__preset"
              data-active={p.bg === bg || undefined}
              onClick={() => setThemeBg(p.bg)}
            >
              <span className="axe-appearance__preset-swatch" style={{ background: p.bg }}>
                <span style={{ background: AXE_ACCENT }} />
              </span>
              <span className="axe-appearance__preset-name">{p.name}</span>
              <span className="axe-appearance__preset-kind">{isDarkBg(p.bg) ? "Sombre" : "Clair"}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="axe-appearance__block">
        <h3>Couleur libre</h3>
        <div className="axe-appearance__row">
          <input
            type="color"
            className="axe-appearance__swatch"
            aria-label="Couleur de fond"
            value={bg}
            onChange={(e) => setThemeBg(e.target.value)}
          />
          <input
            type="text"
            className="axe-appearance__hex"
            aria-label="Code hexadécimal"
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitDraft();
            }}
          />
          <button
            type="button"
            className="axe-appearance__button"
            disabled={bg === AXE_DEFAULT_BG}
            onClick={() => setThemeBg(null)}
          >
            Revenir au défaut Axe
          </button>
        </div>
        <p className="axe-appearance__contrast" data-ok={readable || undefined}>
          Lisibilité : texte {textContrast.toFixed(1).replace(".", ",")}:1, texte secondaire {dimContrast.toFixed(1).replace(".", ",")}:1
          {readable ? " — conforme" : " — texte secondaire trop pâle, choisissez une couleur plus franche"}
        </p>
      </section>

      <section className="axe-appearance__block">
        <h3>Aperçu</h3>
        <ThemePreview />
      </section>
    </div>
  );
}

/** A miniature of the real IDE, painted with the live CSS variables. */
function ThemePreview() {
  return (
    <div className="axe-preview" aria-hidden="true">
      <div className="axe-preview__titlebar">
        <span className="axe-preview__pill">5 h 12 %</span>
        <span className="axe-preview__title">SavIDE</span>
      </div>
      <div className="axe-preview__body">
        <aside className="axe-preview__sidebar">
          <div className="axe-preview__file">src</div>
          <div className="axe-preview__file" data-active>App.tsx</div>
          <div className="axe-preview__file">theme.ts</div>
          <div className="axe-preview__file axe-preview__file--dirty">README.md</div>
        </aside>
        <div className="axe-preview__main">
          <pre className="axe-preview__editor">
            <span className="n">1</span><span className="k">export function</span> <span className="f">greet</span>(name: <span className="t">string</span>) {"{"}{"\n"}
            <span className="n">2</span>  <span className="c">// accueil du client</span>{"\n"}
            <span className="n">3</span>  <span className="k">return</span> <span className="s">`Bonjour ${"{"}name{"}"}`</span>;{"\n"}
            <span className="n">4</span>{"}"}
          </pre>
          <div className="axe-preview__diff">
            <div className="axe-preview__add">+ const retries = 3;</div>
            <div className="axe-preview__rem">- const retries = 1;</div>
          </div>
          <div className="axe-preview__terminal">
            <span className="ok">✓</span> compilation terminée en 4,2 s <span className="err">1 avertissement</span>
          </div>
        </div>
        <aside className="axe-preview__chat">
          <div className="axe-preview__bubble axe-preview__bubble--user">Corrige le test qui échoue</div>
          <div className="axe-preview__card">python · files.edit(&quot;app.ts&quot;)</div>
          <div className="axe-preview__bubble">Corrigé : le délai était trop court.</div>
          <div className="axe-preview__composer">
            <span>Message…</span>
            <span className="axe-preview__send">Envoyer</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
