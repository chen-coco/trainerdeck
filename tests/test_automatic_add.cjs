const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(
  path.join(root, "src", "automatic-add.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: "automatic-add.ts",
}).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)(
  require,
  loaded,
  loaded.exports,
);

const { decideAutomaticAdd } = loaded.exports;
const ready = {
  appId: 2072450,
  backendReady: true,
  bindingReady: true,
  cheatDeckConfigured: false,
  enabled: true,
  hasBinding: false,
  query: "Like a Dragon: Infinite Wealth",
  queryReady: true,
  settingsReady: true,
  targetRunning: true,
};

assert.deepEqual(
  decideAutomaticAdd({ ...ready, settingsReady: false }),
  { action: "wait" },
  "settings loading must fail closed",
);
assert.deepEqual(
  decideAutomaticAdd({ ...ready, queryReady: false }),
  { action: "wait" },
  "query loading must not start automatic work",
);
assert.deepEqual(
  decideAutomaticAdd({ ...ready, enabled: false }),
  { action: "wait" },
  "the disabled-by-default feature must not search or add",
);
assert.deepEqual(
  decideAutomaticAdd({ ...ready, backendReady: false }),
  { action: "wait" },
  "an unavailable backend must block automatic installation",
);
assert.deepEqual(
  decideAutomaticAdd({ ...ready, bindingReady: false }),
  { action: "wait" },
  "binding lookup must finish before treating null as unbound",
);
assert.deepEqual(
  decideAutomaticAdd({ ...ready, hasBinding: true }),
  { action: "wait" },
  "an existing TrainerDeck binding must prevent duplicate installation",
);
assert.deepEqual(
  decideAutomaticAdd({ ...ready, cheatDeckConfigured: true }),
  { action: "skip-cheatdeck", key: "cheatdeck:2072450" },
  "an existing CheatDeck launch configuration must be skipped",
);
assert.deepEqual(
  decideAutomaticAdd({
    ...ready,
    query: "  Like a Dragon: Infinite Wealth  ",
  }),
  {
    action: "run",
    key: "add:2072450:Like a Dragon: Infinite Wealth",
    query: "Like a Dragon: Infinite Wealth",
  },
  "a fully ready clean target must run once under a stable trimmed key",
);

console.log("TrainerDeck automatic-add decision tests passed");
