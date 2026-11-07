// e4 — Réglages > Outils : registre de scripts du serveur (/prime/api/registre/v1 ; le jeton de
// l'app est ajouté côté Rust par cloudApi). Passe unslop : carte claire hors ligne, listes lisibles
// (état, date, durée) avec état vide, formulaire à libellés, « Publier » grisé tant qu'il manque l'essentiel.
import { useCallback, useEffect, useState } from "react";
import { cloudApi, errorText, getJson, postJson } from "../cloud/cloudApi";
import { useCloudState } from "../cloud/CloudLoginButton";
import {
  formatDate, formatDuree, libelleEtat, libelleStatut, raisonBlocage, tonEtat, tonStatut,
} from "./registreFormat";
import "./repl.css";
import "./registre.css";

const P = "/prime/api/registre/v1";

export type LigneRegistre = {
  id: string; titre: string; version: string; etat: string; revision: number;
  maj?: number | null; motif_retrait?: string | null;
};
type Execution = {
  n: number; script: string; ticket: string; statut: string; duree_ms: number; sortie: string; erreur: string;
  version?: string; cree?: number | null;
};

export const registreApi = {
  lister: (etat = "") => getJson<{ revision: number; scripts: LigneRegistre[] }>(`${P}/scripts${etat ? `?etat=${etat}` : ""}`),
  executions: (script = "") => getJson<{ executions: Execution[] }>(`${P}/executions?limite=20${script ? `&script=${encodeURIComponent(script)}` : ""}`),
  publier: (manifeste: Record<string, unknown>, code: string) => postJson<{ id: string; version: string; sha256: string }>(`${P}/scripts`, { manifeste, code }),
  valider: (id: string) => postJson(`${P}/scripts/${encodeURIComponent(id)}/valider`),
  retirer: (id: string, motif: string) => postJson(`${P}/scripts/${encodeURIComponent(id)}/retirer`, { motif }),
};

const FORM_VIDE = { id: "", titre: "", version: "1.0.0", langage: "python", code: "" };
type Message = { ton: "ok" | "erreur"; texte: string };

