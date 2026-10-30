// axe:copier-code — bouton « Copier » au survol (en haut à droite) de chaque bloc de code
// du chat et des blocs de commande / sortie des outils ; retour « Copié ».
import { useRef, useState, type HTMLAttributes, type ReactNode } from "react";

export async function copierTexte(texte: string): Promise<boolean> {
  try {
    // Le presse-papiers peut rester en attente (fenêtre sans focus) : 1 s au plus, puis repli.
    await Promise.race([
      navigator.clipboard.writeText(texte),
      new Promise((_, refus) => window.setTimeout(() => refus(new Error("délai")), 1000)),
    ]);
    return true;
  } catch {
    try {
      const zone = document.createElement("textarea");
      zone.value = texte;
      zone.style.position = "fixed";
      zone.style.opacity = "0";
      document.body.appendChild(zone);
      zone.select();
      const ok = document.execCommand("copy");
      zone.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

type Props = HTMLAttributes<HTMLPreElement> & { children?: ReactNode };

export function PreCopiable({ children, ...rest }: Props) {
  const ref = useRef<HTMLPreElement>(null);
  const [etat, setEtat] = useState<"repos" | "copie" | "echec">("repos");
  const survol = useRef(false);
  const minuterie = useRef<number | null>(null);
  const copier = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const ok = await copierTexte(ref.current?.innerText ?? "");
    setEtat(ok ? "copie" : "echec");
    // « Copié » reste affiché tant que le pointeur est sur le bloc, puis 2 s au plus.
    if (minuterie.current) window.clearTimeout(minuterie.current);
    minuterie.current = window.setTimeout(() => {
      if (!survol.current) setEtat("repos");
    }, 2000);
  };
  return (
    <div
      className="bloc-copie"
      data-etat={etat}
      onMouseEnter={() => {
        survol.current = true;
      }}
      onMouseLeave={() => {
        survol.current = false;
        if (etat !== "repos") window.setTimeout(() => setEtat("repos"), 600);
      }}
    >
      <pre ref={ref} {...rest}>
        {children}
      </pre>
      <button
        type="button"
        className="bloc-copie__btn"
        data-action="copier-code"
        aria-label="Copier"
        title="Copier"
        onClick={copier}
      >
        {etat === "copie" ? "Copié" : etat === "echec" ? "Échec" : "Copier"}
      </button>
    </div>
  );
}
