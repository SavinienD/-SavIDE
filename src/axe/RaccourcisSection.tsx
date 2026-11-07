import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  RACCOURCIS,
  combinaisonAffichee,
  definirRaccourci,
  ecouterRaccourcis,
  estModifiable,
  estModifie,
  lireCombinaison,
  partiesCombinaison,
  reinitialiserRaccourcis,
  suspendreRaccourcis,
  verifierCombinaison,
  versionRaccourcis,
  type Raccourci,
  type RaccourciId,
} from "./raccourcis";
import { estMac } from "../lib/plateforme";
import "./raccourcis.css";

/** Settings > Raccourcis : lu dans le registre (axe/raccourcis.ts).
 *  Chaque raccourci à vraie touche se change d'un clic : on tape la combinaison,
 *  elle est vérifiée (conflit, touche réservée) puis enregistrée pour toute l'appli. */
export function RaccourcisSection() {
  const mac = estMac();
  const version = useSyncExternalStore(ecouterRaccourcis, versionRaccourcis);
  const [q, setQ] = useState("");
  const [enCours, setEnCours] = useState<RaccourciId | null>(null);
  const [apercu, setApercu] = useState("");
  const [alerte, setAlerte] = useState<{ id: RaccourciId; texte: string } | null>(null);

  const groupes = useMemo(() => {
    const n = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const f = n(q.trim());
    const liste = RACCOURCIS.filter(
      (r) => !f || n(`${r.libelle} ${r.combinaison} ${combinaisonAffichee(r)} ${r.categorie}`).includes(f),
    );
    const m = new Map<string, Raccourci[]>();
    for (const r of liste) m.set(r.categorie, [...(m.get(r.categorie) ?? []), r]);
    return [...m.entries()];
    // version : relire les combinaisons après un changement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, version]);

  const arreter = useCallback(() => {
    setEnCours(null);
    setApercu("");
    suspendreRaccourcis(false);
  }, []);

  // Enregistrement : la prochaine combinaison tapée (Échap annule).
  useEffect(() => {
    if (!enCours) return;
    suspendreRaccourcis(true);
    const surTouche = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        arreter();
        return;
      }
      const lue = lireCombinaison(e, mac);
      if (!lue) {
        const mods = [e.ctrlKey ? (mac ? "⌃" : "Ctrl") : "", e.metaKey && mac ? "⌘" : "", e.altKey ? (mac ? "⌥" : "Alt") : "", e.shiftKey ? (mac ? "⇧" : "Maj") : ""];
        setApercu(mods.filter(Boolean).join(mac ? "" : " + "));
        return;
      }
      const erreur = verifierCombinaison(enCours, lue, mac);
      if (erreur) setAlerte({ id: enCours, texte: erreur });
      else {
        definirRaccourci(enCours, lue);
        setAlerte(null);
      }
      arreter();
    };
    const annuler = () => arreter();
    window.addEventListener("keydown", surTouche, true);
    window.addEventListener("blur", annuler);
    return () => {
      window.removeEventListener("keydown", surTouche, true);
      window.removeEventListener("blur", annuler);
      suspendreRaccourcis(false);
    };
  }, [enCours, mac, arreter]);

  const modifies = RACCOURCIS.some((r) => estModifie(r.id));

  return (
    <div className="axe-appearance axe-raccourcis" data-mac={mac ? "true" : "false"} data-version={version}>
      <header>
        <h2>Raccourcis</h2>
        <p className="axe-appearance__hint">
          Cliquez sur une combinaison pour la changer, puis tapez la nouvelle.{mac ? " ⌘ = Cmd, ⌥ = Option, ⇧ = Maj, ⌃ = Contrôle." : ""}
        </p>
      </header>
      <div className="axe-raccourcis__outils">
        <input
          type="search"
          className="axe-raccourcis__recherche"
          placeholder="Rechercher une action ou une touche…"
          aria-label="Rechercher un raccourci"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {modifies ? (
          <button type="button" className="axe-raccourcis__tout-defaut" title="Remettre tous les raccourcis par défaut" onClick={() => { reinitialiserRaccourcis(); setAlerte(null); }}>
            Tout par défaut
          </button>
        ) : null}
      </div>
      {groupes.length === 0 ? (
        <p className="axe-appearance__hint">Aucun raccourci ne correspond.</p>
      ) : (
        groupes.map(([categorie, liste]) => (
          <section key={categorie} className="axe-raccourcis__groupe">
            <h3>{categorie}</h3>
            <ul className="axe-raccourcis__liste">
              {liste.map((r) => {
                const modifiable = estModifiable(r);
                const ecoute = enCours === r.id;
                const parties = partiesCombinaison(r, mac);
                const geste = !r.touche.touches.length && /clic|glisser/i.test(r.combinaison);
                const touches = (
                  <span className="axe-raccourcis__touches">
                    {ecoute ? (
                      <span className="axe-raccourcis__ecoute">{apercu ? `${apercu}…` : "Tapez la combinaison…"}</span>
                    ) : geste ? (
                      <span className="axe-raccourcis__geste">{r.combinaison}</span>
                    ) : (
                      parties.map((p, i) => <kbd key={i}>{p}</kbd>)
                    )}
                  </span>
                );
                return (
                  <li
                    key={r.id}
                    className="axe-raccourcis__ligne"
                    data-raccourci={r.id}
                    data-combinaison={parties.join(mac ? "" : "+")}
                    data-modifie={estModifie(r.id) ? "true" : undefined}
                  >
                    <span className="axe-raccourcis__libelle">
                      {r.libelle}
                      {r.windowsSeulement ? " (Windows)" : r.macSeulement ? " (macOS)" : ""}
                    </span>
                    <span className="axe-raccourcis__droite">
                      {estModifie(r.id) && !ecoute ? (
                        <button type="button" className="axe-raccourcis__defaut" onClick={() => { definirRaccourci(r.id, null); setAlerte(null); }}>
                          Par défaut
                        </button>
                      ) : null}
                      {modifiable ? (
                        <button
                          type="button"
                          className="axe-raccourcis__combo"
                          data-ecoute={ecoute ? "true" : undefined}
                          title={ecoute ? "Échap pour annuler" : "Changer ce raccourci"}
                          aria-label={`Changer le raccourci : ${r.libelle}`}
                          onClick={() => {
                            setAlerte(null);
                            setApercu("");
                            setEnCours(ecoute ? null : r.id);
                          }}
                        >
                          {touches}
                        </button>
                      ) : (
                        <span className="axe-raccourcis__combo" data-fixe="true">{touches}</span>
                      )}
                    </span>
                    {ecoute ? <span className="axe-raccourcis__aide">Échap pour annuler</span> : null}
                    {alerte?.id === r.id ? (
                      <span className="axe-raccourcis__alerte" role="alert">{alerte.texte}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
