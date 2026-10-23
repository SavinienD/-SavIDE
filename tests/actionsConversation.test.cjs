const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const sourcePath = path.resolve(__dirname, "../src/components/chat/actionsConversation.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loadedModule = new Module(sourcePath, module);
loadedModule.filename = sourcePath;
loadedModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loadedModule._compile(javascript, sourcePath);
const { createConversationActions } = loadedModule.exports;

function makeExecutors(calls) {
  return Object.fromEntries(
    ["send", "compact", "changeMode", "changeModelPreference", "implementPlanFresh", "stop"].map(
      (name) => [name, async (...args) => calls.push([name, ...args])],
    ),
  );
}

function conversation(id) {
  return { id, history: [] };
}

test("send/stop callbacks stay bound to the conversation that created them", async () => {
  const calls = [];
  const first = conversation("first");
  const second = conversation("second");
  const firstActions = createConversationActions(first, makeExecutors(calls));
  const secondActions = createConversationActions(second, makeExecutors(calls));
  await secondActions.onSend("hello", [], {}, "off", "act");
  await firstActions.onStop();
  assert.equal(calls[0][0], "send");
  assert.equal(calls[0][1], second);
  assert.equal(calls[1][0], "stop");
  assert.equal(calls[1][1], first);
});

test("mode/model/compact/plan callbacks use their bound conversation", async () => {
  const calls = [];
  const selected = conversation("selected");
  const actions = createConversationActions(selected, makeExecutors(calls));
  const model = { provider: "provider", name: "model" };
  const plan = { path: "plan.md", title: "Plan" };
  await actions.onModeChange("plan");
  await actions.onModelPreferenceChange("act", model, "off");
  await actions.onCompact(model, "off");
  await actions.onImplementPlanFresh(plan, "go");
  assert.deepEqual(calls.map(([name]) => name), ["changeMode", "changeModelPreference", "compact", "implementPlanFresh"]);
  for (const [name, boundConversation] of calls.map((call) => [call[0], call[1]])) {
    assert.equal(boundConversation, selected, `${name} must use selected conversation`);
  }
  assert.deepEqual(calls[1].slice(2), ["act", model, "off"]);
  assert.deepEqual(calls[3].slice(2), [plan, "go"]);
});
