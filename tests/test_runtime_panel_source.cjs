const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("src/index.tsx", "utf8");
const settingsSource = fs.readFileSync("src/settings.tsx", "utf8");
const inputRecoverySource = fs.readFileSync(
  "src/input-recovery-route.tsx",
  "utf8",
);

function sectionBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function assertOperationKeepsPanelOpen(name, body) {
  const accepted = body.indexOf("acceptRuntimeSnapshot(snapshot)");
  const caught = body.indexOf("} catch", accepted);

  assert.notEqual(accepted, -1, `${name} must accept the confirmed snapshot`);
  assert.notEqual(caught, -1, `${name} must retain an explicit failure path`);
  assert.doesNotMatch(
    body,
    /CloseSideMenus|RaiseWindowForGame|returnToGame/,
    `${name} must keep QAM open after both success and failure`,
  );
}

assertOperationKeepsPanelOpen(
  "toggle operation",
  sectionBetween(
    "const changeRuntimeOption = async",
    "const changeRuntimeValue = async",
  ),
);
assertOperationKeepsPanelOpen(
  "value operation",
  sectionBetween(
    "const changeRuntimeValue = async",
    "const invokeRuntimeAction = async",
  ),
);
assertOperationKeepsPanelOpen(
  "one-shot action",
  sectionBetween("const invokeRuntimeAction = async", "const removeBinding"),
);

assert.doesNotMatch(
  source,
  /返回游戏并恢复输入|requestReturnToGame/,
  "the removed global return-and-focus action must not remain in the panel",
);
assert.match(
  inputRecoverySource,
  /useReliableQuickAccessVisible\(\)/,
  "the global recovery watcher must observe the whole SteamOS Quick Access menu",
);
assert.match(
  inputRecoverySource,
  /qamInputRecoveryController\.observeVisibility\([\s\S]{0,100}visible[\s\S]{0,100}currentRunningAppId\(\)/,
  "QAM visibility transitions must drive the recovery controller",
);
assert.match(
  inputRecoverySource,
  /observeQuickAccessVisibility\(quickAccessVisible\)/,
  "the global watcher must forward the raw QAM visibility value",
);
assert.match(
  source,
  /openSettingsPage[\s\S]{0,220}cancelInputRecoverySession\(\)[\s\S]{0,120}CloseSideMenus/,
  "opening settings must cancel recovery before closing QAM",
);
assert.match(
  source,
  /openRecoveryPage[\s\S]{0,220}cancelInputRecoverySession\(\)[\s\S]{0,120}CloseSideMenus/,
  "opening recovery must cancel recovery before closing QAM",
);
assert.match(
  settingsSource,
  /checked=\{settings\.restore_input_on_qam_close\}[\s\S]{0,320}persist\([\s\S]{0,180}restore_input_on_qam_close: value/,
  "the input recovery setting must be a persisted ToggleField",
);
assert.match(
  settingsSource,
  /checked=\{settings\.auto_search_and_add\}[\s\S]{0,360}persist\([\s\S]{0,180}auto_search_and_add: value/,
  "automatic search-and-add must be an explicit persisted ToggleField",
);
assert.match(
  settingsSource,
  /关闭时仍会自动填入游戏名，只进行手动搜索/,
  "the setting must explain the disabled fill-only behavior",
);
assert.match(
  source,
  /<Focusable[\s\S]*onGamepadFocus=\{\(\) => setGamepadFocused\(true\)\}[\s\S]*onGamepadBlur=\{\(\) => setGamepadFocused\(false\)\}/,
  "tooltip rows must consume Decky gamepad focus events",
);
assert.match(
  source,
  /Boolean\(tooltip\)[\s\S]{0,160}gamepadFocused[\s\S]{0,160}tooltipPinned/,
  "tooltip visibility must include gamepad focus and a pinned state",
);
assert.match(
  source,
  /onActivate=\{[\s\S]{0,180}rowDisabled && tooltip[\s\S]{0,180}setTooltipPinned/,
  "a disabled trainer control must retain an independent explanation action",
);
assert.doesNotMatch(
  source,
  /runtime\?\.connected &&\s*runtime\.options\.map/,
  "a bridge disconnect must not remove the last known trainer menu",
);
assert.match(
  source,
  /runtime &&\s*runtime\.options\.map/,
  "the last known trainer menu must remain rendered while reconnecting",
);
assert.match(
  source,
  /connected=\{runtime\.connected === true\}/,
  "each retained row must receive the live bridge connection state",
);
assert.match(
  source,
  /bridge 连接已断开，状态暂不可用/,
  "retained controls must explain why they are temporarily disabled",
);
assert.match(
  source,
  /上次识别的 \$\{runtime\.options\.length\} 个修改项已保留/,
  "the panel must explain that disconnect did not remove the binding or menu",
);

console.log("TrainerDeck runtime panel source checks passed");
