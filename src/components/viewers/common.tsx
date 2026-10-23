// axe:viewers — small building blocks shared by the viewers.

import { useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { api } from "../../lib/ipc";

export function OpenWithDefaultApp({ path }: { path: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="xv-btn xv-btn--text"
        onClick={() => api.openPathWithDefaultApp(path).catch((err) => setError(String(err)))}
      >
        <Icon icon="solar:square-top-down-linear" width={14} height={14} />
        Ouvrir avec l&rsquo;application par défaut
      </button>
      {error && <code>{error}</code>}
    </>
  );
}

export function ViewerLoading({ label }: { label: string }) {
  return (
    <div className="xv-state">
      <span className="xv-spinner" />
      <span>{label}</span>
    </div>
  );
}

export function ViewerError({
  icon = "solar:danger-triangle-linear",
  title,
  detail,
  children,
}: {
  icon?: string;
  title: string;
  detail?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="xv-state">
      <Icon icon={icon} width={18} height={18} />
      <span>{title}</span>
      {detail && <code>{detail}</code>}
      {children}
    </div>
  );
}
