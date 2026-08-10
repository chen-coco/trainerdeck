const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "steam.ts"), "utf8");
const panelSource = fs.readFileSync(path.join(root, "src", "index.tsx"), "utf8");
const recoverySource = fs.readFileSync(
  path.join(root, "src", "recovery.tsx"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: "steam.ts",
}).outputText;
const loaded = { exports: {} };
const requestedUrls = [];

const jsonResponse = (payload, ok = true, status = ok ? 200 : 500) => ({
  ok,
  status,
  json: async () => payload,
});

const translationPayload = (query) => {
  if (query === "师父") {
    return {
      responseData: { translatedText: "Sifu", match: 1 },
      matches: [
        { translation: "Sifu", quality: 100, match: 1 },
        { translation: "Master", quality: 100, match: 1 },
      ],
    };
  }
  if (query.includes("师父")) {
    return {
      responseData: {
        translatedText: "English name of the video game Master",
        match: 0.85,
      },
      matches: [{ translation: "Master", quality: 70, match: 0.85 }],
    };
  }
  if (query.includes("战神")) {
    return null;
  }
  if (query.includes("如龙")) {
    return {
      responseData: { translatedText: "Like a Dragon" },
      matches: [
        { translation: "Like a Dragon", quality: 100 },
        { translation: "Yakuza", quality: 100 },
      ],
    };
  }
  if (query.includes("赛博朋克2077")) {
    return {
      responseData: { translatedText: "Cyberpunk 2077" },
      matches: [],
    };
  }
  if (query.includes("多名称测试")) {
    return {
      responseData: { translatedText: "Alpha Odyssey" },
      matches: [{ translation: "Legacy Saga", quality: 100 }],
    };
  }
  return { responseData: {}, matches: [] };
};

const wikimediaPayload = (query) => {
  if (query.includes("战神")) {
    return {
      query: {
        pages: [
          {
            index: 1,
            title: "战神系列",
            description: "电子游戏系列",
            langlinks: [
              { lang: "en", title: "God of War (video game series)" },
            ],
          },
        ],
      },
    };
  }
  if (query.includes("师父")) {
    return {
      query: {
        pages: [
          {
            index: 1,
            title: "师父 (游戏)",
            description: "2022年电子游戏",
            langlinks: [{ lang: "en", title: "Sifu (video game)" }],
          },
          {
            index: 2,
            title: "师傅",
            description: "维基媒体消歧义页",
            langlinks: [{ lang: "en", title: "Shifu (disambiguation)" }],
          },
        ],
      },
    };
  }
  return { query: { pages: [] } };
};

const steamStoreItems = (term) => {
  switch (term) {
    case "God of War":
      return [
        { type: "app", id: 1593500, name: "God of War" },
        { type: "app", id: 2322010, name: "God of War Ragnarok" },
      ];
    case "Like a Dragon":
      return [
        {
          type: "app",
          id: 2072450,
          name: "Like a Dragon: Infinite Wealth",
        },
        { type: "app", id: 1805480, name: "Like a Dragon: Ishin!" },
        {
          type: "app",
          id: 2375550,
          name: "Like a Dragon Gaiden: The Man Who Erased His Name",
        },
      ];
    case "Yakuza":
      return [
        { type: "app", id: 638970, name: "Yakuza 0" },
        { type: "app", id: 834530, name: "Yakuza Kiwami" },
      ];
    case "Cyberpunk 2077":
      return [
        { type: "app", id: 1091500, name: "Cyberpunk 2077" },
        {
          type: "app",
          id: 2138330,
          name: "Cyberpunk 2077: Phantom Liberty",
        },
      ];
    case "Sifu":
      return [{ type: "app", id: 2138710, name: "Sifu" }];
    case "Alpha Odyssey":
      return [{ type: "app", id: 991001, name: "Alpha Odyssey" }];
    case "Legacy Saga":
      return [{ type: "app", id: 991002, name: "Legacy Saga" }];
    default:
      return [];
  }
};

const localRequire = (id) => {
  if (id === "@decky/api") {
    return {
      fetchNoCors: async (url, init = {}) => {
        requestedUrls.push(url);
        if (url.includes("appids=999")) {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          });
        }
        const parsed = new URL(url);
        if (parsed.hostname === "api.mymemory.translated.net") {
          const payload = translationPayload(parsed.searchParams.get("q") ?? "");
          return payload
            ? jsonResponse(payload)
            : jsonResponse({ error: "unavailable" }, false, 503);
        }
        if (parsed.hostname === "zh.wikipedia.org") {
          return jsonResponse(
            wikimediaPayload(parsed.searchParams.get("gsrsearch") ?? ""),
          );
        }
        if (url.includes("/api/storesearch/")) {
          const items = steamStoreItems(parsed.searchParams.get("term") ?? "");
          return jsonResponse({ total: items.length, items });
        }
        if (url.includes("/api/appdetails")) {
          return jsonResponse({
            1091500: {
              success: true,
              data: { name: "Cyberpunk 2077" },
            },
            2072450: {
              success: true,
              data: { name: "Like a Dragon: Infinite Wealth" },
            },
          });
        }
        return jsonResponse({}, false, 404);
      },
    };
  }
  if (id === "@decky/ui") {
    return { Router: { MainRunningApp: undefined } };
  }
  return require(id);
};
new Function("require", "module", "exports", compiled)(
  localRequire,
  loaded,
  loaded.exports,
);

