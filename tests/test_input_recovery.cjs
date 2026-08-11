const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(
  path.join(root, "src", "input-recovery.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: "input-recovery.ts",
}).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)(
  require,
  loaded,
  loaded.exports,
);

const {
  QamInputRecoveryController,
  restoreForegroundControllerInput,
} = loaded.exports;

function successfulQamSession() {
  const controller = new QamInputRecoveryController(false, 2072450);
  assert.equal(controller.observeVisibility(false, 2072450), null);
  assert.equal(controller.observeVisibility(true, 2072450), null);
  const operation = controller.beginOperation(2072450);
  assert.equal(controller.finishOperation(operation, true), null);
  return controller;
}

assert.deepEqual(
  successfulQamSession().observeVisibility(false, 2072450),
  { appId: 2072450 },
  "a confirmed trainer operation must recover on the QAM true-to-false edge",
);

{
  const controller = new QamInputRecoveryController(false, 2072450);
  controller.observeVisibility(true, 2072450);
  assert.equal(
    controller.observeVisibility(false, 2072450),
    null,
    "closing QAM without a trainer operation must not recover",
  );
}

{
  const controller = new QamInputRecoveryController(true, 2072450);
  const operation = controller.beginOperation(2072450);
  assert.equal(controller.observeVisibility(false, 2072450), null);
  assert.deepEqual(
    controller.finishOperation(operation, true),
    { appId: 2072450 },
    "an operation that finishes after the panel unmounts must still recover",
  );
}

{
  const controller = new QamInputRecoveryController(true, 2072450);
  const stale = controller.beginOperation(2072450);
  controller.observeVisibility(false, 2072450);
  controller.observeVisibility(true, 2072450);
  assert.equal(
    controller.finishOperation(stale, true),
    null,
    "reopening QAM must invalidate an operation from the previous session",
  );
  assert.equal(controller.observeVisibility(false, 2072450), null);
}

{
  const controller = new QamInputRecoveryController(true, 2072450);
  const operation = controller.beginOperation(2072450);
  controller.observeVisibility(false, 2072450);
  assert.equal(
    controller.finishOperation(operation, false),
    null,
    "a failed trainer operation must not schedule recovery",
  );
}

{
  const controller = successfulQamSession();
  controller.cancelCurrentSession();
  assert.equal(
    controller.observeVisibility(false, 2072450),
    null,
    "programmatic navigation must cancel the pending close action",
  );
}

{
  const controller = new QamInputRecoveryController(true, 2072450);
  const stale = controller.beginOperation(2072450);
  controller.reset(999, true);
  assert.equal(controller.finishOperation(stale, true), null);
  assert.equal(controller.observeVisibility(false, 999), null);
}

{
  const controller = successfulQamSession();
  assert.deepEqual(
    controller.observeVisibility(false, 2072450),
    { appId: 2072450 },
  );
  assert.equal(
    controller.observeVisibility(false, 2072450),
    null,
    "one QAM session must issue at most one recovery",
  );
  controller.observeVisibility(true, 2072450);
  assert.equal(
    controller.observeVisibility(false, 2072450),
    null,
    "a later QAM session must not inherit the previous dirty flag",
  );
}

{
  const controller = new QamInputRecoveryController(true, 2072450);
  const first = controller.beginOperation(2072450);
  const second = controller.beginOperation(2072450);
  controller.observeVisibility(false, 2072450);
  assert.equal(controller.finishOperation(first, true), null);
  assert.deepEqual(
    controller.finishOperation(second, false),
    { appId: 2072450 },
    "recovery must wait for every in-flight command and retain any success",
  );
}

