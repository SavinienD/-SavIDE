import { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react";

/** Masked API key input with reveal and copy actions. */
export function ApiKeyField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(id);
  }, [copied]);

  const handleCopy = useCallback(async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // clipboard unavailable; ignore silently
    }
  }, [value]);

  return (
    <label className="settings-pane__tool-credential">
      <span className="settings-pane__tool-credential-label">{label}</span>
      <div className="settings-pane__tool-credential-field">
        <input
          type={revealed ? "text" : "password"}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        <div className="settings-pane__tool-credential-actions">
          <button
            type="button"
            className="settings-pane__icon-btn"
            onClick={() => setRevealed((v) => !v)}
            title={revealed ? "Masquer la clé" : "Afficher la clé"}
            aria-label={revealed ? "Masquer la clé" : "Afficher la clé"}
            disabled={!value}
          >
            <Icon
              icon={revealed ? "solar:eye-closed-linear" : "solar:eye-linear"}
              width={13}
              height={13}
            />
          </button>
          <button
            type="button"
            className="settings-pane__icon-btn"
            onClick={handleCopy}
            title={copied ? "Copiée" : "Copier la clé"}
            aria-label={copied ? "Copiée" : "Copier la clé"}
            disabled={!value}
          >
            <Icon
              icon={copied ? "solar:check-read-linear" : "solar:copy-linear"}
              width={13}
              height={13}
            />
          </button>
        </div>
      </div>
    </label>
  );
}
