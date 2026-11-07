// Le Python embarqué du REPL peut appeler une API tierce (requests, certificats).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const script = fs.readFileSync(path.resolve(__dirname, "../scripts/prepare-python.mjs"), "utf8");

test("requests et certifi sont installés et vérifiés dans le Python embarqué", () => {
  const paquets = script.slice(script.indexOf("const PIP_PACKAGES"), script.indexOf("];", script.indexOf("const PIP_PACKAGES")));
  assert.match(paquets, /"requests>=/);
  assert.match(paquets, /"certifi>=/);
  assert.match(script, /const IMPORT_CHECK = "import [^"]*\brequests\b/);
});
