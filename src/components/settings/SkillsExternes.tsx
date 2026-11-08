// Réglages > Skills, bouton « Importer » : skills de Claude Code,
// Codex et ~/.agents copiés dans le harnais, ou installés depuis une adresse
// (dépôt git, archive .zip) après aperçu. Mises à jour proposées quand la source change.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { cloudConnectionFromPath } from "../../lib/ipc";
import { interopApi } from "../../lib/interopApi";
import {
  adresseValide,
  cochable,
  grouperParRacine,
  libelleEtat,
  libelleOutil,
  libelleVersion,
  nombreMisesAJour,
  resumeRapport,
  selectionInitiale,
  taille,
  type ApercuUrl,
  type SkillExterne,
  type SkillInstalle,
} from "../../lib/skillsExternes";
import "./interop.css";

type Props = { workspacePath: string; onChange?: () => void };
type Onglet = "outils" | "url";

export function SkillsExternes({ workspacePath, onChange }: Props) {
  const [ouvert, setOuvert] = useState(false);
  const [onglet, setOnglet] = useState<Onglet>("outils");
  const [majs, setMajs] = useState(0);
  const cloud = !!cloudConnectionFromPath(workspacePath);

  useEffect(() => {
    if (cloud || !workspacePath) return;
    let vivant = true;
    interopApi
      .skillsLister(workspacePath)
      .then((l) => vivant && setMajs(nombreMisesAJour(l)))
      .catch(() => undefined);
    return () => {
      vivant = false;
    };
  }, [workspacePath, cloud, ouvert]);

  if (cloud || !workspacePath) return null;
  return (
    <>
      <button
        type="button"
        className="settings-pane__btn"
        data-action="importer-skills"
        title={majs ? `${majs} mise(s) à jour de skills importés` : "Importer des skills de Claude Code, de Codex ou d'une adresse"}
        onClick={() => setOuvert(true)}
      >
        <Icon icon="solar:import-linear" width={13} height={13} />
        <span>Importer</span>
        {majs ? <span className="axe-interop__badge">{majs}</span> : null}
      </button>
      {ouvert ? (
        <div
          className="axe-harnais-modal"
          role="presentation"
          onKeyDown={(e) => e.key === "Escape" && setOuvert(false)}
          onMouseDown={(e) => e.target === e.currentTarget && setOuvert(false)}
        >
          <div className="axe-harnais-boite axe-interop__boite" role="dialog" aria-modal="true" aria-labelledby="axe-interop-skills-titre">
            <h3 id="axe-interop-skills-titre">Importer des skills</h3>
            <div className="axe-interop__onglets" role="tablist" aria-label="Source des skills">
              <button type="button" role="tab" aria-selected={onglet === "outils"} data-onglet="outils" onClick={() => setOnglet("outils")}>
                Claude Code, Codex
              </button>
              <button type="button" role="tab" aria-selected={onglet === "url"} data-onglet="url" onClick={() => setOnglet("url")}>
                Depuis une adresse
              </button>
            </div>
            {onglet === "outils" ? (
              <ImportOutils workspacePath={workspacePath} onChange={onChange} onFermer={() => setOuvert(false)} />
            ) : (
              <InstallUrl workspacePath={workspacePath} onChange={onChange} onFermer={() => setOuvert(false)} />
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

function ImportOutils({ workspacePath, onChange, onFermer }: { workspacePath: string; onChange?: () => void; onFermer: () => void }) {
  const [liste, setListe] = useState<SkillExterne[] | null>(null);
  const [choix, setChoix] = useState<Set<string>>(new Set());
  const [occupe, setOccupe] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      const l = await interopApi.skillsLister(workspacePath);
      setListe(l);
      setChoix(selectionInitiale(l, (s) => s.chemin));
      setErreur(null);
    } catch (e) {
      setErreur(String(e));
      setListe([]);
    }
  }, [workspacePath]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const basculer = (chemin: string) =>
    setChoix((avant) => {
      const apres = new Set(avant);
      if (apres.has(chemin)) apres.delete(chemin);
      else apres.add(chemin);
      return apres;
    });

  const importer = async () => {
    setOccupe(true);
    setMessage(null);
    try {
      const r = await interopApi.skillsImporter(workspacePath, [...choix]);
      setMessage(resumeRapport(r));
      onChange?.();
      await charger();
    } catch (e) {
      setErreur(String(e));
    } finally {
      setOccupe(false);
    }
  };

  if (!liste) return <p className="axe-harness__muted">Recherche dans les dossiers de Claude Code et de Codex…</p>;
  return (
    <>
      {liste.length === 0 ? (
        <p className="axe-harness__muted">Aucun skill dans ~/.claude/skills, .claude/skills, ~/.codex/skills ni ~/.agents/skills.</p>
      ) : (
        grouperParRacine(liste).map((g) => (
          <section key={g.racine} className="axe-interop__groupe">
            <h4>
              {libelleOutil(g.outil)} <code>{g.racine}</code>
            </h4>
            <ul className="axe-interop__liste">
              {g.skills.map((s) => (
                <li key={s.chemin} data-etat={s.etat} title={s.chemin}>
                  <label>
                    <input type="checkbox" disabled={!cochable(s.etat) || occupe} checked={choix.has(s.chemin)} onChange={() => basculer(s.chemin)} />
                    <strong>{s.nomSource}</strong>
                    {s.description ? <span className="axe-interop__desc">{s.description}</span> : null}
                  </label>
                  <span className="axe-interop__etat" data-etat={s.etat}>{libelleEtat(s.etat)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <p className="axe-harness__muted">
        Copie dans le harnais (global pour ~/…, projet pour .claude/skills), source notée : une mise à jour est proposée quand elle change.
      </p>
      {message ? <p className="axe-harness__status" role="status">{message}</p> : null}
      {erreur ? <p className="axe-harness__error">{erreur}</p> : null}
      <div className="axe-harness__actions">
        <button
          type="button"
          autoFocus
          className="axe-harness__btn axe-harness__btn--primary"
          data-action="importer-confirmer"
          disabled={occupe || choix.size === 0}
          onClick={() => void importer()}
        >
          {occupe ? "Import…" : `Importer (${choix.size})`}
        </button>
        <button type="button" className="axe-harness__btn" onClick={onFermer}>
          Fermer
        </button>
      </div>
    </>
  );
}

function InstallUrl({ workspacePath, onChange, onFermer }: { workspacePath: string; onChange?: () => void; onFermer: () => void }) {
  const [url, setUrl] = useState("");
  const [apercu, setApercu] = useState<ApercuUrl | null>(null);
  const [choix, setChoix] = useState<Set<string>>(new Set());
  const [portee, setPortee] = useState<"global" | "project">("global");
  const [installes, setInstalles] = useState<SkillInstalle[]>([]);
  const [occupe, setOccupe] = useState<string | null>(null);
  const [aRetirer, setARetirer] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const champ = useRef<HTMLInputElement>(null);

  const chargerInstalles = useCallback(async () => {
    try {
      setInstalles(await interopApi.skillsUrlInstalles(workspacePath));
    } catch {
      setInstalles([]);
    }
  }, [workspacePath]);

  useEffect(() => {
    void chargerInstalles();
    champ.current?.focus();
  }, [chargerInstalles]);

  const voir = async (adresse: string) => {
    const refus = adresseValide(adresse);
    setMessage(null);
    if (refus) {
      setErreur(refus);
      return;
    }
    setUrl(adresse);
    setOccupe("apercu");
    setErreur(null);
    setApercu(null);
    try {
      const a = await interopApi.skillsUrlApercu(workspacePath, adresse.trim());
      setApercu(a);
      setChoix(selectionInitiale(a.skills, (s) => s.sousDossier));
    } catch (e) {
      setErreur(String(e));
    } finally {
      setOccupe(null);
    }
  };

  const installer = async () => {
    if (!apercu) return;
    setOccupe("installer");
    setErreur(null);
    try {
      const r = await interopApi.skillsUrlInstaller(workspacePath, apercu.jeton, [...choix], portee);
      setMessage(resumeRapport(r, "installé"));
      setApercu(null);
      onChange?.();
      await chargerInstalles();
    } catch (e) {
      setErreur(String(e));
    } finally {
      setOccupe(null);
    }
  };

  const desinstaller = async (id: string) => {
    if (aRetirer !== id) {
      setARetirer(id);
      return;
    }
    setOccupe(`retirer:${id}`);
    try {
      await interopApi.skillsDesinstaller(workspacePath, id);
      setMessage(`« ${id} » désinstallé.`);
      setARetirer(null);
      onChange?.();
      await chargerInstalles();
    } catch (e) {
      setErreur(String(e));
    } finally {
      setOccupe(null);
    }
  };

  return (
    <>
      <form
        className="axe-interop__url"
        onSubmit={(e) => {
          e.preventDefault();
          void voir(url);
        }}
      >
        <input
          ref={champ}
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/…/skills ou …/skill.zip"
          aria-label="Adresse du dépôt git ou de l'archive .zip"
          spellCheck={false}
        />
        <button type="submit" className="axe-harness__btn" data-action="apercu-url" disabled={occupe !== null}>
          {occupe === "apercu" ? "Téléchargement…" : "Aperçu"}
        </button>
      </form>
      {apercu ? (
        <>
          <p className="axe-harness__banner" role="note">
            Contenu non vérifié : un skill donne des consignes à l'agent et peut contenir des scripts. Lisez-le avant de l'installer.
          </p>
          <ul className="axe-interop__liste">
            {apercu.skills.map((s) => (
              <li key={s.sousDossier || "racine"} data-etat={s.etat} className="axe-interop__apercu">
                <label>
                  <input
                    type="checkbox"
                    disabled={!cochable(s.etat) || occupe !== null}
                    checked={choix.has(s.sousDossier)}
                    onChange={() =>
                      setChoix((avant) => {
                        const apres = new Set(avant);
                        if (apres.has(s.sousDossier)) apres.delete(s.sousDossier);
                        else apres.add(s.sousDossier);
                        return apres;
                      })
                    }
                  />
                  <strong>{s.nomSource}</strong>
                  {s.description ? <span className="axe-interop__desc">{s.description}</span> : null}
                </label>
                <span className="axe-interop__etat" data-etat={s.etat}>{libelleEtat(s.etat)}</span>
                <details className="axe-interop__lire">
                  <summary>
                    {libelleVersion(s, apercu)} · {s.fichiers.length} fichier{s.fichiers.length > 1 ? "s" : ""} · {taille(s.octets)}
                  </summary>
                  <pre>{s.extrait}</pre>
                  {s.fichiers.length > 1 ? <p className="axe-harness__muted">{s.fichiers.slice(0, 20).join(", ")}{s.fichiers.length > 20 ? "…" : ""}</p> : null}
                </details>
              </li>
            ))}
          </ul>
          <label className="axe-harnais-import__portee">
            <span>Installer dans</span>
            <select value={portee} onChange={(e) => setPortee(e.target.value as "global" | "project")}>
              <option value="global">le harnais global</option>
              <option value="project">ce projet</option>
            </select>
          </label>
        </>
      ) : null}
      {installes.length ? (
        <section className="axe-interop__groupe">
          <h4>Installés depuis une adresse</h4>
          <ul className="axe-interop__liste">
            {installes.map((s) => (
              <li key={s.id} title={s.url}>
                <span className="axe-interop__installe">
                  <strong>{s.id}</strong>
                  <span className="axe-interop__desc">{s.url}{s.version ? ` · ${s.version}` : ""}</span>
                </span>
                <button type="button" className="axe-harness__btn" data-action="verifier-url" disabled={occupe !== null} onClick={() => void voir(s.url)}>
                  Vérifier
                </button>
                <button
                  type="button"
                  className="axe-harness__btn axe-harness__btn--danger"
                  data-action="desinstaller"
                  disabled={occupe !== null}
                  onClick={() => void desinstaller(s.id)}
                  onBlur={() => aRetirer === s.id && setARetirer(null)}
                >
                  {aRetirer === s.id ? "Confirmer" : "Désinstaller"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {message ? <p className="axe-harness__status" role="status">{message}</p> : null}
      {erreur ? <p className="axe-harness__error">{erreur}</p> : null}
      <div className="axe-harness__actions">
        {apercu ? (
          <button
            type="button"
            className="axe-harness__btn axe-harness__btn--primary"
            data-action="installer-url"
            disabled={occupe !== null || choix.size === 0}
            onClick={() => void installer()}
          >
            {occupe === "installer" ? "Installation…" : `Installer (${choix.size})`}
          </button>
        ) : null}
        <button type="button" className="axe-harness__btn" onClick={onFermer}>
          Fermer
        </button>
      </div>
    </>
  );
}
