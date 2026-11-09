// Ajout d'un appareil en trois temps : système de la machine, commande à y lancer,
// réponse collée ici (lue, résumée, puis appareil enregistré et testé).
import { useEffect, useMemo, useState } from "react";
import { connectionsApi, type ServiceStatus } from "./connectionsApi";
import { DEBUT, FIN, commandeAppareil, lireReponse, obstacles, type SystemeAppareil } from "./ajoutAppareilOutils";

const SYSTEMES: { id: SystemeAppareil; nom: string }[] = [
  { id: "linux", nom: "Linux" },
  { id: "macos", nom: "macOS" },
  { id: "windows", nom: "Windows" },
];

const OU_LANCER: Record<SystemeAppareil, string> = {
  linux: "Dans un terminal, avec le compte qui servira à la connexion.",
  macos: "Dans le Terminal, avec le compte qui servira à la connexion.",
  windows: "Dans PowerShell, avec le compte qui servira à la connexion. Si ce compte est administrateur, ouvre PowerShell en administrateur.",
};

const texteErreur = (err: unknown) => String(err instanceof Error ? err.message : err);

export type ResultatAjout = { id: string; ok: boolean; texte: string };

export function AjoutAppareil({ onFini, onManuel, onAnnuler }: {
  onFini: (r: ResultatAjout) => void | Promise<void>;
  onManuel: () => void;
  onAnnuler: () => void;
}) {
  const [systeme, setSysteme] = useState<SystemeAppareil | null>(null);
  const [clePc, setClePc] = useState<{ cle: string | null; fichier?: string } | null>(null);
  const [autoriser, setAutoriser] = useState(true);
  const [copie, setCopie] = useState<"" | "ok" | "echec">("");
  const [reponse, setReponse] = useState("");
  const [nom, setNom] = useState("");
  const [adresse, setAdresse] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    connectionsApi.clePublique().then(setClePc, () => setClePc({ cle: null }));
  }, []);

  const cle = autoriser ? clePc?.cle ?? null : null;
  const commande = useMemo(() => (systeme ? commandeAppareil(systeme, cle) : ""), [systeme, cle]);
  const lecture = useMemo(() => (reponse.trim() ? lireReponse(reponse) : null), [reponse]);
  const fiche = lecture?.ok ? lecture.fiche : null;

  useEffect(() => {
    setNom(fiche?.nom ?? "");
    setAdresse(fiche?.ips[0] ?? "");
  }, [fiche?.nom, fiche?.ips.join(" ")]); // eslint-disable-line react-hooks/exhaustive-deps

  const copier = async () => {
    try {
      await navigator.clipboard.writeText(commande);
      setCopie("ok");
    } catch {
      setCopie("echec");
    }
  };

  const enregistrer = async () => {
    if (!fiche) return;
    setOccupe(true);
    setErreur(null);
    try {
      const saved = await connectionsApi.save(
        {
          id: "",
          name: nom.trim() || fiche.nom,
          kind: "ssh",
          username: "",
          ssh: {
            user: fiche.utilisateur,
            host: adresse.trim(),
            port: fiche.port,
            remotePort: 9119,
            identityFile: fiche.cle === "oui" && clePc?.fichier ? clePc.fichier : null,
            startService: true,
            remoteCommand: fiche.axecode && !/\s/.test(fiche.axecode) ? fiche.axecode : null,
          },
        },
        {},
      );
      try {
        const s: ServiceStatus = await connectionsApi.test(saved.id);
        await onFini({ id: saved.id, ok: true, texte: `Répond — v${s.version ?? "?"}${s.latencyMs != null ? `, ${s.latencyMs} ms` : ""}` });
      } catch (err) {
        await onFini({ id: saved.id, ok: false, texte: texteErreur(err) });
      }
    } catch (err) {
      setErreur(texteErreur(err));
    } finally {
      setOccupe(false);
    }
  };

  const bloquants = fiche ? obstacles(fiche, !!cle) : [];
  const empreinte = fiche?.empreintes.find((e) => e.type === "ED25519") ?? fiche?.empreintes[0];

  return (
    <section className="axe-repl__card axe-connections__ajout" aria-label="Ajouter un appareil">
      <h3>Ajouter un appareil</h3>

      <div className="axe-connections__etape" data-etape="1">
        <span className="axe-connections__num">1</span>
        <div>
          <strong>Système de la machine</strong>
          <div className="axe-connections__systemes" role="radiogroup">
            {SYSTEMES.map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={systeme === s.id} data-systeme={s.id}
                className="axe-connections__systeme" onClick={() => { setSysteme(s.id); setCopie(""); }}>
                {s.nom}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="axe-connections__etape" data-etape="2" aria-disabled={!systeme}>
        <span className="axe-connections__num">2</span>
        <div>
          <strong>Lance cette commande sur la machine</strong>
          {systeme ? (
            <>
              <p className="axe-repl__muted">{OU_LANCER[systeme]}</p>
              <div className="axe-connections__commande">
                <code>{commande}</code>
                <button type="button" className="axe-connections__btn" data-action="copier-commande" onClick={() => void copier()}>
                  {copie === "ok" ? "Copiée" : "Copier"}
                </button>
              </div>
              {copie === "echec" ? <p className="axe-repl__error">Copie refusée : sélectionne la commande à la main.</p> : null}
              {clePc?.cle ? (
                <label className="axe-connections__case">
                  <input type="checkbox" checked={autoriser} onChange={(e) => setAutoriser(e.target.checked)} />
                  <span>Autoriser ce PC à s'y connecter (sa clé publique est ajoutée sur la machine)</span>
                </label>
              ) : clePc ? (
                <p className="axe-repl__muted" data-etat="sans-cle">
                  Ce PC n'a pas de clé SSH : crée-la avec <code>ssh-keygen -t ed25519</code>, puis rouvre cet écran.
                  Sans clé, la machine demandera son mot de passe.
                </p>
              ) : null}
              <p className="axe-repl__muted">Elle n'envoie aucun mot de passe : nom, système, compte, adresses, port et empreinte SSH.</p>
            </>
          ) : (
            <p className="axe-repl__muted">Choisis d'abord le système.</p>
          )}
        </div>
      </div>

      <div className="axe-connections__etape" data-etape="3" aria-disabled={!systeme}>
        <span className="axe-connections__num">3</span>
        <div>
          <strong>Colle la réponse</strong>
          <textarea className="axe-connections__reponse" rows={4} spellCheck={false} value={reponse}
            placeholder={`${DEBUT} … ${FIN}`}
            onChange={(e) => setReponse(e.target.value)} />
          {lecture && !lecture.ok ? <p className="axe-repl__error" data-etat="reponse-invalide">{lecture.erreur}</p> : null}
          {fiche ? (
            <div className="axe-connections__resume">
              <div className="axe-repl__kv">
                <span className="axe-connections__lib">Nom</span>
                <input value={nom} onChange={(e) => setNom(e.target.value)} />
                <span className="axe-connections__lib">Adresse</span>
                <input value={adresse} list="axe-appareil-ips" onChange={(e) => setAdresse(e.target.value)} />
                <datalist id="axe-appareil-ips">{fiche.ips.map((ip) => <option key={ip} value={ip} />)}</datalist>
                <span className="axe-connections__lib">Compte</span>
                <span className="axe-connections__valeur">{fiche.utilisateur} (port SSH {fiche.port})</span>
                <span className="axe-connections__lib">Système</span>
                <span className="axe-connections__valeur">{fiche.os || "inconnu"}</span>
                <span className="axe-connections__lib">Clé d'hôte</span>
                <span className="axe-connections__valeur axe-connections__empreinte">{empreinte ? `${empreinte.type} ${empreinte.sha256}` : "non trouvée"}</span>
                <span className="axe-connections__lib">Clé de ce PC</span>
                <span className="axe-connections__valeur">{fiche.cle === "oui" ? "autorisée" : fiche.cle === "echec" ? "pas ajoutée" : "pas demandée"}</span>
              </div>
              {bloquants.length ? (
                <ul className="axe-connections__obstacles">{bloquants.map((b) => <li key={b}>{b}</li>)}</ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {erreur ? <p className="axe-repl__error">{erreur}</p> : null}
      <div className="axe-repl__row axe-connections__fin">
        <button type="button" className="axe-repl__save" data-action="tester-enregistrer"
          disabled={!fiche || !adresse.trim() || occupe} onClick={() => void enregistrer()}>
          {occupe ? "Test en cours…" : "Tester et enregistrer"}
        </button>
        <button type="button" className="settings-pane__btn" onClick={onAnnuler}>Annuler</button>
        <button type="button" className="axe-connections__lien axe-connections__manuel" data-action="saisie-manuelle" onClick={onManuel}>
          Saisir à la main
        </button>
      </div>
    </section>
  );
}
