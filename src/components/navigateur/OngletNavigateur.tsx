// onglet « Navigateur » de l'IDE : barre (précédent, suivant, recharger, adresse,
// zoom, tailles d'écran, Choisir un élément, Ports, outils de développement), page d'accueil
// (serveurs du dossier) et volet de l'élément choisi. La page web elle-même est une vue
// native posée par l'appli sur la zone `.nav__page` : rien de l'interface ne doit passer
// dessus (volets à côté, vue cachée quand un menu ou une fenêtre la recouvre).
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Icon } from "@iconify/react";
import { loadUiZoom, onUiZoomChange } from "../../axe/zoom";
import { APPAREILS, versLogique, zonePage, zoomVoisin, type AppareilId, type Rect } from "./appareils";
import { resumeElement, stylesUtiles, texteElement } from "./design";
import { ETAT_VIDE, ecouterNavigateur, navigateurApi, type ElementChoisi, type EtatNavigateur, type PortOuvert, type Zone } from "./navigateurApi";
import { rectsFlottants, zoneRecouverte } from "./recouvrement";
import { envoyerAuChat } from "./versChat";
import "./navigateur.css";

type Props = {
  workspacePath: string;
  /** L'onglet est celui affiché : la page native peut se montrer. */
  actif: boolean;
  /** Conversation active : destinataire de « Envoyer à la conversation ». */
  conversationId: string;
  /** Lien ouvert depuis le chat ou le terminal (n change à chaque demande). */
  demande: { url: string; n: number } | null;
};

/** Une seule copie de l'onglet pilote la vue native (éditeur dupliqué : l'autre attend). */
let proprietaire: string | null = null;
/** Dernier lien du chat ou du terminal déjà ouvert (un nouveau montage ne le rouvre pas). */
let demandeTraitee = 0;

function notifier(genre: "info" | "echec", titre: string, texte: string, dossier: string) {
  window.dispatchEvent(new CustomEvent("ide-notification", { detail: { genre, titre, texte, dossier } }));
}

function memeZone(a: Zone | null, b: Zone | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.largeur - b.largeur) < 0.5 && Math.abs(a.hauteur - b.hauteur) < 0.5;
}

function pageVide(etat: EtatNavigateur): boolean {
  return !etat.ouvert || !etat.url || etat.url === "about:blank";
}

