// axe:providers — subscription quota indicator (titlebar). Polls the
// `provider_quota` IPC; hides itself when no provider exposes a quota.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PROVIDERS_CHANGED_EVENT } from "./providers";

type QuotaWindow = {
  id: string;
  label: string;
  utilization: number;
  resetsAt: string | null;
  projectedExhaustionMs: number | null;
  exhaustsBeforeReset: boolean;
};

type ProviderQuota = {
  provider: string;
  label: string;
  supported: boolean;
  error: string | null;
  windows: QuotaWindow[];
};

export type QuotaReport = { fetchedAtMs: number; providers: ProviderQuota[] };

const POLL_MS = 5 * 60_000;

export function fetchProviderQuota(force = false): Promise<QuotaReport> {
  return invoke<QuotaReport>("provider_quota", { input: { force } });
}

function tone(w: QuotaWindow): "ok" | "warn" | "error" {
  if (w.utilization >= 90 || w.exhaustsBeforeReset) return "error";
  if (w.utilization >= 70) return "warn";
  return "ok";
}

function formatWhen(ms: number): string {
  const delta = ms - Date.now();
  if (delta <= 0) return "maintenant";
  const min = Math.round(delta / 60_000);
  if (min < 60) return `dans ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `dans ${h} h ${String(min % 60).padStart(2, "0")}`;
  return `dans ${Math.round(h / 24)} j`;
}

export function QuotaIndicator() {
  const [report, setReport] = useState<QuotaReport | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      setReport(await fetchProviderQuota(force));
    } catch {
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const refresh = () => void load();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, refresh);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const supported = report?.providers.filter((p) => p.supported) ?? [];
  if (supported.length === 0) return null;
  const windows = supported.flatMap((p) => p.windows);
  const worst = windows.reduce<QuotaWindow | null>(
    (acc, w) => (!acc || w.utilization > acc.utilization ? w : acc),
    null,
  );
  const hasError = supported.some((p) => p.error);

  return (
    <div className="axe-quota" ref={rootRef}>
      <button
        type="button"
        className="axe-quota__pill"
        data-tone={worst ? tone(worst) : hasError ? "error" : "ok"}
        onClick={() => setOpen((v) => !v)}
        title="Quota d'abonnement"
      >
        <span className="axe-quota__dot" />
        {worst ? `${worst.label} ${Math.round(worst.utilization)} %` : "Quota"}
      </button>

      {open && (
        <div className="axe-quota__popover" role="dialog" aria-label="Quotas">
          {supported.map((p) => (
            <div key={p.provider} className="axe-quota__provider">
              <div className="axe-quota__head">
                <strong>{p.label}</strong>
                <button type="button" disabled={loading} onClick={() => void load(true)}>
                  {loading ? "…" : "Actualiser"}
                </button>
              </div>
              {p.error && <div className="axe-quota__error">{p.error}</div>}
              {p.windows.map((w) => (
                <div key={w.id} className="axe-quota__window" data-tone={tone(w)}>
                  <div className="axe-quota__row">
                    <span>{w.label}</span>
                    <span>{w.utilization.toFixed(0)} %</span>
                  </div>
                  <div className="axe-quota__bar">
                    <span style={{ width: `${Math.min(100, Math.max(0, w.utilization))}%` }} />
                  </div>
                  <div className="axe-quota__meta">
                    {w.resetsAt && <span>Réinitialisation {formatWhen(Date.parse(w.resetsAt))}</span>}
                    {w.projectedExhaustionMs && (
                      <span>
                        {w.exhaustsBeforeReset ? "Épuisement estimé " : "Rythme actuel : 100 % "}
                        {formatWhen(w.projectedExhaustionMs)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
