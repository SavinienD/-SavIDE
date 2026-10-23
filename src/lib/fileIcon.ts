// Map a filename (or folder name) to the corresponding iconify name
// from the vscode-icons pack (https://icon-sets.iconify.design/vscode-icons/).
// This is the same icon pack VS Code uses when you enable the
// "vscode-icons" extension — so the user gets real TypeScript / Rust /
// package.json glyphs instead of generic dots.

const PREFIX = "vscode-icons";

/** Iconify name for a folder. Open vs. closed state. */
export function folderIcon(name: string, open: boolean): string {
  const key = name.toLowerCase();
  const table = open ? FOLDER_OPEN : FOLDER_CLOSED;
  const hit = table[key];
  if (hit) return `${PREFIX}:${hit}`;
  return `${PREFIX}:${open ? "default-folder-opened" : "default-folder"}`;
}

/** Iconify name for a file. */
export function fileIcon(filename: string): string {
  const lower = filename.toLowerCase();

  // Exact filename matches first (dotfiles, special configs).
  const byName = FILE_BY_NAME[lower];
  if (byName) return `${PREFIX}:${byName}`;

  // Compound extensions (foo.spec.ts, foo.test.tsx, foo.d.ts).
  if (lower.endsWith(".d.ts")) return `${PREFIX}:file-type-typescriptdef`;
  if (lower.endsWith(".test.tsx") || lower.endsWith(".spec.tsx")) {
    return `${PREFIX}:file-type-testts`;
  }
  if (lower.endsWith(".test.ts") || lower.endsWith(".spec.ts")) {
    return `${PREFIX}:file-type-testts`;
  }
  if (lower.endsWith(".test.jsx") || lower.endsWith(".spec.jsx")) {
    return `${PREFIX}:file-type-testjs`;
  }
  if (lower.endsWith(".test.js") || lower.endsWith(".spec.js")) {
    return `${PREFIX}:file-type-testjs`;
  }
  if (lower.endsWith(".module.css")) return `${PREFIX}:file-type-css`;

  // Extension fallback.
  const dot = lower.lastIndexOf(".");
  if (dot >= 0) {
    const ext = lower.slice(dot + 1);
    const hit = FILE_BY_EXT[ext];
    if (hit) return `${PREFIX}:${hit}`;
  }

  return `${PREFIX}:default-file`;
}

/** Known folder names that get a distinctive icon. */
const FOLDER_CLOSED: Record<string, string> = {
  node_modules: "folder-type-node",
  src: "folder-type-src",
  source: "folder-type-src",
  test: "folder-type-test",
  tests: "folder-type-test",
  "__tests__": "folder-type-test",
  dist: "folder-type-dist",
  build: "folder-type-dist",
  public: "folder-type-public",
  static: "folder-type-public",
  assets: "folder-type-asset",
  images: "folder-type-images",
  img: "folder-type-images",
  fonts: "folder-type-fonts",
  components: "folder-type-view",
  pages: "folder-type-view",
  views: "folder-type-view",
  hooks: "folder-type-hook",
  styles: "folder-type-css",
  css: "folder-type-css",
  scripts: "folder-type-tools",
  scss: "folder-type-css",
  config: "folder-type-config",
  ".config": "folder-type-config",
  ".github": "folder-type-github",
  ".git": "folder-type-git",
  ".vscode": "folder-type-vscode",
  docs: "folder-type-docs",
  doc: "folder-type-docs",
  documentation: "folder-type-docs",
  target: "folder-type-dist",
  crates: "folder-type-cargo",
  "src-tauri": "folder-type-cargo",
  api: "folder-type-api",
  lib: "folder-type-library",
  utils: "folder-type-tools",
  util: "folder-type-tools",
  helpers: "folder-type-tools",
};

const FOLDER_OPEN: Record<string, string> = Object.fromEntries(
  Object.entries(FOLDER_CLOSED).map(([k, v]) => [k, `${v}-opened`]),
);