export function OngletNavigateur({ workspacePath, actif, conversationId, demande }: Props) {
  const id = useId();
  const [moi, setMoi] = useState(false);
  const [etat, setEtat] = useState<EtatNavigateur>(ETAT_VIDE);
  const [saisie, setSaisie] = useState("");
  const [edition, setEdition] = useState(false);
  const [appareil, setAppareil] = useState<AppareilId>("bureau");
  const [zoom, setZoom] = useState(1);
  const [volet, setVolet] = useState<"aucun" | "ports" | "element">("aucun");
  const [ports, setPorts] = useState<PortOuvert[] | null>(null);
  const [choix, setChoix] = useState<ElementChoisi | null>(null);
  const [avis, setAvis] = useState<{ genre: "info" | "erreur"; texte: string } | null>(null);
  const placeRef = useRef<HTMLDivElement>(null);
  const racineRef = useRef<HTMLDivElement>(null);
  const derniereZone = useRef<Zone | null | undefined>(undefined);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    if (proprietaire === null) proprietaire = id;
    setMoi(proprietaire === id);
    return () => {
      if (proprietaire === id) proprietaire = null;
    };
  }, [id]);

  // État de départ (vue déjà ouverte avant un nouveau montage) et événements.
  useEffect(() => {
    if (!moi) return;
    let vivant = true;
    void navigateurApi.etat().then((e) => vivant && e && setEtat(e)).catch(() => undefined);
    const arret = ecouterNavigateur({
      etat: (e) => setEtat(e),
      choix: (element) => {
        setChoix(element);
        setVolet("element");
      },
      telechargement: (t) => {
        if (!t.fini) return;
        const nom = t.fichier.split(/[\\/]/).pop() || t.fichier;
        if (t.ok) {
          setAvis({ genre: "info", texte: `Téléchargé dans Téléchargements : ${nom}` });
          notifier("info", "Téléchargement terminé", nom, workspacePath);
        } else {
          setAvis({ genre: "erreur", texte: `Téléchargement interrompu${nom ? ` : ${nom}` : ""}` });
          notifier("echec", "Téléchargement interrompu", nom, workspacePath);
        }
      },
    });
    return () => {
      vivant = false;
      arret();
    };
  }, [moi, workspacePath]);

  useEffect(() => {
    if (!edition) setSaisie(etat.url === "about:blank" ? "" : etat.url);
  }, [etat.url, edition]);

  useEffect(() => {
    if (etat.refus) setAvis({ genre: "erreur", texte: `Lien non ouvert dans le navigateur intégré : ${etat.refus}` });
  }, [etat.refus]);

  // Zoom de la page rendu à une vue recréée.
  useEffect(() => {
    if (etat.ouvert && zoomRef.current !== 1) void navigateurApi.zoom(zoomRef.current).catch(() => undefined);
  }, [etat.ouvert]);

  const aller = useCallback(async (adresse: string) => {
    if (!adresse.trim()) return;
    setAvis(null);
    try {
      const url = await navigateurApi.aller(adresse);
      setEdition(false);
      setSaisie(url);
    } catch (e) {
      setAvis({ genre: "erreur", texte: String(e) });
    }
  }, []);

  // Lien du chat ou du terminal.
  useEffect(() => {
    if (!demande || !moi || demande.n === demandeTraitee) return;
    demandeTraitee = demande.n;
    void aller(demande.url);
  }, [demande, moi, aller]);

  const chargerPorts = useCallback(async () => {
    try {
      setPorts(await navigateurApi.ports(workspacePath));
    } catch {
      setPorts([]);
    }
  }, [workspacePath]);

  const accueil = pageVide(etat);
  // Liste des ports : à l'accueil et quand le volet est ouvert (toutes les 5 s).
  useEffect(() => {
    if (!moi || !actif || (!accueil && volet !== "ports")) return;
    void chargerPorts();
    const minuterie = window.setInterval(() => void chargerPorts(), 5000);
    return () => window.clearInterval(minuterie);
  }, [moi, actif, accueil, volet, chargerPorts]);

  // Pose (ou cache) la vue native sur la zone de la page. Appelée à chaque changement de
  // taille, de recouvrement ou de zoom ; n'appelle l'appli que si la zone a changé.
  const placer = useCallback(() => {
    if (!moi) return;
    const place = placeRef.current;
    let zone: Zone | null = null;
    if (place && actif && !accueil && document.visibilityState !== "hidden") {
      const r = place.getBoundingClientRect();
      const rect: Rect = { left: r.left, top: r.top, width: r.width, height: r.height };
      const page = zonePage(rect, appareil, zoom);
      if (page.width >= 8 && page.height >= 8 && !zoneRecouverte(page, rectsFlottants(document, racineRef.current))) {
        zone = versLogique(page, loadUiZoom());
      }
    }
    if (derniereZone.current !== undefined && memeZone(derniereZone.current, zone)) return;
    derniereZone.current = zone;
    void navigateurApi.placer(workspacePath, zone).then((e) => e && setEtat(e)).catch(() => undefined);
  }, [moi, actif, accueil, appareil, zoom, workspacePath]);

  useEffect(() => {
    if (!moi) return;
    placer();
    // Onglet caché ou page d'accueil : vue cachée, rien à surveiller.
    if (!actif || accueil) return;
    let attente = 0;
    const bientot = () => {
      if (attente) return;
      attente = window.requestAnimationFrame(() => {
        attente = 0;
        placer();
      });
    };
    const taille = new ResizeObserver(bientot);
    if (placeRef.current) taille.observe(placeRef.current);
    const dom = new MutationObserver(bientot);
    dom.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "role", "data-active", "aria-modal"] });
    window.addEventListener("resize", bientot);
    document.addEventListener("visibilitychange", bientot);
    const arretZoom = onUiZoomChange(bientot);
    // Filet : un déplacement sans changement de taille (volet glissé) se voit en 0,4 s.
    const filet = window.setInterval(bientot, 400);
    return () => {
      taille.disconnect();
      dom.disconnect();
      window.removeEventListener("resize", bientot);
      document.removeEventListener("visibilitychange", bientot);
      arretZoom();
      window.clearInterval(filet);
      if (attente) window.cancelAnimationFrame(attente);
    };
  }, [moi, actif, accueil, placer]);

  // Onglet démonté (fermé, déplacé) : la vue native se cache.
  useEffect(
    () => () => {
      if (derniereZone.current) void navigateurApi.placer(workspacePath, null).catch(() => undefined);
      derniereZone.current = undefined;
    },
    [workspacePath],
  );

  const changerZoom = (sens: 1 | -1 | 0) => {
    const z = sens === 0 ? 1 : zoomVoisin(zoom, sens);
    setZoom(z);
    void navigateurApi.zoom(z).catch(() => undefined);
  };

  const action = (a: "precedent" | "suivant" | "recharger" | "arreter" | "devtools") => {
    setAvis(null);
    void navigateurApi.action(a).catch((e) => setAvis({ genre: "erreur", texte: String(e) }));
  };

  const basculerDesign = async () => {
    setAvis(null);
    try {
      setEtat(await navigateurApi.design(!etat.design));
    } catch (e) {
      setAvis({ genre: "erreur", texte: `Choisir un élément : ${String(e)}` });
    }
  };

  const envoyer = async () => {
    if (!choix) return;
    const texte = texteElement(choix);
    if (envoyerAuChat(conversationId, texte)) {
      setAvis({ genre: "info", texte: "Élément ajouté à la saisie de la conversation." });
      return;
    }
    try {
      await navigator.clipboard.writeText(texte);
      setAvis({ genre: "info", texte: "Conversation fermée : texte copié, collez-le dans la saisie." });
    } catch {
      setAvis({ genre: "erreur", texte: "Conversation fermée et presse-papiers indisponible." });
    }
  };

  const copier = async () => {
    if (!choix) return;
    try {
      await navigator.clipboard.writeText(texteElement(choix));
      setAvis({ genre: "info", texte: "Copié." });
    } catch {
      setAvis({ genre: "erreur", texte: "Presse-papiers indisponible." });
    }
  };

  const soumettre = (e: FormEvent) => {
    e.preventDefault();
    void aller(saisie);
  };

  const toucheAdresse = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setEdition(false);
      setSaisie(etat.url === "about:blank" ? "" : etat.url);
      (e.target as HTMLInputElement).blur();
    }
  };

  const styles = useMemo(() => (choix ? stylesUtiles(choix.styles).slice(0, 12) : []), [choix]);

  if (!moi) {
    return (
      <div className="nav nav--autre">
        <p className="nav__vide">Le navigateur est affiché dans l'autre copie de l'éditeur.</p>
      </div>
    );
  }

  const enChargement = etat.chargement && !accueil;
  return (
    <div className="nav" ref={racineRef} data-design={etat.design ? "true" : "false"}>
      <div className="nav__barre" role="toolbar" aria-label="Navigateur">
        <button type="button" className="nav__btn" onClick={() => action("precedent")} disabled={accueil} title="Précédent" aria-label="Précédent">
          <Icon icon="solar:arrow-left-linear" width={15} height={15} />
        </button>
        <button type="button" className="nav__btn" onClick={() => action("suivant")} disabled={accueil} title="Suivant" aria-label="Suivant">
          <Icon icon="solar:arrow-right-linear" width={15} height={15} />
        </button>
        <button
          type="button"
          className="nav__btn"
          onClick={() => action(enChargement ? "arreter" : "recharger")}
          disabled={accueil}
          title={enChargement ? "Arrêter le chargement" : "Recharger"}
          aria-label={enChargement ? "Arrêter le chargement" : "Recharger"}
        >
          <Icon icon={enChargement ? "solar:close-circle-linear" : "solar:refresh-linear"} width={15} height={15} />
        </button>
        <form className="nav__adresse" onSubmit={soumettre} data-chargement={enChargement ? "true" : "false"}>
          <Icon icon="solar:global-linear" width={13} height={13} className="nav__adresse-icone" />
          <input
            className="nav__champ"
            aria-label="Adresse"
            placeholder="Adresse ou recherche (localhost:5173…)"
            value={saisie}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setEdition(true);
              setSaisie(e.target.value);
            }}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setEdition(false)}
            onKeyDown={toucheAdresse}
          />
        </form>
        <div className="nav__groupe" role="group" aria-label="Zoom de la page">
          <button type="button" className="nav__btn" onClick={() => changerZoom(-1)} title="Zoom arrière" aria-label="Zoom arrière">
            <Icon icon="solar:minus-circle-linear" width={14} height={14} />
          </button>
          <button type="button" className="nav__btn nav__btn--valeur" onClick={() => changerZoom(0)} title="Zoom à 100 %" aria-label={`Zoom ${Math.round(zoom * 100)} %, revenir à 100 %`}>
            {`${Math.round(zoom * 100)}\u00a0%`}
          </button>
          <button type="button" className="nav__btn" onClick={() => changerZoom(1)} title="Zoom avant" aria-label="Zoom avant">
            <Icon icon="solar:add-circle-linear" width={14} height={14} />
          </button>
        </div>
        <div className="nav__groupe" role="group" aria-label="Taille d'écran">
          {APPAREILS.map((a) => (
            <button
              key={a.id}
              type="button"
              className="nav__btn"
              data-appareil={a.id}
              data-active={appareil === a.id ? "true" : "false"}
              aria-pressed={appareil === a.id}
              onClick={() => setAppareil(a.id)}
              title={a.libelle}
              aria-label={a.libelle}
            >
              <Icon icon={a.icone} width={14} height={14} />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="nav__btn"
          data-action="design"
          data-active={etat.design ? "true" : "false"}
          aria-pressed={etat.design}
          onClick={() => void basculerDesign()}
          disabled={accueil}
          title={etat.design ? "Arrêter de choisir (Échap dans la page)" : "Choisir un élément de la page pour la conversation"}
          aria-label="Choisir un élément"
        >
          <Icon icon="solar:cursor-square-linear" width={15} height={15} />
        </button>
        <button
          type="button"
          className="nav__btn"
          data-action="ports"
          data-active={volet === "ports" ? "true" : "false"}
          aria-pressed={volet === "ports"}
          onClick={() => setVolet((v) => (v === "ports" ? "aucun" : "ports"))}
          title="Ports ouverts par ce dossier"
          aria-label="Ports"
        >
          <Icon icon="solar:server-square-linear" width={15} height={15} />
          {ports && ports.length > 0 ? <span className="nav__compte">{ports.length}</span> : null}
        </button>
        <button type="button" className="nav__btn" data-action="devtools" onClick={() => action("devtools")} disabled={accueil} title="Outils de développement de la page" aria-label="Outils de développement">
          <Icon icon="solar:code-square-linear" width={15} height={15} />
        </button>
      </div>
      {avis ? (
        <div className="nav__avis" data-genre={avis.genre} role={avis.genre === "erreur" ? "alert" : "status"}>
          <span className="nav__avis-texte" title={avis.texte}>{avis.texte}</span>
          <button type="button" className="nav__btn" onClick={() => setAvis(null)} title="Fermer" aria-label="Fermer le message">
            <Icon icon="solar:close-circle-linear" width={13} height={13} />
          </button>
        </div>
      ) : null}
      {etat.design ? (
        <div className="nav__avis" data-genre="info" role="status">
          <span className="nav__avis-texte">Survolez la page puis cliquez un élément. Échap (dans la page) annule.</span>
        </div>
      ) : null}
      <div className="nav__corps">
        <div className="nav__place" ref={placeRef} data-appareil={appareil}>
          {accueil ? (
            <Accueil ports={ports} onOuvrir={(url) => void aller(url)} onActualiser={() => void chargerPorts()} />
          ) : (
            <div className="nav__page" aria-label={etat.titre || etat.url} />
          )}
        </div>
        {volet === "ports" ? (
          <aside className="nav__volet" aria-label="Ports">
            <div className="nav__volet-tete">
              <span className="nav__volet-titre">Ports</span>
              <button type="button" className="nav__btn" onClick={() => void chargerPorts()} title="Actualiser" aria-label="Actualiser les ports">
                <Icon icon="solar:refresh-linear" width={14} height={14} />
              </button>
              <button type="button" className="nav__btn" onClick={() => setVolet("aucun")} title="Fermer" aria-label="Fermer les ports">
                <Icon icon="solar:close-circle-linear" width={14} height={14} />
              </button>
            </div>
            <ListePorts ports={ports} onOuvrir={(url) => void aller(url)} />
          </aside>
        ) : null}
        {volet === "element" && choix ? (
          <aside className="nav__volet" aria-label="Élément choisi">
            <div className="nav__volet-tete">
              <span className="nav__volet-titre" title={choix.selecteur}>{resumeElement(choix)}</span>
              <button type="button" className="nav__btn" onClick={() => setVolet("aucun")} title="Fermer" aria-label="Fermer l'élément choisi">
                <Icon icon="solar:close-circle-linear" width={14} height={14} />
              </button>
            </div>
            <div className="nav__element">
              <div className="nav__ligne"><span>Taille</span><span>{Math.round(choix.largeur)} × {Math.round(choix.hauteur)} px</span></div>
              <div className="nav__ligne"><span>Sélecteur</span><code title={choix.selecteur}>{choix.selecteur || choix.balise}</code></div>
              {styles.map(([nom, valeur]) => (
                <div className="nav__ligne" key={nom}><span>{nom}</span><code title={valeur}>{valeur}</code></div>
              ))}
              {choix.html ? <pre className="nav__html">{choix.html}</pre> : null}
            </div>
            <div className="nav__volet-pied">
              <button type="button" className="nav__bouton nav__bouton--principal" data-action="envoyer" onClick={() => void envoyer()}>
                <Icon icon="solar:chat-round-line-linear" width={14} height={14} />
                <span>Envoyer à la conversation</span>
              </button>
              <button type="button" className="nav__bouton" onClick={() => void copier()} title="Copier le texte" aria-label="Copier">
                <Icon icon="solar:copy-linear" width={14} height={14} />
              </button>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function ListePorts({ ports, onOuvrir }: { ports: PortOuvert[] | null; onOuvrir: (url: string) => void }) {
  if (ports === null) return <p className="nav__vide">Recherche des serveurs…</p>;
  if (!ports.length) return <p className="nav__vide">Aucun serveur lancé depuis ce dossier.</p>;
  return (
    <ul className="nav__ports">
      {ports.map((p) => (
        <li key={p.port} className="nav__port" data-port={p.port}>
          <span className="nav__port-nom" title={`${p.adresse}:${p.port} — ${p.processus} (processus ${p.pid})`}>
            <code>localhost:{p.port}</code>
            <span className="nav__port-processus">{p.processus || `processus ${p.pid}`}</span>
          </span>
          <button type="button" className="nav__bouton" onClick={() => onOuvrir(p.url)} title={`Ouvrir ${p.url} dans le navigateur`} aria-label={`Ouvrir le port ${p.port} dans le navigateur`}>
            <Icon icon="solar:square-arrow-right-up-linear" width={14} height={14} />
            <span>Ouvrir</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Accueil({ ports, onOuvrir, onActualiser }: { ports: PortOuvert[] | null; onOuvrir: (url: string) => void; onActualiser: () => void }) {
  return (
    <div className="nav__accueil">
      <div className="nav__accueil-bloc">
        <h2 className="nav__accueil-titre">
          <Icon icon="solar:global-linear" width={18} height={18} />
          <span>Navigateur</span>
        </h2>
        <p className="nav__accueil-texte">Tapez une adresse en haut, ou ouvrez un serveur lancé depuis ce dossier.</p>
        <div className="nav__volet-tete">
          <span className="nav__volet-titre">Serveurs de ce dossier</span>
          <button type="button" className="nav__btn" onClick={onActualiser} title="Actualiser" aria-label="Actualiser les ports">
            <Icon icon="solar:refresh-linear" width={14} height={14} />
          </button>
        </div>
        <ListePorts ports={ports} onOuvrir={onOuvrir} />
      </div>
    </div>
  );
}