(async () => {
  {
    const calls = [];
    const result = await restoreForegroundControllerInput(
      { appId: 2072450 },
      {
        currentRunningAppId: () => 2072450,
        raiseWindowForGame: async (appId) => {
          calls.push(appId);
          return 2;
        },
      },
    );
    assert.equal(result.status, "restored");
    assert.deepEqual(calls, [2072450]);
  }

  {
    const calls = [];
    const result = await restoreForegroundControllerInput(
      { appId: 2072450 },
      {
        currentRunningAppId: () => 999,
        raiseWindowForGame: async (appId) => {
          calls.push(appId);
          return 2;
        },
      },
    );
    assert.equal(result.status, "app-changed");
    assert.deepEqual(calls, []);
  }

  {
    const result = await restoreForegroundControllerInput(
      { appId: 2072450 },
      {
        currentRunningAppId: () => 2072450,
        raiseWindowForGame: null,
      },
    );
    assert.equal(result.status, "focus-api-unavailable");
  }

  for (const nativeResult of [1, 3]) {
    const result = await restoreForegroundControllerInput(
      { appId: 2072450 },
      {
        currentRunningAppId: () => 2072450,
        raiseWindowForGame: async () => nativeResult,
      },
    );
    assert.equal(result.status, "focus-rejected");
    assert.match(result.detail, new RegExp(String(nativeResult)));
  }

  {
    const result = await restoreForegroundControllerInput(
      { appId: 2072450 },
      {
        currentRunningAppId: () => 2072450,
        raiseWindowForGame: async () => {
          throw new Error("native focus failed");
        },
      },
    );
    assert.equal(result.status, "focus-failed");
    assert.match(result.detail, /native focus failed/);
  }

  {
    const result = await restoreForegroundControllerInput(
      { appId: 2072450 },
      {
        currentRunningAppId: () => 2072450,
        focusTimeoutMs: 5,
        raiseWindowForGame: () => new Promise(() => {}),
      },
    );
    assert.equal(result.status, "focus-timeout");
  }

  const indexSource = fs.readFileSync(
    path.join(root, "src", "index.tsx"),
    "utf8",
  );
  const routeSource = fs.readFileSync(
    path.join(root, "src", "input-recovery-route.tsx"),
    "utf8",
  );
  const settingsSource = fs.readFileSync(
    path.join(root, "src", "settings.tsx"),
    "utf8",
  );

  assert.match(
    indexSource,
    /registerInputRecoveryUi\(\)[\s\S]*unregisterInputRecoveryUi\(\)/,
    "the QAM watcher and transition route must follow the plugin lifecycle",
  );
  assert.match(
    routeSource,
    /addGlobalComponent\([\s\S]*TrainerDeckInputRecoveryWatcher/,
    "the close watcher must live outside the unmounted plugin panel",
  );
  assert.match(
    routeSource,
    /INPUT_RECOVERY_ROUTE_PATTERN[\s\S]*:token/,
    "the full-screen route must reject stale recovery sessions by token",
  );
  assert.match(
    routeSource,
    /GamepadUIMainWindowInstance[\s\S]*ticket\.router\.NavigateBack\(\)/,
    "navigation and back must use the same captured main-window router",
  );
  assert.match(
    routeSource,
    /waitForTwoPaints\(view\)[\s\S]*wait\(view, ROUTE_MINIMUM_DWELL_MS\)/,
    "the Steam UI route must paint and dwell before raising the game",
  );
  assert.match(
    routeSource,
    /function routeUnmounted\(ticket:[\s\S]*finishNativeRaise\(ticket\)/,
    "the native game raise must be owned by the coordinator after route cleanup",
  );
  assert.match(
    routeSource,
    /getGamepadNavigationTrees\(\)[\s\S]*setTimeout\(refresh,[\s\S]*250/,
    "QAM window discovery must retry when the navigation tree is unavailable",
  );
  assert.doesNotMatch(
    routeSource,
    /QAM_CLOSE_SETTLE_MS/,
    "the captured main router must navigate on the QAM close edge without a stale-focus delay",
  );
  assert.doesNotMatch(
    routeSource,
    /toaster\.toast|未能恢复游戏输入|焦点未确认/,
    "input recovery failures must stay in diagnostic logs without user notifications",
  );
  assert.match(
    routeSource,
    /useEffect\(\(\) => \{[\s\S]{0,180}commitTicket\(ticket\)/,
    "a token may only become mounted after the route commits",
  );
  assert.match(
    routeSource,
    /ticket\.state === "mounted" && !ticket\.routeMounted[\s\S]{0,220}ticket\.routeMounted = true/,
    "Strict Effects setup replay must reacquire the same mounted token",
  );
  assert.match(
    routeSource,
    /ticket\.focusConfirmed\s*=[\s\S]{0,140}signal\.resolved[\s\S]{0,120}documentHasForegroundFocus/,
    "a pure timeout must not be reported as a confirmed focus transition",
  );
  assert.doesNotMatch(
    source + indexSource,
    /SetFocusedAppWindowID|captureFocusedGameWindow|gameWindowId/,
    "the obsolete frontend WindowStore focus toggle must be removed",
  );
  assert.match(
    indexSource,
    /settingsRef\.current\.restore_input_on_qam_close[\s\S]{0,180}qamInputRecoveryController\.beginOperation/,
    "disabled recovery must not dirty a QAM session",
  );
  assert.match(
    settingsSource,
    /短暂进入整屏焦点过渡[\s\S]{0,120}Steam 原生接口返回游戏/,
    "the setting must describe the new visible focus transition accurately",
  );

  console.log("QAM input recovery tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
