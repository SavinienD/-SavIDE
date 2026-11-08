// Image modifiée depuis le dernier commit : avant (version validée) et après
// (fichier actuel), en glissière (la frontière suit la souris, ou les flèches du clavier sur le
// curseur) ou côte à côte. Ouverte par « Avant / après » dans la barre d'onglets.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import { cadreCommun, positionGlissiere, type Taille } from "../editeur/imageAvantApres";

type Mode = "glissiere" | "cote";
/** Dernier mode choisi (le temps de la session). */
let dernierMode: Mode = "glissiere";

type Props = {
  /** Dernière version validée (commit), en adresse data:. */
  avant: string;
  /** Image actuelle. */
  apres: string;
  nom: string;
};

export function ImageAvantApres({ avant, apres, nom }: Props) {
  const [mode, setMode] = useState<Mode>(dernierMode);
  const [position, setPosition] = useState(50);
  const [tailles, setTailles] = useState<{ avant: Taille | null; apres: Taille | null }>({ avant: null, apres: null });
  const [zone, setZone] = useState<Taille>({ l: 0, h: 0 });
  const sceneRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    const mesurer = () => setZone({ l: el.clientWidth, h: el.clientHeight });
    mesurer();
    const observateur = new ResizeObserver(mesurer);
    observateur.observe(el);
    return () => observateur.disconnect();
  }, [mode]);

  const choisir = (m: Mode) => {
    dernierMode = m;
    setMode(m);
  };
  const noter = (cote: "avant" | "apres") => (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const t = { l: img.naturalWidth || 512, h: img.naturalHeight || 512 };
    setTailles((avantMaj) => (avantMaj[cote]?.l === t.l && avantMaj[cote]?.h === t.h ? avantMaj : { ...avantMaj, [cote]: t }));
  };
  const glisser = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const placer = (x: number) => {
      const r = el.getBoundingClientRect();
      setPosition(positionGlissiere(x, r.left, r.width));
    };
    placer(e.clientX);
    el.setPointerCapture?.(e.pointerId);
    const bouger = (m: PointerEvent) => placer(m.clientX);
    const finir = () => {
      el.removeEventListener("pointermove", bouger);
      el.removeEventListener("pointerup", finir);
      el.removeEventListener("pointercancel", finir);
    };
    el.addEventListener("pointermove", bouger);
    el.addEventListener("pointerup", finir);
    el.addEventListener("pointercancel", finir);
  };
  const cadre = cadreCommun(tailles.avant, tailles.apres, zone);
  const dimensions = (t: Taille | null) => (t ? `${t.l} × ${t.h} px` : "");

  return (
    <div className="xv-avap" data-mode={mode}>
      <div className="xv-toolbar">
        <div className="xv-avap__modes" role="group" aria-label="Affichage de la comparaison">
          <button
            type="button"
            className="xv-btn xv-btn--text"
            data-mode-avap="glissiere"
            data-active={mode === "glissiere" ? "true" : "false"}
            aria-pressed={mode === "glissiere"}
            onClick={() => choisir("glissiere")}
          >
            Glissière
          </button>
          <button
            type="button"
            className="xv-btn xv-btn--text"
            data-mode-avap="cote"
            data-active={mode === "cote" ? "true" : "false"}
            aria-pressed={mode === "cote"}
            onClick={() => choisir("cote")}
          >
            Côte à côte
          </button>
        </div>
        <span className="xv-toolbar__hint" title="Avant : dernière version validée (commit). Après : fichier actuel.">
          Avant : dernière version validée (commit) · Après : fichier actuel
        </span>
      </div>
      {mode === "glissiere" ? (
        <div className="xv-avap__scene" ref={sceneRef}>
          <div
            className="xv-avap__cadre"
            style={cadre ? { width: cadre.l, height: cadre.h } : { width: 1, height: 1, visibility: "hidden" }}
            onPointerDown={glisser}
          >
            <img className="xv-avap__avant" src={avant} alt={`${nom}, version validée`} draggable={false} onLoad={noter("avant")} />
            <img
              className="xv-avap__apres"
              src={apres}
              alt={`${nom}, fichier actuel`}
              draggable={false}
              onLoad={noter("apres")}
              style={{ clipPath: `inset(0 0 0 ${position}%)` }}
            />
            <div className="xv-avap__trait" style={{ left: `${position}%` }} aria-hidden="true" />
            <span className="xv-avap__etiquette" data-cote="avant">Avant</span>
            <span className="xv-avap__etiquette" data-cote="apres">Après</span>
          </div>
          <input
            type="range"
            className="xv-avap__curseur"
            min={0}
            max={100}
            step={1}
            value={Math.round(position)}
            aria-label="Position de la glissière : avant à gauche, après à droite"
            onChange={(e) => setPosition(Number(e.target.value))}
            style={cadre ? { width: Math.max(160, cadre.l) } : undefined}
          />
        </div>
      ) : (
        <div className="xv-avap__cote">
          {(["avant", "apres"] as const).map((cote) => (
            <figure key={cote} className="xv-avap__panneau" data-cote={cote}>
              <div className="xv-avap__fond">
                <img src={cote === "avant" ? avant : apres} alt={`${nom}, ${cote === "avant" ? "version validée" : "fichier actuel"}`} draggable={false} onLoad={noter(cote)} />
              </div>
              <figcaption>
                <span>{cote === "avant" ? "Avant (version validée)" : "Après (fichier actuel)"}</span>
                <span>{dimensions(tailles[cote])}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
