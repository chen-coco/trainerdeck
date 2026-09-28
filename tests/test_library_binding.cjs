const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

// Exercise the real shared binding transaction with a local installation.
const source = fs.readFileSync("src/index.tsx", "utf8");
const start = source.indexOf("const installAndBind = useCallback(async (");
const endMarker = "}, [acceptRuntimeSnapshot, appendWarning]);";
const end = source.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start);
const transaction = source.slice(start, end + endMarker.length)
  .replace("const installAndBind = useCallback(async (", "const installAndBind = async (")
  .replace(endMarker, "};");
const compiled = ts.transpileModule(`${transaction}\nexports.bind = installAndBind;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

const installation = { id: "local", folder: "/trainers/game/copy-2", executable: "/trainers/game/copy-2/trainer.exe", title: "Local trainer" };
const target = { appId: 10, targetType: "shortcut", shortcutExe: "/games/game.exe", launchOptionsField: "app", launchOptions: "old", name: "Game", running: true };

function harness(overrides = {}) {
  const calls = [];
  const freshBinding = { id: "previous", original_launch_options: "original options" };
  const context = {
    exports: {},
    targetRef: { current: target }, selectedAppIdRef: { current: 10 },
    installInFlight: { current: null }, bindingRef: { current: null },
    sharedInstallLock: () => null, acquireSharedInstallLock: () => true,
    releaseSharedInstallLock: () => calls.push(["unlock"]),
    t: (zh) => zh, errorText: String,
    notify: (...args) => calls.push(["notice", ...args]),
    setBusy() {}, setLibraryRefreshKey() {}, setBinding() {}, setBindingReady() {},
    setNeedsRestart: (value) => calls.push(["restart", value]),
    acceptRuntimeSnapshot() {}, appendWarning() {},
    withTimeout: (promise) => promise,
    downloadTrainer: async () => { calls.push(["download"]); return installation; },
    prepareTrainerBridge: async (...args) => { calls.push(["prepare", ...args]); return { supported: true, launch_executable: "/bridge/launcher.exe" }; },
    readAppDetails: async () => target,
    getBinding: async () => freshBinding,
    launchOptionsBeforeBinding: (_details, binding) => { assert.equal(binding, freshBinding); return binding.original_launch_options; },
    buildTrainerLaunchOptions: (...args) => { calls.push(["options", ...args]); return "new options"; },
    bindTrainer: async (...args) => { calls.push(["bind", ...args]); return installation; },
    writeLaunchOptionsSafely: async (...args) => calls.push(["write", ...args]),
    getTrainerRuntime: async () => ({ app_id: 10 }),
    ...overrides,
  };
  vm.runInNewContext(compiled, context);
  return { context, calls, bind: () => context.exports.bind(installation, { installation, allowExplicitTargetSelection: true }) };
}

(async () => {
  const reused = harness();
  assert.equal(await reused.bind(), true);
  assert.equal(reused.calls.some(([name]) => name === "download"), false, "library binding must never download again");
  assert.deepEqual(reused.calls.find(([name]) => name === "prepare").slice(1), [10, "local", installation.folder], "prepare the exact selected folder");
  const bindingCall = reused.calls.find(([name]) => name === "bind");
  assert.equal(bindingCall.at(-1), installation.folder, "persist the exact selected installation");
  assert.ok(reused.calls.indexOf(bindingCall) < reused.calls.findIndex(([name]) => name === "write"), "record recovery data before changing Steam launch options");
  assert.equal(reused.context.installInFlight.current, null);
  assert.equal(reused.context.bindingRef.current, installation);

  const changedShortcut = harness({ readAppDetails: async () => ({ ...target, shortcutExe: "/different/game.exe" }) });
  assert.equal(await changedShortcut.bind(), false);
  assert.equal(changedShortcut.calls.some(([name]) => name === "bind" || name === "write"), false, "a replaced shortcut must not receive launch options");
  assert.equal(changedShortcut.context.installInFlight.current, null);

  const missing = harness({ prepareTrainerBridge: async () => { throw new Error("installation no longer exists"); } });
  assert.equal(await missing.bind(), false);
  assert.equal(missing.calls.some(([name]) => name === "download" || name === "write"), false, "stale library entries must not fall back to downloading or writing");

  const owned = harness({ bindTrainer: async () => { throw new Error("bound to another game"); } });
  assert.equal(await owned.bind(), false);
  assert.equal(owned.calls.some(([name]) => name === "write"), false, "ownership rejection must leave Steam settings untouched");
  assert.equal(owned.context.installInFlight.current, null);
  console.log("TrainerDeck local-library binding transaction checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