export function RegistrePane() {
  const cloud = useCloudState();
  const connecte = cloud?.connected === true;
  const [lignes, setLignes] = useState<LigneRegistre[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [execs, setExecs] = useState<Execution[] | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [form, setForm] = useState(FORM_VIDE);
  const [envoi, setEnvoi] = useState(false);
  const [retrait, setRetrait] = useState<{ id: string; motif: string } | null>(null);
  const [connexion, setConnexion] = useState<{ enCours: boolean; erreur: string | null }>({ enCours: false, erreur: null });

  const recharger = useCallback(async () => {
    try {
      const r = await registreApi.lister();
      setLignes(r.scripts);
      setRevision(r.revision);
      setExecs((await registreApi.executions()).executions);
    } catch (e) {
      setMessage({ ton: "erreur", texte: errorText(e) });
    }
  }, []);
  useEffect(() => {
    if (connecte) void recharger();
  }, [connecte, recharger]);

  const action = async (f: () => Promise<unknown>, ok: string) => {
    try {
      await f();
      setMessage({ ton: "ok", texte: ok });
      await recharger();
    } catch (e) {
      setMessage({ ton: "erreur", texte: errorText(e) });
    }
  };

  const blocage = raisonBlocage(form);
  const publier = async () => {
    if (blocage || envoi) return;
    setEnvoi(true);
    const id = form.id.trim();
    const titre = form.titre.trim() || id;
    await action(
      () => registreApi.publier(
        { id, nom: id, titre, description: titre, version: form.version.trim(), langage: form.langage,
          environnement: { duree_max_s: 60, memoire_max_mo: 256, reseau: [] } },
        form.code,
      ),
      `${id} ${form.version.trim()} publié : à valider avant usage`,
    );
    setForm(FORM_VIDE);
    setEnvoi(false);
  };

  const seConnecter = async () => {
    if (connexion.enCours) { void cloudApi.reopenLogin().catch(() => undefined); return; }
    setConnexion({ enCours: true, erreur: null });
    try {
      await cloudApi.login();
      setConnexion({ enCours: false, erreur: null });
    } catch (e) {
      setConnexion({ enCours: false, erreur: errorText(e) });
    }
  };

  const champ = (cle: keyof typeof FORM_VIDE) => ({
    value: form[cle],
    "data-champ": cle,
    onChange: (e: { target: { value: string } }) => setForm({ ...form, [cle]: e.target.value }),
  });

  return (
    <section className="axe-registre" data-etat={cloud === null ? "chargement" : connecte ? "connecte" : "hors-ligne"}>
      <header className="axe-registre__tete">
        <div className="axe-registre__tete-texte">
          <h2 className="axe-registre__titre" title="Registre de scripts">Registre de scripts</h2>
          <p className="axe-repl__muted">Scripts que le serveur peut lancer depuis les tickets. Chaque publication attend une validation.</p>
        </div>
        {connecte && lignes ? <span className="axe-registre__revision" title="Chaque changement du registre augmente la révision">Révision {revision}</span> : null}
      </header>

      {cloud !== null && !connecte ? (
        <div className="axe-registre__carte">
          <div className="axe-registre__carte-texte">
            <p className="axe-registre__carte-titre" title="Non connecté au cloud">Non connecté au cloud</p>
            <p className="axe-repl__muted">Connectez-vous pour voir les scripts et en publier.</p>
            {connexion.erreur ? <p className="axe-registre__erreur">{connexion.erreur}</p> : null}
          </div>
          <button type="button" className="axe-repl__save axe-registre__principal" data-action="registre-connecter" onClick={() => void seConnecter()}>
            {connexion.enCours ? "Rouvrir la page de connexion" : "Se connecter au cloud"}
          </button>
        </div>
      ) : null}

      {connecte ? (
        <>
          {message ? (
            <p className={message.ton === "erreur" ? "axe-registre__erreur" : "axe-registre__ok"} role="status">{message.texte}</p>
          ) : null}

          <section className="axe-registre__bloc">
            <h3 className="axe-registre__soustitre" title="Scripts">Scripts{lignes?.length ? <span className="axe-registre__nombre">{lignes.length}</span> : null}</h3>
            {lignes === null ? (
              <p className="axe-repl__muted">Chargement…</p>
            ) : lignes.length === 0 ? (
              <p className="axe-registre__vide" data-liste="scripts">Aucun script publié. Le formulaire ci-dessous ajoute le premier.</p>
            ) : (
              <ul className="axe-registre__liste" data-liste="scripts">
                {lignes.map((s) => (
                  <li key={s.id} className="axe-registre__script" data-etat={s.etat}>
                    <div className="axe-registre__ligne-tete">
                      <span className="axe-registre__pastille" data-ton={tonEtat(s.etat)} data-champ="etat">{libelleEtat(s.etat)}</span>
                      <span className="axe-registre__nom" title={s.titre}>{s.titre || s.id}</span>
                      <span className="axe-registre__meta">{s.version}</span>
                    </div>
                    <div className="axe-registre__ligne-pied">
                      <code className="axe-registre__id" title={s.id}>{s.id}</code>
                      {s.maj ? <span className="axe-registre__meta" data-champ="date">{formatDate(s.maj)}</span> : null}
                      {s.etat === "retire" && s.motif_retrait ? <span className="axe-registre__motif" title={s.motif_retrait}>{s.motif_retrait}</span> : null}
                      <span className="axe-registre__actions">
                        {s.etat !== "valide" ? (
                          <button type="button" className="settings-pane__btn" data-action="registre-valider"
                            onClick={() => void action(() => registreApi.valider(s.id), `${s.id} validé`)}>Valider</button>
                        ) : null}
                        {s.etat !== "retire" ? (
                          <button type="button" className="settings-pane__btn" data-action="registre-retirer"
                            onClick={() => setRetrait({ id: s.id, motif: "" })}>Retirer</button>
                        ) : null}
                      </span>
                    </div>
                    {retrait?.id === s.id ? (
                      <form className="axe-registre__retrait" onSubmit={(e) => {
                        e.preventDefault();
                        if (!retrait.motif.trim()) return;
                        const motif = retrait.motif.trim();
                        setRetrait(null);
                        void action(() => registreApi.retirer(s.id, motif), `${s.id} retiré`);
                      }}>
                        <label className="axe-registre__champ">
                          <span>Motif du retrait</span>
                          <input autoFocus value={retrait.motif} data-champ="motif" placeholder="Remplacé par…"
                            onChange={(e) => setRetrait({ id: s.id, motif: e.target.value })} />
                        </label>
                        <button type="button" className="settings-pane__btn" onClick={() => setRetrait(null)}>Annuler</button>
                        <button type="submit" className="axe-repl__danger" disabled={!retrait.motif.trim()}>Retirer</button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="axe-registre__bloc">
            <h3 className="axe-registre__soustitre" title="Publier un script">Publier un script</h3>
            <form className="axe-registre__form" onSubmit={(e) => { e.preventDefault(); void publier(); }}>
              <div className="axe-registre__grille">
                <label className="axe-registre__champ">
                  <span>Identifiant</span>
                  <input {...champ("id")} className="axe-registre__mono" placeholder="export-tickets" spellCheck={false} autoComplete="off" />
                </label>
                <label className="axe-registre__champ">
                  <span>Titre</span>
                  <input {...champ("titre")} placeholder="Export des tickets du jour" />
                </label>
                <label className="axe-registre__champ axe-registre__champ--court">
                  <span>Version</span>
                  <input {...champ("version")} className="axe-registre__mono" spellCheck={false} />
                </label>
                <label className="axe-registre__champ axe-registre__champ--court">
                  <span>Langage</span>
                  <select {...champ("langage")}>
                    <option value="python">Python</option>
                    <option value="node">Node.js</option>
                    <option value="bash">Bash</option>
                  </select>
                </label>
              </div>
              <label className="axe-registre__champ">
                <span>Code</span>
                <textarea {...champ("code")} className="axe-registre__code" spellCheck={false}
                  placeholder={"import sys\nprint(\"bonjour\")"} />
              </label>
              <div className="axe-registre__envoi">
                {blocage ? <span className="axe-repl__muted" data-champ="raison">{blocage}</span> : <span />}
                <button type="submit" className="axe-repl__save axe-registre__principal" data-action="registre-publier"
                  disabled={!!blocage || envoi}>{envoi ? "Publication…" : "Publier vers le serveur"}</button>
              </div>
            </form>
          </section>

          <section className="axe-registre__bloc">
            <h3 className="axe-registre__soustitre" title="Exécutions récentes (20 dernières)">Exécutions</h3>
            {execs === null ? null : execs.length === 0 ? (
              <p className="axe-registre__vide" data-liste="executions">Aucune exécution pour l'instant.</p>
            ) : (
              <ul className="axe-registre__liste" data-liste="executions">
                {execs.map((x) => (
                  <li key={x.n} className="axe-registre__exec" data-statut={x.statut}>
                    <div className="axe-registre__ligne-tete">
                      <span className="axe-registre__pastille" data-ton={tonStatut(x.statut)} data-champ="statut">{libelleStatut(x.statut)}</span>
                      <code className="axe-registre__nom axe-registre__id" title={x.script}>{x.script}</code>
                      <span className="axe-registre__meta" data-champ="date">{formatDate(x.cree)}</span>
                      <span className="axe-registre__meta axe-registre__duree" data-champ="duree">{formatDuree(x.duree_ms)}</span>
                    </div>
                    {x.erreur || x.sortie || x.ticket ? (
                      <div className="axe-registre__ligne-pied">
                        {x.ticket ? <span className="axe-registre__meta">Ticket {x.ticket}</span> : null}
                        {x.erreur ? <span className="axe-registre__motif axe-registre__motif--erreur" title={x.erreur}>{x.erreur}</span>
                          : x.sortie ? <span className="axe-registre__motif" title={x.sortie}>{x.sortie}</span> : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </section>
  );
}
