// Map a file extension to a Monaco language id. Keep this lean; Monaco
// supports a lot more out of the box but the common cases here cover
// 95% of day-to-day editing.

const TABLE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  py: "python",
  rs: "rust",
  toml: "ini",
  ini: "ini",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sql: "sql",
  xml: "xml",
  svg: "xml",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "dockerfile",
  lock: "yaml",
};

export function languageForPath(relativePath: string): string {
  const name = relativePath.split("/").pop() ?? relativePath;
  if (name.toLowerCase() === "dockerfile") return "dockerfile";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = name.slice(dot + 1).toLowerCase();
  return TABLE[ext] ?? "plaintext";
}
