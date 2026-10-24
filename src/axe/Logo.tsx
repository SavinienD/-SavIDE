type Props = {
  /** Hauteur affichée en px ; la largeur suit les proportions du logo (1:1 pour la tuile). */
  size?: number;
  className?: string;
  /**
   * `mark` = tuile carrée blanche avec le logo « SavIDE » complet (comme l'icône de l'appli),
   * `wordmark` = logo « SavIDE » complet sur une pastille blanche arrondie.
   */
  variant?: "mark" | "wordmark";
};

// Logo SavIDE : texte « SavIDE » en aplats géométriques, NOIR sur FOND BLANC, partout.
// Ni orange ni dégradé. Couleurs fixes (pas de currentColor) pour rester identique au jeu
// d'icônes (scripts/generate-savide-icon.mjs → src-tauri/icons/savide-icon-1024.png).
const NOIR = "#000000";
const BLANC = "#ffffff";

function Glyphes() {
  return (
    <>
      <rect x="0" y="0" width="700" height="190" />
      <rect x="0" y="286" width="700" height="190" />
      <rect x="0" y="572" width="700" height="190" />
      <rect x="0" y="0" width="190" height="476" />
      <rect x="510" y="286" width="190" height="476" />
      <path d="M1050 310 L1173 512 L927 512 Z" />
      <path d="M884 582 L1216 582 L1328 762 L772 762 Z" />
      <path d="M1400 306 L1960 306 L1680 762 Z" />
      <rect x="2030" y="0" width="190" height="762" />
      <path d="M2290 0 L2770 0 L3010 381 L2770 762 L2290 762 Z M2480 190 L2670 190 L2790 381 L2670 572 L2480 572 Z" fillRule="evenodd" />
      <rect x="3080" y="0" width="700" height="190" />
      <rect x="3080" y="286" width="700" height="190" />
      <rect x="3080" y="572" width="700" height="190" />
    </>
  );
}

const LOGO_W = 3780;
const LOGO_H = 762;

export function AxeLogo({ size = 22, className, variant = "wordmark" }: Props) {
  if (variant === "mark") {
    // Tuile carrée blanche, logo complet centré sur 88 % de la largeur (comme l'icône de l'appli).
    const s = 900 / LOGO_W;
    const tx = (1024 - 900) / 2;
    const ty = (1024 - LOGO_H * s) / 2;
    return (
      <svg className={className} viewBox="0 0 1024 1024" width={size} height={size} aria-hidden="true" data-logo="mark">
        <rect className="logo__fond" x="0" y="0" width="1024" height="1024" rx="180" fill={BLANC} />
        <g transform={`translate(${tx} ${ty}) scale(${s})`} fill={NOIR}>
          <Glyphes />
        </g>
      </svg>
    );
  }

  // Pastille blanche arrondie autour du logo complet (marge 18 % de la hauteur du logo).
  const m = Math.round(LOGO_H * 0.18);
  const vw = LOGO_W + 2 * m;
  const vh = LOGO_H + 2 * m;
  const width = Math.round((size * vw) / vh);
  return (
    <svg className={className} viewBox={`0 0 ${vw} ${vh}`} width={width} height={size} aria-hidden="true" data-logo="wordmark">
      <rect className="logo__fond" x="0" y="0" width={vw} height={vh} rx={Math.round(vh * 0.22)} fill={BLANC} />
      <g transform={`translate(${m} ${m})`} fill={NOIR}>
        <Glyphes />
      </g>
    </svg>
  );
}
