// axe:e4 — écran « Registre » (étape 4) + « Publier vers Prime » (étape 1), via l'API du portail
// /prime/api/registre/v1 (le jeton de l'app est ajouté côté Rust par cloudApi).
import { useCallback, useEffect, useState } from "react";
import { errorText, getJson, postJson } from "../cloud/cloudApi";

const P = "/prime/api/registre/v1";

export type LigneRegistre = { id: string; titre: string; version: string; etat: string; revision: number };
type Execution = { n: number; script: string; ticket: string; statut: string; duree_ms: number; sortie: string; erreur: string };

export const registreApi = {
  lister: (etat = "") => getJson<{ revision: number; scripts: LigneRegistre[] }>(`${P}/scripts${etat ? `?etat=${etat}` : ""}`),
  executions: (script = "") => getJson<{ executions: Execution[] }>(`${P}/executions?limite=20${script ? `&script=${encodeURIComponent(script)}` : ""}`),
  publier: (manifeste: Record<string, unknown>, code: string) => postJson<{ id: string; version: string; sha256: string }>(`${P}/scripts`, { manifeste, code }),
  valider: (id: string) => postJson(`${P}/scripts/${encodeURIComponent(id)}/valider`),
  retirer: (id: string, motif: string) => postJson(`${P}/scripts/${encodeURIComponent(id)}/retirer`, { motif }),
};

export function RegistrePane() {
  const [lignes, setLignes] = useState<LigneRegistre[]>([]);
  const [revision, setRevision] = useState(0);
  const [execs, setExecs] = useState<Execution[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({ id: "", titre: "", version: "1.0.0", langage: "python", code: "" });

  const recharger = useCallback(async () => {
    try {
      const r = await registreApi.lister();
      setLignes(r.scripts);
      setRevision(r.revision);
      setExecs((await registreApi.executions()).executions);
    } catch (e) {
      setMessage(errorText(e));
    }
  }, []);
  useEffect(() => void recharger(), [recharger]);

  const publier = async () => {
    try {
      const r = await registreApi.publier(
        { id: form.id, nom: form.id, titre: form.titre || form.id, description: form.titre || form.id,
          version: form.version, langage: form.langage, environnement: { duree_max_s: 60, memoire_max_mo: 256, reseau: [] } },
        form.code,
      );
      setMessage(`Publié : ${r.id} ${r.version} (sha256 ${r.sha256.slice(0, 12)}…)`);
      void recharger();
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  return (
    <section className="registre-pane">
      <h3>Registre de scripts <small>révision {revision}</small></h3>
      {message ? <p className="registre-pane__msg">{message}</p> : null}
      <table>
        <tbody>
          {lignes.map((s) => (
            <tr key={s.id} data-etat={s.etat}>
              <td><code>{s.id}</code></td><td>{s.titre}</td><td>{s.version}</td><td>{s.etat}</td>
              <td>
                {s.etat !== "valide" ? <button type="button" onClick={() => void registreApi.valider(s.id).then(recharger)}>Valider</button> : null}
                {s.etat !== "retire" ? (
                  <button type="button" onClick={() => {
                    const motif = window.prompt("Motif du retrait ?");
                    if (motif) void registreApi.retirer(s.id, motif).then(recharger);
                  }}>Retirer</button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>Publier vers Prime</h4>
      <div className="registre-pane__form">
        <input placeholder="identifiant (ex. export-tickets)" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
        <input placeholder="titre" value={form.titre} onChange={(e) => setForm({ ...form, titre: e.target.value })} />
        <input placeholder="version" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
        <select value={form.langage} onChange={(e) => setForm({ ...form, langage: e.target.value })}>
          <option>python</option><option>node</option><option>bash</option>
        </select>
        <textarea rows={6} placeholder="code du script" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        <button type="button" disabled={!form.id || !form.code} onClick={() => void publier()}>Publier vers Prime</button>
      </div>
      <h4>Exécutions</h4>
      <ul className="registre-pane__execs">
        {execs.map((x) => (
          <li key={x.n} data-statut={x.statut}><code>#{x.n}</code> {x.script} {x.ticket ? `(ticket ${x.ticket})` : ""} — {x.statut} {x.duree_ms} ms {x.sortie ? <code>{x.sortie.slice(0, 80)}</code> : null}{x.erreur ? <em> {x.erreur.slice(0, 120)}</em> : null}</li>
        ))}
      </ul>
    </section>
  );
}
