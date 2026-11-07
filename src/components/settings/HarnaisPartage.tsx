// Réglages > Harnais : partager une entrée en .md.
// Menu du clic droit (et du bouton « ⋯ » pour le clavier et le tactile) : « Exporter en .md… »
// (boîte d'enregistrement native) et « Copier en Markdown » ; plusieurs entrées sélectionnées
// (Ctrl/Maj + clic) = un seul .md. Garde-fou : ce qui ressemble à un secret est signalé et
// masqué par défaut. Import : « Importer un .md… » ou dépôt d'un .md sur la liste, avec aperçu.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import {
  LIBELLE_GENRE,
  MASQUE,
  detecterSecrets,
  harnaisVersMarkdown,
  lireHarnaisMarkdown,
  masquerSecrets,
  nomFichierHarnais,
  type EntreeAExporter,
  type LectureHarnais,
  type SecretTrouve,
} from "../../lib/harnaisMarkdown";
import { versionAppli } from "../../lib/versionAppli";
import { harnessApi, type HarnessEntry, type HarnessKind, type HarnessScope } from "./harnessApi";

/** Dernier dossier choisi dans la boîte d'enregistrement (proposé la fois suivante). */
export const CLE_DOSSIER_EXPORT = "axe:harnais-md-dossier";

const MENU_LARGEUR = 230;
const MENU_HAUTEUR = 90;

export function MenuHarnais({
  x,
  y,
  nombre,
  onExporter,
  onCopier,
  onClose,
}: {
  x: number;
  y: number;
  nombre: number;
  onExporter: () => void;
  onCopier: () => void;
  onClose: () => void;
}) {
  const premier = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    premier.current?.focus();
    const fermer = () => onClose();
    const touche = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", fermer);
    window.addEventListener("keydown", touche, true);
    window.addEventListener("resize", fermer);
    return () => {
      window.removeEventListener("pointerdown", fermer);
      window.removeEventListener("keydown", touche, true);
      window.removeEventListener("resize", fermer);
    };
  }, [onClose]);
  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_LARGEUR - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - MENU_HAUTEUR - 8));
  const lancer = (action: () => void) => () => {
    onClose();
    action();
  };
  // Flèches haut/bas entre les deux entrées (menu au clavier).
  const fleches = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".tree-menu__item")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  // Rendu dans <body> : dans les Réglages, un conteneur (container-type) piège position: fixed.
  return createPortal(
    <div
      className="tree-menu axe-harnais-menu"
      role="menu"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={fleches}
    >
      {nombre > 1 ? <div className="tree-menu__hint axe-harnais-menu__titre">{nombre} entrées → un seul .md</div> : null}
      <button ref={premier} type="button" className="tree-menu__item" role="menuitem" data-action="exporter-md" onClick={lancer(onExporter)}>
        <Icon icon="solar:download-linear" width={14} height={14} />
        <span>Exporter en .md…</span>
      </button>
      <button type="button" className="tree-menu__item" role="menuitem" data-action="copier-md" onClick={lancer(onCopier)}>
        <Icon icon="solar:copy-linear" width={14} height={14} />
        <span>Copier en Markdown</span>
      </button>
    </div>,
    document.body,
  );
}

function DialogueSecrets({
  secrets,
  action,
  onMasquer,
  onQuandMeme,
  onAnnuler,
}: {
  secrets: SecretTrouve[];
  action: "exporter" | "copier";
  onMasquer: () => void;
  onQuandMeme: () => void;
  onAnnuler: () => void;
}) {
  return (
    <div className="axe-harnais-modal" role="presentation" onKeyDown={(e) => e.key === "Escape" && onAnnuler()}>
      <div className="axe-harnais-boite axe-harnais-secrets" role="alertdialog" aria-labelledby="axe-harnais-secrets-titre">
        <h3 id="axe-harnais-secrets-titre">Contient peut-être un secret</h3>
        <p className="axe-harness__muted">
          {secrets.length === 1 ? "Un passage ressemble" : `${secrets.length} passages ressemblent`} à un mot de passe, une clé
          ou un jeton. Par défaut, ils sont remplacés par <code>{MASQUE}</code>.
        </p>
        <ul>
          {secrets.slice(0, 8).map((s, i) => (
            <li key={i}>
              {s.raison} : <code>{s.apercu}</code>
            </li>
          ))}
          {secrets.length > 8 ? <li>… et {secrets.length - 8} autre(s)</li> : null}
        </ul>
        <div className="axe-harness__actions">
          <button type="button" autoFocus className="axe-harness__btn axe-harness__btn--primary" data-action="masquer-secrets" onClick={onMasquer}>
            Masquer
          </button>
          <button type="button" className="axe-harness__btn" data-action="exporter-quand-meme" onClick={onQuandMeme}>
            {action === "copier" ? "Copier quand même" : "Exporter quand même"}
          </button>
          <button type="button" className="axe-harness__btn" data-action="annuler" onClick={onAnnuler}>
            Annuler
          </button>
        </div>
      </div>
    </div>
  );
}

