// axe:robustesse — Filet de sécurité de l'interface (18/10/2026).
// Sans lui, une exception pendant l'affichage démonte TOUTE l'appli (React) : il ne reste que le fond de la fenêtre
// (« écran bleu ») et il faut fermer l'appli. Avec lui : la zone touchée affiche l'erreur, le reste reste utilisable,
// et le détail peut être copié pour le support.
import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from "react";

type Props = { label: string; children: ReactNode };
type State = { error: Error | null; stack: string };

const boite: CSSProperties = {
  margin: 16, padding: 16, borderRadius: 8, border: "1px solid rgba(248,113,113,0.5)",
  background: "rgba(248,113,113,0.08)", color: "#fecaca", fontSize: 13, lineHeight: 1.5, maxHeight: "80vh", overflow: "auto",
};
const pre: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11, opacity: 0.85, margin: "8px 0" };
const bouton: CSSProperties = {
  marginRight: 8, padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.06)", color: "inherit", cursor: "pointer", font: "inherit",
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}]`, error, info.componentStack);
    this.setState({ stack: info.componentStack ?? "" });
  }

  private detail() {
    const e = this.state.error;
    return `${this.props.label} : ${e?.name ?? "Erreur"} : ${e?.message ?? ""}\n${e?.stack ?? ""}\n${this.state.stack}`;
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={boite}>
        <strong>Une erreur d'affichage est survenue ({this.props.label}).</strong>
        <div>Le reste de l'appli fonctionne. « Réessayer » réaffiche cette zone ; envoyez le détail à l'administrateur si cela recommence.</div>
        <pre style={pre}>{this.detail().slice(0, 4000)}</pre>
        <button type="button" style={bouton} onClick={() => this.setState({ error: null, stack: "" })}>Réessayer</button>
        <button type="button" style={bouton} onClick={() => void navigator.clipboard?.writeText(this.detail()).catch(() => undefined)}>
          Copier le détail
        </button>
        <button type="button" style={bouton} onClick={() => window.location.reload()}>Recharger l'appli</button>
      </div>
    );
  }
}

// axe:robustesse — La racine (html, body, #root) ne doit jamais défiler : la mise en page est en hauteur fixe et sans
// barre de défilement. Si un scrollIntoView ou le focus d'un champ la fait défiler, toute l'interface sort de l'écran
// (fond seul visible, impossible de revenir). On la remet en place aussitôt.
export function verrouillerRacine(): void {
  const racines = () => [document.documentElement, document.body, document.getElementById("root")];
  document.addEventListener(
    "scroll",
    (event) => {
      const cible = event.target === document ? document.documentElement : event.target;
      if (!racines().includes(cible as HTMLElement)) return;
      for (const el of racines()) {
        if (el && (el.scrollTop !== 0 || el.scrollLeft !== 0)) {
          el.scrollTop = 0;
          el.scrollLeft = 0;
        }
      }
    },
    true,
  );
}
