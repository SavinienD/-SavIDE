import { useId } from "react";

type Props = {
  /** Hauteur affichée en px ; la largeur suit les proportions du logo (1:1 pour le symbole). */
  size?: number;
  className?: string;
  /** `mark` = le « S » seul (carré), `wordmark` = « SavIDE » complet. */
  variant?: "mark" | "wordmark";
};

const GLYPH = "currentColor";

/**
 * Logo SavIDE : même dessin que le logo Axe (aplats géométriques, barres, triangles),
 * texte « SavIDE ». Les lettres suivent `currentColor` ; le « v » garde le dégradé orange.
 */
export function AxeLogo({ size = 22, className, variant = "wordmark" }: Props) {
  const id = useId();
  const gradId = `savide-grad-${id}`;

  if (variant === "mark") {
    return (
      <svg className={className} viewBox="0 0 920 920" width={size} height={size} aria-hidden="true">
        <g transform="translate(0 79)">
        <rect x="110" y="0" width="700" height="190" fill={GLYPH} />
        <rect x="110" y="286" width="700" height="190" fill={GLYPH} />
        <rect x="110" y="572" width="700" height="190" fill={GLYPH} />
        <rect x="110" y="0" width="190" height="476" fill={GLYPH} />
        <rect x="620" y="286" width="190" height="476" fill={GLYPH} />
        </g>
      </svg>
    );
  }

  const width = Math.round((size * 3780) / 762);
  return (
    <svg className={className} viewBox="0 0 3780 762" width={width} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="1400" y1="306" x2="1960" y2="762" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F89223" />
          <stop offset="1" stopColor="#F15334" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="700" height="190" fill={GLYPH} />
      <rect x="0" y="286" width="700" height="190" fill={GLYPH} />
      <rect x="0" y="572" width="700" height="190" fill={GLYPH} />
      <rect x="0" y="0" width="190" height="476" fill={GLYPH} />
      <rect x="510" y="286" width="190" height="476" fill={GLYPH} />
      <path d="M1050 310 L1173 512 L927 512 Z" fill={GLYPH} />
      <path d="M884 582 L1216 582 L1328 762 L772 762 Z" fill={GLYPH} />
      <path d="M1400 306 L1960 306 L1680 762 Z" fill={`url(#${gradId})`} />
      <rect x="2030" y="0" width="190" height="762" fill={GLYPH} />
      <path d="M2290 0 L2770 0 L3010 381 L2770 762 L2290 762 Z M2480 190 L2670 190 L2790 381 L2670 572 L2480 572 Z" fillRule="evenodd" fill={GLYPH} />
      <rect x="3080" y="0" width="700" height="190" fill={GLYPH} />
      <rect x="3080" y="286" width="700" height="190" fill={GLYPH} />
      <rect x="3080" y="572" width="700" height="190" fill={GLYPH} />
    </svg>
  );
}
