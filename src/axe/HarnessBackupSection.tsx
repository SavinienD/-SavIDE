// axe:cleanup — Settings > Harness: periodic harness backup to a chosen folder.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type BackupConfig = {
  enabled: boolean;
  dir: string;
  intervalMinutes: number;
  keep: number;
  workspaces: string[];
  lastBackupMs: number | null;
  lastError: string | null;
};

export function HarnessBackupSection({ workspacePath }: { workspacePath: string }) {
  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setConfig(await invoke<BackupConfig>("harness_backup_get", { workspacePath }));
    } catch (err) {
      setStatus(String(err));
    }
  }, [workspacePath]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Partial<BackupConfig>) => {
    if (!config) return;
    const next = { ...config, ...patch };
    setConfig(next);
    try {
      setConfig(
        await invoke<BackupConfig>("harness_backup_set", {
          input: {
            workspacePath,
            enabled: next.enabled,
            dir: next.dir,
            intervalMinutes: next.intervalMinutes,
            keep: next.keep,
          },
        }),
      );
    } catch (err) {
      setStatus(String(err));
    }
  };

  const pickDir = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Dossier de sauvegarde du harnais" });
    if (typeof dir === "string") await save({ dir });
  };

  const runNow = async () => {
    setBusy(true);
    setStatus(null);
    try {
      setConfig(await invoke<BackupConfig>("harness_backup_run", { workspacePath }));
      setStatus("Sauvegarde effectuée");
    } catch (err) {
      setStatus(`Échec : ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!config) return null;
  return (
    <section className="axe-backup">
      <h3>Sauvegarde périodique</h3>
      <p className="axe-backup__hint">
        Copie le harnais global et le harnais des projets ouverts dans un dossier daté. Les plus anciennes copies
        au-delà de la limite sont supprimées.
      </p>
      <div className="axe-backup__row">
        <label className="axe-backup__check">
          <input type="checkbox" checked={config.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
          Activer
        </label>
        <button type="button" className="settings-pane__btn" onClick={() => void pickDir()}>
          Choisir le dossier…
        </button>
        <code className="axe-backup__dir">{config.dir || "aucun dossier"}</code>
      </div>
      <div className="axe-backup__row">
        <label>
          Toutes les
          <input
            type="number"
            min={5}
            value={config.intervalMinutes}
            onChange={(e) => void save({ intervalMinutes: Number(e.target.value) || 60 })}
          />
          min
        </label>
        <label>
          Conserver
          <input type="number" min={1} value={config.keep} onChange={(e) => void save({ keep: Number(e.target.value) || 20 })} />
          copies
        </label>
        <button type="button" className="settings-pane__btn" disabled={busy || !config.dir} onClick={() => void runNow()}>
          {busy ? "…" : "Sauvegarder maintenant"}
        </button>
      </div>
      <p className="axe-backup__hint">
        {config.lastBackupMs ? `Dernière sauvegarde : ${new Date(config.lastBackupMs).toLocaleString("fr-FR")}` : "Jamais sauvegardé"}
        {config.lastError ? ` · erreur : ${config.lastError}` : ""}
        {status ? ` · ${status}` : ""}
      </p>
    </section>
  );
}