const {
  buildTrainerLaunchOptions,
  detectCheatDeckTrainerExecutable,
  hasCheatDeckLaunchConfiguration,
  hasCheatDeckLaunchOptions,
  hasManagedTrainerLaunchOptions,
  ownsTrainerLaunchOptions,
  readAppDetails,
  readAppSummary,
  recoverTrainerLaunchOptions,
  resolveManualSteamSearch,
  resolveManualSteamSearchPlan,
  resolveSteamSearchName,
  removeTrainerLaunchOptions,
  removeOwnedTrainerLaunchOptions,
  shellDoubleQuote,
  shlexQuote,
  writeLaunchOptionsSafely,
} = loaded.exports;

let recoveryDetails;
const recoveryWrites = [];
let recoveryUnbinds = 0;
const recoveryCompiled = ts.transpileModule(recoverySource, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: "recovery.tsx",
}).outputText;
const recoveryLoaded = { exports: {} };
new Function("require", "module", "exports", recoveryCompiled)(
  (id) => {
    if (id === "@decky/api") {
      return { toaster: { toast() {} } };
    }
    if (id === "@decky/ui") {
      return {
        ButtonItem() {},
        PanelSection() {},
        PanelSectionRow() {},
      };
    }
    if (id === "react") {
      return {
        useCallback: (value) => value,
        useEffect() {},
        useMemo: (factory) => factory(),
        useRef: (value) => ({ current: value }),
        useState: (value) => [value, () => {}],
      };
    }
    if (id === "react/jsx-runtime") {
      return { jsx() {}, jsxs() {} };
    }
    if (id === "./async") {
      return { withTimeout: (promise) => promise };
    }
    if (id === "./backend") {
      return {
        listBindings: async () => [],
        unbindTrainer: async () => {
          recoveryUnbinds += 1;
          return true;
        },
      };
    }
    if (id === "./steam") {
      return {
        readAppDetails: async () => recoveryDetails,
        recoverTrainerLaunchOptions,
        writeLaunchOptionsSafely: async (...args) => {
          recoveryWrites.push(args);
        },
      };
    }
    return require(id);
  },
  recoveryLoaded,
  recoveryLoaded.exports,
);
const { restoreTrainerLaunchBinding } = recoveryLoaded.exports;

assert.equal(
  source.includes("COMMON_CHINESE_ALIASES"),
  false,
  "production search must not contain the removed per-game alias dictionary",
);
assert.equal(
  source.includes('"战神"'),
  false,
  "the God of War mapping must come from the mocked online response",
);
assert.equal(
  source.includes('"师父"') || source.includes('"Sifu"'),
  false,
  "the Sifu association must come from online evidence or the shortcut path",
);
const executable = "/home/deck/Downloads/trainer/Game Trainer.exe";
const sidecar =
  `PROTON_REMOTE_DEBUG_CMD="'${executable}'" ` +
  `PRESSURE_VESSEL_FILESYSTEMS_RW="/home/deck/Downloads/trainer"`;
const managed = sidecar;

assert.equal(
  buildTrainerLaunchOptions("", executable),
  `${managed} %command%`,
);
assert.equal(
  buildTrainerLaunchOptions("-dx12 --skip-intro", executable),
  `${managed} %command% -dx12 --skip-intro`,
);
assert.equal(
  buildTrainerLaunchOptions("%command% -dx12", executable),
  `${managed} %command% -dx12`,
);
assert.equal(
  buildTrainerLaunchOptions("MANGOHUD=1 %command% -dx12", executable),
  `${managed} MANGOHUD=1 %command% -dx12`,
);
const cheatDeck =
  `PROTON_REMOTE_DEBUG_CMD="'/old/trainer.exe'" ` +
  `PRESSURE_VESSEL_FILESYSTEMS_RW="/old" %command% -dx12`;
assert.equal(hasManagedTrainerLaunchOptions(cheatDeck), true);
assert.equal(hasCheatDeckLaunchOptions(cheatDeck), true);
assert.equal(
  hasCheatDeckLaunchConfiguration({
    launchOptions: cheatDeck,
    appLaunchOptions: cheatDeck,
    shortcutLaunchOptions: undefined,
  }),
  true,
  "a complete two-key CheatDeck launch configuration must be detected",
);
const incompleteCheatDeck =
  `PROTON_REMOTE_DEBUG_CMD="'/old/trainer.exe'" %command% -dx12`;
