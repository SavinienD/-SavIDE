// axe:viewers — sandboxed HTML preview. The live Monaco buffer is rendered in
// an iframe (srcdoc) with a <base> pointing at the file's folder so relative
// images, styles and scripts resolve. Scripts stay disabled until the user
// explicitly allows them; same-origin is never granted, so the page cannot
// reach the app or its IPC.

import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { assetDirUrl } from "./bytes";

function withBase(html: string, baseHref: string): string {
  if (/<base[\s>]/i.test(html)) return html;
  const tag = `<base href="${baseHref.replace(/"/g, "&quot;")}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (open) => `${open}<head>${tag}</head>`);
  return `${tag}${html}`;
}

export default function HtmlPreview({
  html,
  absolutePath,
}: {
  html: string;
  absolutePath: string;
}) {
  const [scripts, setScripts] = useState(false);
  const [doc, setDoc] = useState(() => withBase(html, assetDirUrl(absolutePath)));
  const [reloads, setReloads] = useState(0);

  // Debounced so typing in the code view does not reload the page each key.
  useEffect(() => {
    const timer = setTimeout(() => setDoc(withBase(html, assetDirUrl(absolutePath))), 300);
    return () => clearTimeout(timer);
  }, [html, absolutePath]);

  return (
    <div className="xv-html">
      <div className="xv-toolbar">
        <span className="xv-html__status" data-on={scripts ? "true" : "false"}>
          <Icon
            icon={scripts ? "solar:shield-warning-linear" : "solar:shield-check-linear"}
            width={14}
            height={14}
          />
          {scripts ? "Scripts autorisés" : "Scripts désactivés"}
        </span>
        <span className="xv-toolbar__spacer" />
        <button
          type="button"
          className="xv-btn xv-btn--text"
          onClick={() => setScripts((value) => !value)}
          title={
            scripts
              ? "Recharger l’aperçu sans exécuter de JavaScript"
              : "Exécuter le JavaScript de la page (isolé de l’application)"
          }
        >
          {scripts ? "Désactiver les scripts" : "Autoriser les scripts"}
        </button>
        <button
          type="button"
          className="xv-btn"
          onClick={() => setReloads((value) => value + 1)}
          title="Recharger l’aperçu"
        >
          <Icon icon="solar:restart-linear" width={14} height={14} />
        </button>
      </div>
      <iframe
        key={`${scripts ? "js" : "static"}-${reloads}`}
        className="xv-html__frame"
        title="Aperçu HTML"
        sandbox={scripts ? "allow-scripts allow-forms allow-modals" : ""}
        referrerPolicy="no-referrer"
        srcDoc={doc}
      />
    </div>
  );
}