function ApercuImport({
  nom,
  lecture,
  portee,
  busy,
  onPortee,
  onImporter,
  onAnnuler,
}: {
  nom: string;
  lecture: LectureHarnais;
  portee: HarnessScope;
  busy: boolean;
  onPortee: (portee: HarnessScope) => void;
  onImporter: () => void;
  onAnnuler: () => void;
}) {
  return (
    <div className="axe-harnais-modal" role="presentation" onKeyDown={(e) => e.key === "Escape" && onAnnuler()}>
      <div className="axe-harnais-boite axe-harnais-import" role="dialog" aria-labelledby="axe-harnais-import-titre">
        <h3 id="axe-harnais-import-titre" title={nom}>
          Importer « {nom} »
        </h3>
        {lecture.ok ? (
          <>
            <ul className="axe-harnais-import__liste">
              {lecture.entrees.map((e, i) => (
                <li key={i}>
                  <span className="axe-harness__pill">{LIBELLE_GENRE[e.kind]}</span>
                  <strong title={e.title}>{e.title}</strong>
                  <span className="axe-harness__muted">
                    {e.body.length} car.{e.code ? " + code Python" : ""}
                    {e.tags.length ? ` · ${e.tags.join(", ")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
            <label className="axe-harnais-import__portee">
              Portée
              <select data-champ="portee" value={portee} onChange={(ev) => onPortee(ev.target.value as HarnessScope)}>
                <option value="global">Ce poste (global)</option>
                <option value="project">Ce projet</option>
              </select>
            </label>
            <div className="axe-harness__actions">
              <button type="button" autoFocus className="axe-harness__btn axe-harness__btn--primary" data-action="importer-confirmer" disabled={busy} onClick={onImporter}>
                {lecture.entrees.length > 1 ? `Importer ${lecture.entrees.length} entrées` : "Importer"}
              </button>
              <button type="button" className="axe-harness__btn" onClick={onAnnuler}>
                Annuler
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="axe-harness__error" data-erreur="format">
              Ce fichier ne peut pas être importé : {lecture.erreur}
            </p>
            <p className="axe-harness__muted">
              Seuls les .md créés par « Exporter en .md… » (ou écrits sur le même modèle : en-tête --- avec type et titre)
              sont acceptés.
            </p>
            <div className="axe-harness__actions">
              <button type="button" autoFocus className="axe-harness__btn" onClick={onAnnuler}>
                Fermer
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function joindre(dossier: string, nom: string): string {
  const sep = dossier.includes("\\") ? "\\" : "/";
  return dossier.endsWith(sep) ? `${dossier}${nom}` : `${dossier}${sep}${nom}`;
}

function dossierDe(chemin: string): string {
  const i = Math.max(chemin.lastIndexOf("\\"), chemin.lastIndexOf("/"));
  return i > 0 ? chemin.slice(0, i) : "";
}

function nomDe(chemin: string): string {
  return chemin.slice(Math.max(chemin.lastIndexOf("\\"), chemin.lastIndexOf("/")) + 1);
}

async function dossierParDefaut(): Promise<string | null> {
  try {
    const dernier = window.localStorage.getItem(CLE_DOSSIER_EXPORT);
    if (dernier) return dernier;
  } catch {
    // stockage indisponible
  }
  try {
    const { documentDir } = await import("@tauri-apps/api/path");
    return (await documentDir()) || null;
  } catch {
    return null;
  }
}

type Attente = { texte: string; secrets: SecretTrouve[]; action: "exporter" | "copier"; nombre: number; nom: string };
type Apercu = { nom: string; lecture: LectureHarnais };

/**
 * Export / copie / import d'entrées du harnais en Markdown. `dialogues` est à rendre
 * dans le volet (boîtes « secret » et « aperçu de l'import »).
 */
export function usePartageHarnais({
  workspacePath,
  onStatus,
  onError,
  onImported,
}: {
  workspacePath: string;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
  onImported: (kind: HarnessKind) => void;
}): {
  exporter: (entrees: HarnessEntry[]) => void;
  copier: (entrees: HarnessEntry[]) => void;
  importerFichier: () => void;
  importerChemins: (chemins: string[]) => void;
  importerTexte: (nom: string, texte: string) => void;
  dialogues: ReactNode;
} {
  const [attente, setAttente] = useState<Attente | null>(null);
  const [apercu, setApercu] = useState<Apercu | null>(null);
  const [portee, setPortee] = useState<HarnessScope>("global");
  const [busy, setBusy] = useState(false);

  const preparer = useCallback(
    async (entrees: HarnessEntry[]): Promise<string> => {
      const lot: EntreeAExporter[] = [];
      for (const e of entrees) {
        let code: string | null = null;
        if (e.kind === "skill") code = await harnessApi.skillCode(workspacePath, e.id).catch(() => null);
        lot.push({ kind: e.kind, scope: e.scope, title: e.title, tags: e.tags, body: e.body, updated: e.updated, code });
      }
      return harnaisVersMarkdown(lot, { version: await versionAppli(), date: new Date() });
    },
    [workspacePath],
  );

  const terminer = useCallback(
    async (a: Attente, texte: string) => {
      const quoi = a.nombre > 1 ? `${a.nombre} entrées` : "1 entrée";
      if (a.action === "copier") {
        await navigator.clipboard.writeText(texte);
        onStatus(`Copié en Markdown (${quoi}).`);
        return;
      }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dossier = await dossierParDefaut();
      const choisi = await save({
        title: "Exporter en .md",
        defaultPath: dossier ? joindre(dossier, a.nom) : a.nom,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!choisi) return;
      const chemin = /\.(md|markdown)$/i.test(choisi) ? choisi : `${choisi}.md`;
      await harnessApi.mdWrite(chemin, texte);
      try {
        window.localStorage.setItem(CLE_DOSSIER_EXPORT, dossierDe(chemin));
      } catch {
        // stockage indisponible : Documents la prochaine fois
      }
      onStatus(`Exporté (${quoi}) : ${chemin}`);
    },
    [onStatus],
  );

  const partager = useCallback(
    (entrees: HarnessEntry[], action: "exporter" | "copier") => {
      if (!entrees.length) return;
      void (async () => {
        try {
          const texte = await preparer(entrees);
          const a: Attente = { texte, secrets: detecterSecrets(texte), action, nombre: entrees.length, nom: nomFichierHarnais(entrees) };
          if (a.secrets.length) setAttente(a);
          else await terminer(a, texte);
        } catch (e) {
          onError(String(e));
        }
      })();
    },
    [preparer, terminer, onError],
  );

  const conclure = (masquer: boolean) => {
    const a = attente;
    setAttente(null);
    if (!a) return;
    void terminer(a, masquer ? masquerSecrets(a.texte) : a.texte).catch((e) => onError(String(e)));
  };

  const importerTexte = useCallback((nom: string, texte: string) => {
    setPortee("global");
    setApercu({ nom, lecture: lireHarnaisMarkdown(texte) });
  }, []);

  const importerChemins = useCallback(
    (chemins: string[]) => {
      const chemin = chemins.find((c) => /\.(md|markdown)$/i.test(c));
      if (!chemin) {
        setApercu({
          nom: chemins.length ? nomDe(chemins[0]) : "fichier",
          lecture: { ok: false, erreur: "seuls les fichiers .md sont acceptés." },
        });
        return;
      }
      harnessApi
        .mdRead(chemin)
        .then((texte) => importerTexte(nomDe(chemin), texte))
        .catch((e) => setApercu({ nom: nomDe(chemin), lecture: { ok: false, erreur: String(e) } }));
    },
    [importerTexte],
  );

  const importerFichier = useCallback(() => {
    void (async () => {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const choisi = await open({
          title: "Importer un .md dans le harnais",
          multiple: false,
          directory: false,
          defaultPath: (await dossierParDefaut()) ?? undefined,
          filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
        });
        const chemin = Array.isArray(choisi) ? choisi[0] : choisi;
        if (chemin) importerChemins([chemin]);
      } catch (e) {
        onError(String(e));
      }
    })();
  }, [importerChemins, onError]);

  const confirmerImport = async () => {
    if (!apercu?.lecture.ok) return;
    const entrees = apercu.lecture.entrees;
    setBusy(true);
    const erreurs: string[] = [];
    let faites = 0;
    for (const e of entrees) {
      try {
        await harnessApi.create(workspacePath, e.kind, portee, {
          title: e.title,
          body: e.body,
          tags: e.tags,
          source: "import:md",
          ...(e.kind === "skill" && e.code ? { code: e.code } : {}),
        });
        faites += 1;
      } catch (err) {
        erreurs.push(`« ${e.title} » : ${String(err)}`);
      }
    }
    setBusy(false);
    setApercu(null);
    const ou = portee === "global" ? "ce poste (global)" : "ce projet";
    if (faites) onStatus(`${faites} entrée(s) importée(s) dans ${ou}.`);
    if (erreurs.length) onError(`Import incomplet : ${erreurs.join(" ; ")}`);
    if (faites) onImported(entrees[0].kind);
  };

  const dialogues = createPortal(
    <>
      {attente ? (
        <DialogueSecrets
          secrets={attente.secrets}
          action={attente.action}
          onMasquer={() => conclure(true)}
          onQuandMeme={() => conclure(false)}
          onAnnuler={() => setAttente(null)}
        />
      ) : null}
      {apercu ? (
        <ApercuImport
          nom={apercu.nom}
          lecture={apercu.lecture}
          portee={portee}
          busy={busy}
          onPortee={setPortee}
          onImporter={() => void confirmerImport()}
          onAnnuler={() => setApercu(null)}
        />
      ) : null}
    </>,
    document.body,
  );

  return {
    exporter: (entrees) => partager(entrees, "exporter"),
    copier: (entrees) => partager(entrees, "copier"),
    importerFichier,
    importerChemins,
    importerTexte,
    dialogues,
  };
}