assert.equal(hasCheatDeckLaunchOptions(incompleteCheatDeck), false);
assert.equal(
  hasCheatDeckLaunchConfiguration({
    launchOptions: incompleteCheatDeck,
    appLaunchOptions: incompleteCheatDeck,
    shortcutLaunchOptions: undefined,
  }),
  true,
  "one managed key must fail closed for unattended launch-option changes",
);
const mangoHudLaunchOptions = "MANGOHUD=1 %command% -dx12";
assert.equal(hasCheatDeckLaunchOptions(mangoHudLaunchOptions), false);
assert.equal(
  hasCheatDeckLaunchConfiguration({
    launchOptions: mangoHudLaunchOptions,
    appLaunchOptions: mangoHudLaunchOptions,
    shortcutLaunchOptions: cheatDeck,
  }),
  true,
  "CheatDeck configuration in the shortcut field must be detected",
);
assert.equal(
  hasCheatDeckLaunchConfiguration({
    launchOptions: mangoHudLaunchOptions,
    appLaunchOptions: mangoHudLaunchOptions,
    shortcutLaunchOptions: mangoHudLaunchOptions,
  }),
  false,
  "ordinary MangoHud launch options must not be classified as CheatDeck",
);
assert.throws(
  () => buildTrainerLaunchOptions(cheatDeck, executable),
  /无法安全交接/,
);
assert.equal(
  detectCheatDeckTrainerExecutable(cheatDeck),
  "/old/trainer.exe",
);
assert.equal(
  buildTrainerLaunchOptions(
    cheatDeck,
    executable,
    "/old/trainer.exe",
  ),
  `${managed} %command% -dx12`,
);
assert.equal(
  buildTrainerLaunchOptions(
    cheatDeck,
    "/old/trainer.exe",
    "/old/trainer.exe",
  ),
  cheatDeck,
  "an equivalent CheatDeck launch must remain unchanged",
);
for (const compatible of [
  `PROTON_REMOTE_DEBUG_CMD=''"'"'/old/My Trainer.exe'"'"'' ` +
    `PRESSURE_VESSEL_FILESYSTEMS_RW=/old %command%`,
  `PROTON_REMOTE_DEBUG_CMD="'/old/My Trainer.exe'" ` +
    `PRESSURE_VESSEL_FILESYSTEMS_RW="/old" %command%`,
  `PROTON_REMOTE_DEBUG_CMD='"/old/My Trainer.exe"' ` +
    `PRESSURE_VESSEL_FILESYSTEMS_RW='/old' %command%`,
  `PROTON_REMOTE_DEBUG_CMD='/old/My\\ Trainer.exe' ` +
    `PRESSURE_VESSEL_FILESYSTEMS_RW=/old %command%`,
]) {
  assert.equal(
    detectCheatDeckTrainerExecutable(compatible),
    "/old/My Trainer.exe",
  );
}
for (const unsafe of [
  `PROTON_REMOTE_DEBUG_CMD="'/old/trainer.exe' --flag" ` +
    `PRESSURE_VESSEL_FILESYSTEMS_RW="/old" %command%`,
  `PROTON_REMOTE_DEBUG_CMD="'/old/trainer.exe'" %command%`,
  `PROTON_REMOTE_DEBUG_CMD="'/old/trainer.exe'" ` +
    `PRESSURE_VESSEL_FILESYSTEMS_RW="/other" %command%`,
  `PROTON_REMOTE_DEBUG_CMD="'/old/trainer.exe'" ` +
    `PROTON_REMOTE_DEBUG_CMD="'/old/second.exe'" ` +
    `PRESSURE_VESSEL_FILESYSTEMS_RW="/old" %command%`,
  `PROTON_REMOTE_DEBUG_CMD="'/old/trainer.exe'" ` +
    `PRESSURE_VESSEL_FILESYSTEMS_RW="/old" %command% && bad`,
  `gamescope PROTON_REMOTE_DEBUG_CMD="'/old/trainer.exe'" ` +
    `PRESSURE_VESSEL_FILESYSTEMS_RW="/old" %command%`,
  `'PROTON_REMOTE_DEBUG_CMD="/old/trainer.exe"' ` +
    `PRESSURE_VESSEL_FILESYSTEMS_RW="/old" %command%`,
  `PROTON_'REMOTE'_DEBUG_CMD="'/old/trainer.exe'" ` +
    `PRESSURE_VESSEL_FILESYSTEMS_RW="/old" %command%`,
  `PROTON_REMOTE_DEBUG_CMD="'/old/trainer.exe'" ` +
    `PRESSURE_VESSEL_FILESYSTEMS_RW="/old" '%command%'`,
]) {
  assert.equal(detectCheatDeckTrainerExecutable(unsafe), null);
  assert.throws(
    () => buildTrainerLaunchOptions(unsafe, executable, "/old/trainer.exe"),
    /无法安全交接/,
  );
}
assert.throws(
  () => buildTrainerLaunchOptions(cheatDeck, executable, "/other/trainer.exe"),
  /无法安全交接/,
);
assert.equal(
  removeTrainerLaunchOptions(cheatDeck),
  "%command% -dx12",
);
assert.equal(
  ownsTrainerLaunchOptions(
    buildTrainerLaunchOptions("%command% -dx12", executable),
    executable,
  ),
  true,
);
assert.equal(
  removeOwnedTrainerLaunchOptions(
    buildTrainerLaunchOptions("%command% -dx12", executable),
    executable,
  ),
  "%command% -dx12",
);
const changedByCheatDeck =
  `PROTON_REMOTE_DEBUG_CMD="'/other/trainer.exe'" ` +
  `PRESSURE_VESSEL_FILESYSTEMS_RW="/other" %command% -dx12`;
