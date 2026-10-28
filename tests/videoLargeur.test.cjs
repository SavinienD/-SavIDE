const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const css = fs.readFileSync(path.join(__dirname, "../src/components/viewers/viewers.css"), "utf8");
const bloc = (sel) => { const i = css.lastIndexOf(sel + " {"); return css.slice(i, css.indexOf("}", i)); };
test("la video remplit le volet en gardant ses proportions (large ou verticale)", () => {
  const v = bloc(".xv-media__video");
  for (const r of ["width: 100%", "height: 100%", "object-fit: contain", "min-width: 0"]) assert.ok(v.includes(r), r);
  const c = bloc('.xv-media[data-video="true"]');
  assert.ok(c.includes("min-width: 0") && c.includes("width: 100%"));
});
