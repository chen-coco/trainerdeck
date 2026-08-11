const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("src/index.tsx", "utf8");

assert.match(
  source,
  /resultMode === "manual" && target\.appId === selectedAppId/,
  "a manually selected search result must bind to the current target",
);
assert.match(
  source,
  /latestDetails\.launchOptionsField/,
  "the binding record must remember the Steam field that was actually used",
);
assert.doesNotMatch(
  source,
  /assertTargetUnchanged|operationWasRunning/,
  "a transient running-state change must not invalidate an explicit manual target",
);
assert.match(
  source,
  /operationShortcutExe[\s\S]*非 Steam 快捷方式在下载期间已被替换/,
  "a pinned non-Steam target must still verify its executable identity",
);
assert.doesNotMatch(
  source,
  /Steam AppID \$\{target/,
  "the main panel must not ask users to reason about an internal AppID",
);
assert.match(
  source,
  /"trainer_window_visible_v1"/,
  "the frontend must reject the old permanently-hidden trainer bridge",
);
assert.match(
  source,
  /原生修改器窗口与 TrainerDeck 菜单同时可用/,
  "a connected visible-window bridge must explicitly report both interfaces",
);
assert.match(
  source,
  /managedLaunchExecutable,[\s\S]*installed\.executable/,
  "initial binding must retain trainer identity when handing off CheatDeck",
);
assert.match(
  source,
  /bridge\.launch_executable,[\s\S]*binding\.executable/,
  "bridge repair must retain the installed trainer identity during CheatDeck handoff",
);
assert.match(
  source,
  /"value_command_receipt_v1"/,
  "the frontend must require unambiguous staged/applied value receipts",
);
assert.match(
  source,
  /"localized_widget_fallback_v1"/,
  "the frontend must require the corrected localized widget parser",
);
assert.match(
  source,
  /"nonblocking_ui_commands_v1"/,
  "the frontend must require nonblocking trainer UI commands",
);
assert.match(
  source,
  /"independent_heartbeat_v1"/,
  "the frontend must require a heartbeat independent from UI capture",
);
assert.doesNotMatch(
  source,
  /"window_focus_suppression_v1"/,
  "the obsolete hidden-window bridge capability must not be accepted",
);
assert.doesNotMatch(
  source,
  /settings\.auto_search\b|lastAutoSearch|resolveSteamSearchName/,
  "the removed search-only setting and its online name resolver must not drive startup",
);
assert.match(
  source,
  /settingsStatus === "ready"[\s\S]{0,180}settings\.auto_search_and_add[\s\S]{0,180}target\?\.running/,
  "automatic work must stay fail-closed until settings are loaded and enabled",
);
assert.match(
  source,
  /const preflight = await readAppDetails\(operationAppId\)[\s\S]{0,1800}hasCheatDeckLaunchConfiguration\(preflight\)[\s\S]{0,2600}runSearch\(decision\.query, "automatic"\)/,
  "automatic search must inspect complete launch options and skip CheatDeck first",
);
assert.match(
  source,
  /entry\.search_match === "exact-app"[\s\S]{0,120}entry\.compatible_app_ids\?\.includes\(operationAppId\)[\s\S]{0,500}exactEntries\.size !== 1/,
  "automatic installation must require one unique exact AppID match",
);
assert.match(
  source,
  /downloadTrainer\(entry\)[\s\S]{0,6500}hasCheatDeckLaunchConfiguration\(latestDetails\)[\s\S]{0,3500}bindTrainer/,
  "automatic binding must re-check managed launch options after downloading",
);
assert.match(
  source,
  /installInFlight\.current !== null[\s\S]{0,1400}installInFlight\.current = operationToken/,
  "downloads and binds must use a synchronous single-flight guard",
);
assert.match(
  source,
  /__trainerDeckInstallLockV1[\s\S]{0,1800}acquireSharedInstallLock[\s\S]{0,1800}releaseSharedInstallLock/,
  "the install single-flight guard must survive a remounted Decky panel",
);
assert.match(
  source,
  /bindingRetryAttempt > 0[\s\S]{0,1000}getBinding\(appId\)[\s\S]{0,1400}setBindingRetryAttempt/,
  "a transient binding-read failure must retry after the backend becomes ready",
);
assert.match(
  source,
  /getSettings\(\)[\s\S]{0,450}persisted\.auto_search_and_add === true/,
  "an automatic install must re-read the persisted switch before committing",
);
assert.match(
  source,
  /automaticDownloadWasHandled\(operationKey\)/,
  "a remounted panel must recognize an already-started automatic download",
);
assert.match(
  source,
  /markAutomaticDownloadHandled\(automaticOperationKey\)[\s\S]{0,400}downloadTrainer\(entry\)/,
  "only a download that reached its final preflight may become globally handled",
);

console.log("TrainerDeck binding-flow source checks passed");