assert.equal(
  ownsTrainerLaunchOptions(changedByCheatDeck, executable),
  false,
);
assert.equal(
  removeOwnedTrainerLaunchOptions(changedByCheatDeck, executable),
  changedByCheatDeck,
);
const remoteOnly =
  `PROTON_REMOTE_DEBUG_CMD="'${executable}'" %command% --launcher-skip`;
assert.equal(ownsTrainerLaunchOptions(remoteOnly, executable), true);
assert.equal(
  removeOwnedTrainerLaunchOptions(remoteOnly, executable),
  "%command% --launcher-skip",
);
const pressureOnly =
  `PRESSURE_VESSEL_FILESYSTEMS_RW="/home/deck/Downloads/trainer" ` +
  "%command% --launcher-skip";
assert.equal(ownsTrainerLaunchOptions(pressureOnly, executable), false);
assert.equal(
  removeOwnedTrainerLaunchOptions(pressureOnly, executable),
  pressureOnly,
);

const originalLaunchOptions = "MANGOHUD=1 %command% --launcher-skip";
const appliedLaunchOptions = buildTrainerLaunchOptions(
  originalLaunchOptions,
  executable,
);
assert.deepEqual(
  recoverTrainerLaunchOptions(
    appliedLaunchOptions,
    executable,
    originalLaunchOptions,
    appliedLaunchOptions,
  ),
  {
    launchOptions: originalLaunchOptions,
    changed: true,
    owned: true,
    usedBackup: true,
  },
);
const handoffOriginal =
  `PROTON_REMOTE_DEBUG_CMD="'/old/trainer.exe'" ` +
  `PRESSURE_VESSEL_FILESYSTEMS_RW="/old" %command% -dx12`;
const handoffApplied = buildTrainerLaunchOptions(
  handoffOriginal,
  executable,
  "/old/trainer.exe",
);
assert.deepEqual(
  recoverTrainerLaunchOptions(
    handoffApplied,
    executable,
    handoffOriginal,
    handoffApplied,
  ),
  {
    launchOptions: handoffOriginal,
    changed: true,
    owned: true,
    usedBackup: true,
  },
);
assert.equal(
  recoverTrainerLaunchOptions(
    `${handoffApplied} --user-added`,
    executable,
    handoffOriginal,
    handoffApplied,
  ).launchOptions,
  `${handoffOriginal} --user-added`,
);
assert.deepEqual(
  recoverTrainerLaunchOptions(
    `${appliedLaunchOptions} --user-added`,
    executable,
    originalLaunchOptions,
    appliedLaunchOptions,
  ),
  {
    launchOptions: `${originalLaunchOptions} --user-added`,
    changed: true,
    owned: true,
    usedBackup: false,
  },
  "recovery must preserve user-added launch arguments",
);
const updatedBaseline = `${originalLaunchOptions} --user-added`;
const updatedApplied = buildTrainerLaunchOptions(updatedBaseline, executable);
assert.equal(
  recoverTrainerLaunchOptions(
    updatedApplied,
    executable,
    updatedBaseline,
    updatedApplied,
  ).launchOptions,
  updatedBaseline,
);
assert.deepEqual(
  recoverTrainerLaunchOptions(changedByCheatDeck, executable, "", ""),
  {
    launchOptions: changedByCheatDeck,
    changed: false,
    owned: false,
    usedBackup: false,
  },
);
assert.equal(
  recoverTrainerLaunchOptions(
    buildTrainerLaunchOptions("", executable),
    executable,
  ).launchOptions,
  "",
  "legacy recovery without an original snapshot removes the managed wrapper",
);
assert.equal(
  recoverTrainerLaunchOptions(
    buildTrainerLaunchOptions("", executable),
    [
      "/home/deck/Downloads/trainer/TrainerDeckBridgeLauncher.exe",
      executable,
    ],
  ).launchOptions,
  "",
);

assert.equal(
  shlexQuote("Assassin's Creed"),
  `'Assassin'"'"'s Creed'`,
);
assert.equal(
  shellDoubleQuote('a\\b"c$d`e'),
  String.raw`"a\\b\"c\$d\`e"`,
);
const unusual = "/home/deck/Assassin's Creed/$Cash`/Trainer.exe";
const unusualDirectory = unusual.slice(0, unusual.lastIndexOf("/"));
assert.equal(
  buildTrainerLaunchOptions("", unusual),
  `PROTON_REMOTE_DEBUG_CMD=${shellDoubleQuote(shlexQuote(unusual))} ` +
    `PRESSURE_VESSEL_FILESYSTEMS_RW=${shellDoubleQuote(unusualDirectory)} ` +
    "%command%",
);
assert.throws(
  () => buildTrainerLaunchOptions("", "/home/deck/%command%/Trainer.exe"),
  /不支持/,
);
assert.throws(
  () => buildTrainerLaunchOptions("", "/home/deck/bad\nname/Trainer.exe"),
  /不支持/,
);