/** Exact-filename matches (case-insensitive). */
const FILE_BY_NAME: Record<string, string> = {
  "package.json": "file-type-node",
  "package-lock.json": "file-type-npm",
  "pnpm-lock.yaml": "file-type-pnpm",
  "yarn.lock": "file-type-yarn",
  "bun.lockb": "file-type-bun",
  "tsconfig.json": "file-type-tsconfig",
  "tsconfig.node.json": "file-type-tsconfig",
  "tsconfig.app.json": "file-type-tsconfig",
  "jsconfig.json": "file-type-jsconfig",
  "vite.config.ts": "file-type-vite",
  "vite.config.js": "file-type-vite",
  "vitest.config.ts": "file-type-vitest",
  "webpack.config.js": "file-type-webpack",
  "webpack.config.ts": "file-type-webpack",
  "rollup.config.js": "file-type-rollup",
  "rollup.config.ts": "file-type-rollup",
  "tailwind.config.js": "file-type-tailwind",
  "tailwind.config.ts": "file-type-tailwind",
  "postcss.config.js": "file-type-postcss",
  "postcss.config.ts": "file-type-postcss",
  "babel.config.js": "file-type-babel",
  ".babelrc": "file-type-babel",
  ".babelrc.json": "file-type-babel",
  ".eslintrc": "file-type-eslint",
  ".eslintrc.js": "file-type-eslint",
  ".eslintrc.json": "file-type-eslint",
  ".eslintrc.cjs": "file-type-eslint",
  "eslint.config.js": "file-type-eslint",
  "eslint.config.ts": "file-type-eslint",
  ".prettierrc": "file-type-prettier",
  ".prettierrc.json": "file-type-prettier",
  "prettier.config.js": "file-type-prettier",
  ".editorconfig": "file-type-editorconfig",
  ".gitignore": "file-type-git",
  ".gitattributes": "file-type-git",
  ".gitmodules": "file-type-git",
  ".env": "file-type-dotenv",
  ".env.local": "file-type-dotenv",
  ".env.development": "file-type-dotenv",
  ".env.production": "file-type-dotenv",
  ".env.example": "file-type-dotenv",
  ".nvmrc": "file-type-node",
  ".node-version": "file-type-node",
  "dockerfile": "file-type-docker",
  "docker-compose.yml": "file-type-docker",
  "docker-compose.yaml": "file-type-docker",
  "cargo.toml": "file-type-cargo",
  "cargo.lock": "file-type-cargo",
  "rust-toolchain.toml": "file-type-rust-toolchain",
  "makefile": "file-type-cmake",
  "license": "file-type-license",
  "license.md": "file-type-license",
  "license.txt": "file-type-license",
  "readme.md": "file-type-markdown",
  "readme.txt": "file-type-markdown",
  "readme": "file-type-markdown",
  "changelog.md": "file-type-markdown",
  "changelog": "file-type-markdown",
  "contributing.md": "file-type-markdown",
  "tauri.conf.json": "file-type-tauri",
};

/** Extension-based matches. */
const FILE_BY_EXT: Record<string, string> = {
  // JS / TS
  ts: "file-type-typescript-official",
  tsx: "file-type-reactts",
  js: "file-type-js-official",
  jsx: "file-type-reactjs",
  mjs: "file-type-js-official",
  cjs: "file-type-js-official",

  // Web
  html: "file-type-html",
  htm: "file-type-html",
  css: "file-type-css",
  scss: "file-type-scss",
  sass: "file-type-sass",
  less: "file-type-less",
  vue: "file-type-vue",
  svelte: "file-type-svelte",
  astro: "file-type-astro",

  // Data / config
  json: "file-type-json",
  jsonc: "file-type-json",
  json5: "file-type-json",
  yaml: "file-type-yaml",
  yml: "file-type-yaml",
  toml: "file-type-toml",
  xml: "file-type-xml",
  ini: "file-type-ini",
  env: "file-type-dotenv",

  // Docs
  md: "file-type-markdown",
  mdx: "file-type-mdx",
  markdown: "file-type-markdown",
  txt: "file-type-text",
  rtf: "file-type-text",
  log: "file-type-log",
  pdf: "file-type-pdf2",

  // Systems
  rs: "file-type-rust",
  go: "file-type-go",
  py: "file-type-python",
  rb: "file-type-ruby",
  php: "file-type-php",
  java: "file-type-java",
  kt: "file-type-kotlin",
  scala: "file-type-scala",
  swift: "file-type-swift",
  c: "file-type-c",
  h: "file-type-cheader",
  cpp: "file-type-cpp",
  cc: "file-type-cpp",
  cxx: "file-type-cpp",
  hpp: "file-type-cppheader",
  cs: "file-type-csharp",
  fs: "file-type-fsharp",
  dart: "file-type-dartlang",
  lua: "file-type-lua",
  r: "file-type-r",
  jl: "file-type-julia",
  ex: "file-type-elixir",
  exs: "file-type-elixir",
  erl: "file-type-erlang",
  clj: "file-type-clojure",
  elm: "file-type-elm",
  hs: "file-type-haskell",
  nim: "file-type-nim",
  zig: "file-type-zig",
  ml: "file-type-ocaml",
  pl: "file-type-perl",

  // Shell
  sh: "file-type-shell",
  bash: "file-type-shell",
  zsh: "file-type-shell",
  fish: "file-type-shell",
  ps1: "file-type-powershell",

  // Queries
  sql: "file-type-sql",
  graphql: "file-type-graphql",
  gql: "file-type-graphql",
  prisma: "file-type-prisma",

  // Build / containers
  dockerfile: "file-type-docker",
  makefile: "file-type-cmake",

  // Images
  png: "file-type-image",
  jpg: "file-type-image",
  jpeg: "file-type-image",
  gif: "file-type-image",
  webp: "file-type-image",
  avif: "file-type-image",
  bmp: "file-type-image",
  ico: "file-type-favicon",
  svg: "file-type-svg",

  // Fonts
  ttf: "file-type-font",
  otf: "file-type-font",
  woff: "file-type-font",
  woff2: "file-type-font",

  // Media
  mp3: "file-type-audio",
  wav: "file-type-audio",
  ogg: "file-type-audio",
  flac: "file-type-audio",
  mp4: "file-type-video",
  mov: "file-type-video",
  avi: "file-type-video",
  webm: "file-type-video",

  // Archives
  zip: "file-type-zip",
  tar: "file-type-zip",
  gz: "file-type-zip",
  tgz: "file-type-zip",
  rar: "file-type-zip",
  "7z": "file-type-zip",

  // Misc
  lock: "file-type-yaml",
  bin: "file-type-binary",
  exe: "file-type-binary",
  dll: "file-type-binary",
  so: "file-type-binary",
  dylib: "file-type-binary",
  wasm: "file-type-wasm",
};
