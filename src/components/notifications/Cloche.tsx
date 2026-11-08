// Cloche de la barre du haut : événements récents (fini, attend votre réponse,
// échec, informations des autres lots), non-lus, « Tout marquer lu ». Clic sur un événement =
// ouvrir sa conversation. Clavier : Entrée / Espace ouvre, flèches haut / bas pour parcourir, Échap ferme.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { notificationsApi, type EvenementNotif } from "./notificationsApi";
import { useCentreNotifications } from "./store";
import { cibleDe, ouvrirCible } from "./ouvrir";
import { depuisQuand, nomDossier } from "../agents/agentsTableau";
import "./notifications.css";

const LIBELLE_GENRE: Record<string, string> = {
  fini: "Fini",
  attente: "Attend votre réponse",
  echec: "Échec",
  info: "Information",
};

/** Texte d'un événement sans le rappel de son genre (déjà dit par la pastille). */
function texteSansGenre(ev: EvenementNotif): string {
  return ev.texte.replace(/^(Attend votre réponse|Échec|Fini)\s*[:.]\s*/u, "").trim();
}

export function Cloche() {
  const { evenements, nonLus } = useCentreNotifications();
  const [ouvert, setOuvert] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const boutonRef = useRef<HTMLButtonElement | null>(null);
  const panneauRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!ouvert || !boutonRef.current) return;
    const placer = () => {
      const r = boutonRef.current?.getBoundingClientRect();
      if (r) setPosition({ top: Math.round(r.bottom + 6), right: Math.max(8, Math.round(window.innerWidth - r.right)) });
    };
    placer();
    window.addEventListener("resize", placer);
    return () => window.removeEventListener("resize", placer);
  }, [ouvert]);

  useEffect(() => {
    if (!ouvert) return;
    const dehors = (e: PointerEvent) => {
      const cible = e.target as Node | null;
      if (cible && (panneauRef.current?.contains(cible) || boutonRef.current?.contains(cible))) return;
      setOuvert(false);
    };
    const touche = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOuvert(false);
      boutonRef.current?.focus();
    };
    window.addEventListener("pointerdown", dehors, true);
    window.addEventListener("keydown", touche, true);
    const id = window.requestAnimationFrame(() => {
      const panneau = panneauRef.current;
      (panneau?.querySelector<HTMLElement>(".axe-cloche__item") ?? panneau?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
    });
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener("pointerdown", dehors, true);
      window.removeEventListener("keydown", touche, true);
    };
  }, [ouvert]);

  const ouvrirEvenement = (ev: EvenementNotif) => {
    if (!ev.lu) void notificationsApi.marquerLu(ev.cle).catch(() => undefined);
    const cible = cibleDe(ev);
    if (cible) {
      setOuvert(false);
      ouvrirCible(cible);
    }
  };

  const parcourir = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const elements = Array.from(panneauRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
    if (!elements.length) return;
    e.preventDefault();
    const i = elements.indexOf(document.activeElement as HTMLElement);
    const suivant = e.key === "ArrowDown" ? (i + 1) % elements.length : (i - 1 + elements.length) % elements.length;
    elements[suivant]?.focus();
  };

  const maintenant = Date.now();
  const libelle = nonLus ? `Notifications : ${nonLus} non lue${nonLus > 1 ? "s" : ""}` : "Notifications";
  return (
    <>
      <button
        ref={boutonRef}
        type="button"
        className="titlebar__btn axe-cloche__bouton"
        data-action="notifications"
        data-on={ouvert ? "true" : "false"}
        data-non-lus={nonLus || undefined}
        aria-label={libelle}
        aria-haspopup="dialog"
        aria-expanded={ouvert}
        title={libelle}
        onClick={() => setOuvert((v) => !v)}
      >
        <Icon icon="solar:bell-linear" width={12} height={12} />
        {nonLus ? <span className="axe-cloche__compte">{nonLus > 99 ? "99+" : nonLus}</span> : null}
      </button>
      {ouvert && position
        ? createPortal(
            <div
              ref={panneauRef}
              className="axe-cloche__panneau"
              role="dialog"
              aria-label="Notifications"
              style={{ top: position.top, right: position.right }}
              onKeyDown={parcourir}
            >
              <div className="axe-cloche__entete">
                <strong>Notifications</strong>
                <button type="button" className="axe-cloche__tout" disabled={!nonLus} onClick={() => void notificationsApi.marquerLu().catch(() => undefined)}>
                  Tout marquer lu
                </button>
              </div>
              {evenements.length ? (
                <ul className="axe-cloche__liste">
                  {evenements.slice(0, 50).map((ev) => {
                    const texte = texteSansGenre(ev);
                    const details = [LIBELLE_GENRE[ev.genre] ?? ev.genre, ev.dossier && !ev.libre ? nomDossier(ev.dossier) : "", depuisQuand(ev.ts, maintenant)].filter(Boolean);
                    return (
                      <li key={ev.cle}>
                        <button
                          type="button"
                          className="axe-cloche__item"
                          data-genre={ev.genre}
                          data-lu={ev.lu ? "true" : "false"}
                          title={ev.sessionId ? "Ouvrir la conversation" : undefined}
                          onClick={() => ouvrirEvenement(ev)}
                        >
                          <span className="axe-cloche__pastille" data-genre={ev.genre} aria-hidden />
                          <span className="axe-cloche__corps">
                            <span className="axe-cloche__titre">{ev.titre || LIBELLE_GENRE[ev.genre] || "Notification"}</span>
                            {texte ? <span className="axe-cloche__texte">{texte}</span> : null}
                            <span className="axe-cloche__details">{details.join(" · ")}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="axe-cloche__vide">Rien de nouveau.</p>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