const shortcutAppIds = new Set();
global.window = {
  appStore: {
    GetAppOverviewByAppID: (appId) => ({
      appid: appId,
      display_name: "Fallback Game",
      app_type: shortcutAppIds.has(appId) ? 0x40000000 : 1,
      BIsShortcut: () => shortcutAppIds.has(appId),
    }),
  },
  clearTimeout,
  setTimeout,
};
global.SteamClient = {
  Apps: {
    RegisterForAppDetails: () => ({ unregister() {} }),
  },
};

(async () => {
  const registerForAppDetails = SteamClient.Apps.RegisterForAppDetails;
  delete SteamClient.Apps.RegisterForAppDetails;
  await assert.rejects(
    readAppDetails(123, 5),
    /不提供应用详情 API/,
  );
  SteamClient.Apps.RegisterForAppDetails = registerForAppDetails;
  await assert.rejects(readAppDetails(123, 1), /读取目标启动项超时/);
  SteamClient.Apps.RegisterForAppDetails = (_appId, callback) => {
    setTimeout(() => callback({ strDisplayName: "Null Is Not Empty", strLaunchOptions: null }), 0);
    return { unregister() {} };
  };
  await assert.rejects(readAppDetails(123, 5), /读取目标启动项超时/);
  SteamClient.Apps.RegisterForAppDetails = (_appId, callback) => {
    setTimeout(() => callback({ strDisplayName: "Launcher-only Summary" }), 0);
    return { unregister() {} };
  };
  const summary = await readAppSummary(789, 50);
  assert.equal(summary.appId, 789);
  assert.equal(summary.name, "Launcher-only Summary");
  SteamClient.Apps.RegisterForAppDetails = (_appId, callback) => {
    setTimeout(() => callback({ strDisplayName: "Partial Game" }), 0);
    setTimeout(() => callback({ strLaunchOptions: "--launcher-skip" }), 2);
    return { unregister() {} };
  };
  const partial = await readAppDetails(123, 50);
  assert.equal(partial.appId, 123);
  assert.equal(partial.name, "Partial Game");
  assert.equal(partial.targetType, "steam");
  assert.equal(partial.launchOptions, "--launcher-skip");
  SteamClient.Apps.RegisterForAppDetails = (_appId, callback) => {
    setTimeout(
      () => callback({
        strDisplayName: "Explicit Empty",
        strLaunchOptions: "",
        strShortcutLaunchOptions: "",
      }),
      0,
    );
    return { unregister() {} };
  };
  const explicitEmpty = await readAppDetails(456, 50);
  assert.equal(explicitEmpty.name, "Explicit Empty");
  assert.equal(explicitEmpty.targetType, "steam");
  assert.equal(explicitEmpty.launchOptions, "");
  shortcutAppIds.add(3908080889);
  SteamClient.Apps.RegisterForAppDetails = (_appId, callback) => {
    setTimeout(
      () => callback({
        strDisplayName: "Non-Steam Sifu",
        strLaunchOptions: "--app-original",
      }),
      0,
    );
    setTimeout(
      () => callback({
        strShortcutExe: '\"/games/Sifu/Sifu.exe\"',
        strShortcutStartDir: '\"/games/Sifu\"',
        strShortcutLaunchOptions: "--shortcut-original",
      }),
      2,
    );
    return { unregister() {} };
  };
  const shortcutDetails = await readAppDetails(3908080889, 50);
  assert.equal(shortcutDetails.targetType, "shortcut");
  assert.equal(shortcutDetails.launchOptionsField, "app");
  assert.equal(shortcutDetails.launchOptions, "--app-original");
  assert.equal(shortcutDetails.appLaunchOptions, "--app-original");
  assert.equal(shortcutDetails.shortcutLaunchOptions, "--shortcut-original");
  assert.equal(shortcutDetails.shortcutExe, '\"/games/Sifu/Sifu.exe\"');
  const shortcutSummary = await readAppSummary(3908080889, 50);
  assert.equal(shortcutSummary.targetType, "shortcut");
  assert.equal(
    shortcutSummary.shortcutExe,
    '\"/games/Sifu/Sifu.exe\"',
    "a shortcut summary must merge the executable callback before resolving",
  );
  SteamClient.Apps.RegisterForAppDetails = (_appId, callback) => {
    setTimeout(
      () => callback({
        strDisplayName: "Late Common Field",
        strShortcutExe: '\"/games/LateCommon/Game.exe\"',
        strShortcutStartDir: '\"/games/LateCommon\"',
        strShortcutLaunchOptions: "--shortcut-arrived-first",
      }),
      0,
    );
    setTimeout(
      () => callback({ strLaunchOptions: "--preferred-app-arrived-late" }),
      2,
    );
    return { unregister() {} };
  };
  const lateCommonDetails = await readAppDetails(3908080889, 50);
  assert.equal(lateCommonDetails.targetType, "shortcut");
  assert.equal(lateCommonDetails.launchOptionsField, "app");
  assert.equal(lateCommonDetails.launchOptions, "--preferred-app-arrived-late");
  SteamClient.Apps.RegisterForAppDetails = (_appId, callback) => {
    setTimeout(
      () => callback({
        strDisplayName: "Legacy Shortcut Field Only",
        strShortcutLaunchOptions: "--legacy-shortcut-original",
      }),
      0,
    );
    setTimeout(
      () => callback({
        strShortcutExe: '\"/games/Legacy/Game.exe\"',
        strShortcutStartDir: '\"/games/Legacy\"',
      }),
      2,
    );
    return { unregister() {} };
  };
  const legacyShortcutDetails = await readAppDetails(3908080889, 250);
  assert.equal(legacyShortcutDetails.targetType, "shortcut");
  assert.equal(legacyShortcutDetails.launchOptionsField, "shortcut");
  assert.equal(
    legacyShortcutDetails.launchOptions,
    "--legacy-shortcut-original",
    "the shortcut-specific field remains a fallback when the common field is absent",
  );
  SteamClient.Apps.RegisterForAppDetails = (_appId, callback) => {
    setTimeout(
      () => callback({
        strDisplayName: "Empty Shortcut Options First",
        strShortcutLaunchOptions: "",
      }),
      0,
    );
    setTimeout(
      () => callback({
        strShortcutExe: '\"/games/Late/Game.exe\"',
        strShortcutStartDir: '\"/games/Late\"',
      }),
      2,
    );
    return { unregister() {} };
  };
  const lateShortcutSummary = await readAppSummary(3908080889, 50);
  assert.equal(
    lateShortcutSummary.shortcutExe,
    '\"/games/Late/Game.exe\"',
    "an explicit empty shortcut field must not discard later shortcut identity callbacks",
  );
  assert.doesNotMatch(
    source,
    /GetLaunchOptionsForApp/,
    "Steam launch-mode choices must never be mistaken for user launch arguments",
  );
  assert.equal(
    await resolveSteamSearchName(1091500, "赛博朋克 2077"),
    "Cyberpunk 2077",
  );
  assert.deepEqual(await resolveManualSteamSearch("赛博朋克2077"), {
    originalQuery: "赛博朋克2077",
    searchQuery: "Cyberpunk 2077",
    appId: 1091500,
    localizedName: undefined,
    warning: undefined,
  });

  const godOfWarPlan = await resolveManualSteamSearchPlan("战神");
  const godOfWarQuery = godOfWarPlan.queries.find(
    (candidate) => candidate.query === "God of War",
  );
  assert.ok(godOfWarQuery, "Wikimedia should dynamically resolve 战神");
  assert.deepEqual(
    godOfWarQuery.steamCandidates.map((candidate) => candidate.appId),
    [1593500, 2322010],
  );
  assert.ok(
    requestedUrls.some(
      (url) =>
        url.includes("zh.wikipedia.org") &&
        new URL(url).searchParams.get("gsrsearch") === "战神 电子游戏",
    ),
    "the Chinese-to-English association must be fetched dynamically",
  );

  const likeADragonPlan = await resolveManualSteamSearchPlan("如龙");
  const clusteredNames = likeADragonPlan.queries.map((candidate) =>
    candidate.query.toLocaleLowerCase(),
  );
  assert.ok(clusteredNames.includes("like a dragon"));
  assert.ok(clusteredNames.includes("yakuza"));
  assert.deepEqual(
    likeADragonPlan.queries
      .find((candidate) => candidate.query === "Like a Dragon")
      .steamCandidates.map((candidate) => candidate.appId),
    [2072450, 1805480, 2375550],
  );
  assert.deepEqual(
    likeADragonPlan.queries
      .find((candidate) => candidate.query === "Yakuza")
      .steamCandidates.map((candidate) => candidate.appId),
    [638970, 834530],
  );
  assert.ok(
    requestedUrls.some(
      (url) =>
        url.includes("api.mymemory.translated.net") &&
        (new URL(url).searchParams.get("q") ?? "").includes("如龙"),
    ),
    "Like a Dragon/Yakuza roots must come from online search data",
  );
  const multiNamePlan = await resolveManualSteamSearchPlan("多名称测试");
  assert.ok(
    multiNamePlan.queries.some((candidate) => candidate.query === "Alpha Odyssey"),
  );
  assert.ok(
    multiNamePlan.queries.some((candidate) => candidate.query === "Legacy Saga"),
    "every dynamic online name must remain searchable even with only one Steam result",
  );
  const sifuPlan = await resolveManualSteamSearchPlan("师父");
  assert.equal(
    sifuPlan.queries[0]?.query,
    "Sifu",
    "raw translation and game-page evidence must outrank the contextual Master mistranslation",
  );
  assert.ok(
    sifuPlan.queries
      .find((candidate) => candidate.query === "Sifu")
      ?.steamCandidates.some((candidate) => candidate.appId === 2138710),
  );
  const shortcutSifuPlan = await resolveManualSteamSearchPlan("师父", {
    appId: 3908080889,
    name: "师父数字豪华版",
    shortcutExe: '"/home/deck/Downloads/installed/Sifu/Sifu.exe"',
    shortcutStartDir: '"/home/deck/Downloads/installed/Sifu"',
  });
  assert.ok(
    shortcutSifuPlan.queries
      .find((candidate) => candidate.query === "Sifu")
      ?.steamCandidates.some((candidate) => candidate.appId === 3908080889),
    "the running non-Steam shortcut path must dynamically associate Sifu with its shortcut AppID",
  );
  assert.match(
    panelSource,
    /automaticNeedsResolution[\s\S]*resolveManualSteamSearchPlan/,
    "automatic search must resolve localized shortcut names before exact FLiNG search",
  );
  assert.match(
    panelSource,
    /installAndBind\(\s*entry,\s*\{\s*allowExplicitTargetSelection:\s*explicitTargetBinding,?\s*\}\s*\)/,
    "a manually selected result must use the download-and-bind launch-option path",
  );
  assert.match(
    panelSource,
    /resultMode === "automatic"[\s\S]*target\.targetType === "shortcut"[\s\S]*automaticShortcutBinding/,
    "an automatic result selected for the running non-Steam shortcut must be bindable",
  );
  assert.match(
    panelSource,
    /target\.targetType === "shortcut"[\s\S]*下载并绑定当前非 Steam 快捷方式/,
    "manual binding must clearly target the running non-Steam shortcut",
  );
  assert.equal(
    await resolveSteamSearchName(999, "超时回退名称", 10),
    "超时回退名称",
  );

  const legacyShortcutExecutable =
    "/home/deck/Downloads/trainer/Legacy/TrainerDeckBridgeLauncher.exe";
  const legacyShortcutApplied = buildTrainerLaunchOptions(
    "",
    legacyShortcutExecutable,
  );
  recoveryDetails = {
    appId: 3908080889,
    name: "Legacy Non-Steam Game",
    targetType: "shortcut",
    launchOptionsField: "shortcut",
    launchOptions: "",
    appLaunchOptions: legacyShortcutApplied,
    shortcutLaunchOptions: "",
    running: false,
    shortcutExe: '\"/games/Legacy/Game.exe\"',
    shortcutStartDir: '\"/games/Legacy\"',
  };
  await restoreTrainerLaunchBinding({
    app_id: 3908080889,
    managed_launch_executable: legacyShortcutExecutable,
    candidate_launch_executables: [legacyShortcutExecutable],
    original_launch_options: "",
    applied_launch_options: legacyShortcutApplied,
    target_type: "shortcut",
    launch_options_field: null,
    shortcut_exe: "",
  });
  assert.equal(recoveryWrites.length, 1);
  assert.equal(recoveryWrites[0][0].targetType, "shortcut");
  assert.equal(recoveryWrites[0][0].launchOptionsField, "app");
  assert.equal(recoveryWrites[0][1], "");
  assert.equal(recoveryUnbinds, 1);

  recoveryDetails = {
    ...recoveryDetails,
    appLaunchOptions: legacyShortcutApplied,
    shortcutLaunchOptions: legacyShortcutApplied,
  };
  await restoreTrainerLaunchBinding({
    app_id: 3908080889,
    managed_launch_executable: legacyShortcutExecutable,
    candidate_launch_executables: [legacyShortcutExecutable],
    original_launch_options: "",
    applied_launch_options: legacyShortcutApplied,
    target_type: "shortcut",
    launch_options_field: "shortcut",
    shortcut_exe: '\"/games/Legacy/Game.exe\"',
  });
  assert.equal(recoveryWrites.length, 2);
  assert.equal(recoveryWrites[1][0].launchOptionsField, "shortcut");
  assert.equal(recoveryWrites[1][1], "");
  assert.equal(recoveryUnbinds, 2);

  await assert.rejects(
    restoreTrainerLaunchBinding({
      app_id: 3908080889,
      managed_launch_executable: legacyShortcutExecutable,
      candidate_launch_executables: [legacyShortcutExecutable],
      original_launch_options: "",
      applied_launch_options: legacyShortcutApplied,
      target_type: "shortcut",
      launch_options_field: null,
      shortcut_exe: '\"/games/Legacy/Game.exe\"',
    }),
    /普通启动项与快捷方式启动项都含有/,
  );
  assert.equal(recoveryWrites.length, 2);
  assert.equal(recoveryUnbinds, 2);

  await assert.rejects(
    restoreTrainerLaunchBinding({
      app_id: 3908080889,
      managed_launch_executable: legacyShortcutExecutable,
      candidate_launch_executables: [legacyShortcutExecutable],
      original_launch_options: "",
      applied_launch_options: legacyShortcutApplied,
      target_type: "shortcut",
      launch_options_field: "shortcut",
      shortcut_exe: '\"/games/Another/Game.exe\"',
    }),
    /快捷方式的可执行文件已经变化/,
  );
  assert.equal(recoveryWrites.length, 2);
  assert.equal(recoveryUnbinds, 2);

  let currentLaunchOptions = "ORIGINAL %command% --launcher-skip";
  let setterCalls = 0;
  SteamClient.Apps.RegisterForAppDetails = (_appId, callback) => {
    setTimeout(
      () => callback({
        strDisplayName: "Write Test",
        strLaunchOptions: currentLaunchOptions,
      }),
      0,
    );
    return { unregister() {} };
  };
  SteamClient.Apps.SetAppLaunchOptions = (_appId, value) => {
    setterCalls += 1;
    currentLaunchOptions = value;
  };
  await writeLaunchOptionsSafely(
    {
      appId: 123,
      targetType: "steam",
      launchOptionsField: "app",
      launchOptions: "ORIGINAL %command% --launcher-skip",
    },
    "NEXT %command% --launcher-skip",
    50,
  );
  assert.equal(currentLaunchOptions, "NEXT %command% --launcher-skip");
  assert.equal(setterCalls, 1);

  let shortcutLaunchOptions = "SHORTCUT-ORIGINAL %command%";
  let shortcutAppLaunchOptions = "UNRELATED-APP-FIELD";
  let shortcutSetterCalls = 0;
  let appSetterCallsForShortcut = 0;
  SteamClient.Apps.RegisterForAppDetails = (_appId, callback) => {
    setTimeout(
      () => callback({
        strDisplayName: "Shortcut Write Test",
        strLaunchOptions: shortcutAppLaunchOptions,
        strShortcutExe: '\"/games/Shortcut/Game.exe\"',
        strShortcutStartDir: '\"/games/Shortcut\"',
        strShortcutLaunchOptions: shortcutLaunchOptions,
      }),
      0,
    );
    return { unregister() {} };
  };
  SteamClient.Apps.SetAppLaunchOptions = (_appId, value) => {
    appSetterCallsForShortcut += 1;
    shortcutAppLaunchOptions = value;
  };
  SteamClient.Apps.SetShortcutLaunchOptions = (_appId, value) => {
    shortcutSetterCalls += 1;
    shortcutLaunchOptions = value;
  };
  await writeLaunchOptionsSafely(
    {
      appId: 3908080889,
      targetType: "shortcut",
      launchOptionsField: "app",
      launchOptions: "UNRELATED-APP-FIELD",
    },
    "APP-FIELD-NEXT %command%",
    50,
  );
  assert.equal(shortcutAppLaunchOptions, "APP-FIELD-NEXT %command%");
  assert.equal(appSetterCallsForShortcut, 1);
  assert.equal(shortcutSetterCalls, 0);

  const appSetterBeforeLegacyRestore = appSetterCallsForShortcut;
  await writeLaunchOptionsSafely(
    {
      appId: 3908080889,
      targetType: "shortcut",
      launchOptionsField: "shortcut",
      launchOptions: "SHORTCUT-ORIGINAL %command%",
    },
    "LEGACY-SHORTCUT-FIELD-RESTORED",
    50,
  );
  assert.equal(shortcutLaunchOptions, "LEGACY-SHORTCUT-FIELD-RESTORED");
  assert.equal(shortcutSetterCalls, 1);
  assert.equal(appSetterCallsForShortcut, appSetterBeforeLegacyRestore);
  await assert.rejects(
    writeLaunchOptionsSafely(
      {
        appId: 3908080889,
        targetType: "steam",
        launchOptionsField: "app",
        launchOptions: "APP-FIELD-NEXT %command%",
      },
      "MUST-NOT-WRITE",
      50,
    ),
    /目标类型在操作期间发生变化/,
  );
  assert.equal(appSetterCallsForShortcut, 1);

  currentLaunchOptions = "CHANGED-BY-CHEATDECK %command%";
  setterCalls = 0;
  SteamClient.Apps.RegisterForAppDetails = (_appId, callback) => {
    setTimeout(
      () => callback({
        strDisplayName: "Write Test",
        strLaunchOptions: currentLaunchOptions,
      }),
      0,
    );
    return { unregister() {} };
  };
  SteamClient.Apps.SetAppLaunchOptions = (_appId, value) => {
    setterCalls += 1;
    currentLaunchOptions = value;
  };
  await assert.rejects(
    writeLaunchOptionsSafely(
      {
        appId: 123,
        targetType: "steam",
        launchOptionsField: "app",
        launchOptions: "STALE %command%",
      },
      "TRAINERDECK %command%",
      50,
    ),
    /操作期间已被.*修改/,
  );
  assert.equal(setterCalls, 0);

  currentLaunchOptions = "UNCHANGED %command%";
  setterCalls = 0;
  SteamClient.Apps.SetAppLaunchOptions = () => {
    setterCalls += 1;
  };
  await assert.rejects(
    writeLaunchOptionsSafely(
      {
        appId: 123,
        targetType: "steam",
        launchOptionsField: "app",
        launchOptions: "UNCHANGED %command%",
      },
      "NOT-PERSISTED %command%",
      50,
    ),
    /Steam 没有确认目标的新启动项/,
  );
  assert.equal(setterCalls, 1);
  console.log("Steam launch-option, app-detail, and dynamic-search tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
