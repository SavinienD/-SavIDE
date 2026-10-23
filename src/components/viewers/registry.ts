// axe:viewers — maps a file path to the viewer that renders it.
//
// A viewer can work in two ways:
// - overlay: the file is text, Monaco stays the source of truth and the
//   viewer is a toggleable preview layered over it (Markdown-style);
// - file: the viewer reads the file itself from disk (binary formats, or
//   text files too large / not decodable for Monaco) and replaces the editor.

export type ViewerKind =
  | "spreadsheet"
  | "delimited"
  | "html"
  | "pdf"
  | "docx"
  | "pptx"
  | "legacy-office"
  | "media-audio"
  | "media-video"
  | "svg"
  | "json"
  | "notebook"
  | "sqlite"
  | "zip"
  | "font"
  | "epub";

export type OverlaySpec = {
  /** Toggle label when the preview is hidden. */
  previewLabel: string;
  /** Toggle label when the preview is shown. */
  sourceLabel: string;
  /** Whether the preview is shown when the tab opens. */
  previewByDefault: boolean;
  /** Toggle icon when the preview is hidden. */
  icon?: string;
};

export type ViewerSpec = {
  kind: ViewerKind;
  overlay?: OverlaySpec;
  /** The viewer can render straight from the file on disk. */
  fromFile: boolean;
  /** Prefer the file viewer even when the content decodes as text. */
  alwaysFile?: boolean;
};

const SPECS: Record<string, ViewerSpec> = {};

function register(extensions: string[], spec: ViewerSpec) {
  for (const ext of extensions) SPECS[ext] = spec;
}

const binary = (kind: ViewerKind): ViewerSpec => ({ kind, fromFile: true, alwaysFile: true });

register(["xlsx", "xlsm", "xlsb", "xls", "ods", "fods", "numbers"], binary("spreadsheet"));
register(["csv", "tsv", "tab"], {
  kind: "delimited",
  fromFile: true,
  overlay: {
    previewLabel: "Tableau",
    sourceLabel: "Texte brut",
    previewByDefault: true,
    icon: "solar:widget-4-linear",
  },
});
register(["html", "htm", "xhtml"], {
  kind: "html",
  fromFile: false,
  overlay: { previewLabel: "Aperçu", sourceLabel: "Code", previewByDefault: false },
});
register(["pdf"], binary("pdf"));
register(["docx", "docm", "dotx"], binary("docx"));
register(["pptx", "pptm", "ppsx", "potx"], binary("pptx"));
register(["doc", "dot", "ppt", "pps", "pot", "odt", "odp", "rtfd", "pages", "key"], binary("legacy-office"));
register(["mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac", "weba"], binary("media-audio"));
register(["mp4", "m4v", "webm", "mov", "ogv", "mkv"], binary("media-video"));
register(["svg"], {
  kind: "svg",
  fromFile: true,
  overlay: { previewLabel: "Aperçu", sourceLabel: "Code", previewByDefault: true },
});
register(["json", "geojson", "webmanifest", "har"], {
  kind: "json",
  fromFile: true,
  overlay: {
    previewLabel: "Arbre",
    sourceLabel: "Code",
    previewByDefault: false,
    icon: "solar:list-arrow-down-linear",
  },
});
register(["ipynb"], {
  kind: "notebook",
  fromFile: true,
  overlay: { previewLabel: "Aperçu", sourceLabel: "Code", previewByDefault: true },
});
register(["sqlite", "sqlite3", "db", "db3", "s3db", "sl3"], binary("sqlite"));
register(["zip", "jar", "war", "ear", "apk", "aab", "nupkg", "vsix", "xpi", "whl"], binary("zip"));
register(["ttf", "otf", "woff", "woff2"], binary("font"));
register(["epub"], binary("epub"));

export function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function viewerForPath(path: string): ViewerSpec | null {
  return SPECS[fileExtension(path)] ?? null;
}
