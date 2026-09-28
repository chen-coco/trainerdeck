const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "runtime-options-model.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  fileName: "runtime-options-model.ts",
}).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)(require, loaded, loaded.exports);
const {
  filterRuntimeOptions,
  groupRuntimeOptions,
  optionFavoriteScope,
  OptionFavoritesController,
} = loaded.exports;

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const noFilters = { query: "", favoritesOnly: false, activeOnly: false };
const playerGroup = { en: "Player", zh_cn: "玩家", zh_tw: "玩家" };
const options = [
  { id: "health", labels: { en: "Infinite Health", zh_cn: "无限生命", zh_tw: "無限生命" }, group: playerGroup, active: true },
  { id: "money", labels: { en: "Edit Money", zh_cn: "编辑金钱" }, group: { en: "Resources", zh_cn: "资源" }, active: false },
  { id: "speed", labels: { en: "Game Speed", zh_cn: "游戏速度" }, group: playerGroup, active: null, desired: true },
  { id: "teleport", labels: { en: "Teleport", zh_cn: "传送" }, group: {}, active: null },
];
const ids = (items) => items.map((item) => item.id);
const favorites = new Set(["speed", "money", "removed-option"]);

assert.equal(optionFavoriteScope(12, hashA.toUpperCase()), `12:${hashA}`);
assert.notEqual(optionFavoriteScope(12, hashA), optionFavoriteScope(13, hashA));
assert.notEqual(optionFavoriteScope(12, hashA), optionFavoriteScope(12, hashB));
for (const invalid of ["", "abc", "x".repeat(64)]) {
  assert.equal(optionFavoriteScope(12, invalid), "", "unknown executable hashes cannot share saved favorites");
}
assert.equal(optionFavoriteScope(0, hashA), "");

assert.deepEqual(ids(filterRuntimeOptions(options, favorites, { ...noFilters, query: "無限" })), ["health"]);
assert.deepEqual(ids(filterRuntimeOptions(options, favorites, { ...noFilters, query: "玩家" })), ["health", "speed"]);
assert.deepEqual(ids(filterRuntimeOptions(options, favorites, { ...noFilters, query: "ＰＬＡＹＥＲ   hEaLtH" })), ["health"]);
assert.deepEqual(ids(filterRuntimeOptions(options, favorites, { ...noFilters, query: "资源 money" })), ["money"]);
assert.deepEqual(ids(filterRuntimeOptions(options, favorites, { ...noFilters, activeOnly: true })), ["health"], "desired or unknown states must never count as confirmed enabled");
assert.deepEqual(ids(filterRuntimeOptions(options, favorites, { ...noFilters, favoritesOnly: true })), ["money", "speed"]);
assert.deepEqual(filterRuntimeOptions(options, favorites, { query: "money", favoritesOnly: true, activeOnly: true }), [], "all filters must compose");
assert.deepEqual(ids(options), ["health", "money", "speed", "teleport"], "filtering must preserve the source order");

const grouped = groupRuntimeOptions(options, favorites);
assert.deepEqual(grouped.map((group) => ids(group.options)), [["money", "speed"], ["health"], ["teleport"]]);
assert.equal(grouped[0].favorite, true);
assert.equal(new Set(grouped.flatMap((group) => ids(group.options))).size, options.length, "favorites must be pinned without duplicate controls");
assert.deepEqual(groupRuntimeOptions(options, new Set()).map((group) => ids(group.options)), [["health", "speed"], ["money"], ["teleport"]], "non-adjacent members must share one collapsible group");
assert.deepEqual(groupRuntimeOptions([], favorites), []);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

// Execute the real TSX with a small hook host and opaque Decky controls. This checks
// component event wiring, effect cleanup, and keyed resets without a Steam client.
function createPanelHarness(client, initialRuntime) {
  let hooks = [];
  let cursor = 0;
  let effectQueue = [];
  let scopeKey;
  let runtime = initialRuntime;
  let tree;
  let originalControlActions = 0;
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  const react = {
    Fragment: "Fragment",
    useState(initial) {
      const index = cursor++;
      const slot = hooks[index] || (hooks[index] = { value: typeof initial === "function" ? initial() : initial });
      return [slot.value, (next) => { slot.value = typeof next === "function" ? next(slot.value) : next; }];
    },
    useMemo(factory, dependencies) {
      const index = cursor++;
      if (!hooks[index] || !sameDeps(hooks[index].dependencies, dependencies)) {
        hooks[index] = { value: factory(), dependencies };
      }
      return hooks[index].value;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || !sameDeps(previous.dependencies, dependencies)) {
        hooks[index] = { dependencies, cleanup: previous?.cleanup };
        effectQueue.push(() => {
          hooks[index].cleanup?.();
          hooks[index].cleanup = effect();
        });
      }
    },
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const module = { exports: {} };
  const componentSource = fs.readFileSync(path.join(__dirname, "..", "src", "runtime-options.tsx"), "utf8");
  const componentCompiled = ts.transpileModule(componentSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    fileName: "runtime-options.tsx",
  }).outputText;
  const imports = {
    "react": react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "@decky/ui": Object.fromEntries(["ButtonItem", "DialogButton", "Focusable", "PanelSectionRow", "TextField", "ToggleField"].map((name) => [name, name])),
    "./async": { withTimeout: (promise) => promise },
    "./backend": { getOptionFavorites: client.get, setOptionFavorite: client.set },
    "./i18n": { t: (zh) => zh, localizedTrainerText: (value) => value.zh_cn || value.en || "" },
    "./runtime-options-model": loaded.exports,
  };
  new Function("require", "module", "exports", componentCompiled)((name) => {
    assert.ok(name in imports, `unmocked component dependency ${name}`);
    return imports[name];
  }, module, module.exports);

  function unmount() {
    for (const hook of hooks) hook.cleanup?.();
    hooks = [];
    effectQueue = [];
  }
  function render(nextRuntime = runtime) {
    runtime = nextRuntime;
    const scoped = module.exports.RuntimeOptionsPanel({
      runtime,
      renderOption: (option) => jsx("OriginalControl", { option, onClick: () => { originalControlActions += 1; } }),
    });
    if (!scoped) {
      unmount();
      tree = null;
      scopeKey = undefined;
      return;
    }
    if (scopeKey !== scoped.key) {
      unmount();
      scopeKey = scoped.key;
    }
    cursor = 0;
    tree = scoped.type(scoped.props);
    const effects = effectQueue;
    effectQueue = [];
    for (const effect of effects) effect();
  }
  function nodes(type) {
    const matches = [];
    const visit = (item) => {
      if (Array.isArray(item)) { item.forEach(visit); return; }
      if (!item || typeof item !== "object") return;
      if (!type || item.type === type) matches.push(item);
      visit(item.props?.children);
    };
    visit(tree);
    return matches;
  }
  function textOf(item) {
    if (Array.isArray(item)) return item.map(textOf).join("");
    if (typeof item === "string" || typeof item === "number") return String(item);
    return item && typeof item === "object" ? textOf(item.props?.children) : "";
  }
  const find = (type, label) => {
    const node = nodes(type).find((candidate) => String(candidate.props.label || textOf(candidate)).includes(label));
    assert.ok(node, `missing ${type} ${label}`);
    return node;
  };
  const settle = async () => { await new Promise(setImmediate); render(); };
  render();
  return { render, nodes, textOf: () => textOf(tree), find, settle, unmount, originalControlActions: () => originalControlActions };
}

async function testPanelWiring() {
  const runtime = { app_id: 12, trainer_sha256: hashA, connected: true, game_available: true, options };
  const writes = [];
  let saved = ["money"];
  const panel = createPanelHarness({
    get: async () => saved,
    set: async (...args) => {
      writes.push(args);
      const [, , id, favorite] = args;
      saved = favorite ? [...new Set([...saved, id])] : saved.filter((value) => value !== id);
      return saved;
    },
  }, runtime);
  const visible = () => panel.nodes("OriginalControl").map((node) => node.props.option.id);
  const search = (query) => {
    panel.find("TextField", "查找修改项").props.onChange({ currentTarget: { value: query } });
    panel.render();
  };
  await panel.settle();
  assert.deepEqual(visible(), ["money", "health", "speed", "teleport"], "loaded favorites must appear first in the actual panel");
  search("PLAYER health");
  assert.deepEqual(visible(), ["health"], "the search field must update the actual rendered controls");
  assert.match(panel.textOf(), /1 \/ 4 项/);
  panel.find("ButtonItem", "清除筛选").props.onClick();
  panel.render();
  panel.find("ButtonItem", "玩家").props.onClick();
  panel.render();
  assert.deepEqual(visible(), ["money", "teleport"], "collapsing a group must hide its controls only");
  panel.find("ButtonItem", "玩家").props.onClick();
  panel.render();
  panel.find("ToggleField", "只看收藏").props.onChange(true);
  panel.render();
  assert.deepEqual(visible(), ["money"]);
  panel.find("ButtonItem", "清除筛选").props.onClick();
  panel.render();
  panel.find("ToggleField", "只看已开启").props.onChange(true);
  panel.render();
  assert.deepEqual(visible(), ["health"]);
  for (const unavailableRuntime of [
    { ...runtime, connected: false },
    { ...runtime, game_available: false },
    { ...runtime, game_available: null },
  ]) {
    panel.render({ ...unavailableRuntime, options: options.map((option) => ({ ...option, active: null })) });
    assert.equal(visible().length, 4, "unavailable runtime state must pause enabled-only filtering and retain the menu");
    assert.equal(panel.find("ToggleField", "只看已开启").props.checked, true, "reconnecting must preserve the filter intent");
    assert.match(panel.find("ToggleField", "只看已开启").props.description, /已暂停/);
    assert.match(panel.textOf(), /状态暂不可用/);
    assert.doesNotMatch(panel.textOf(), /已开启 0/);
  }
  panel.render(runtime);
  assert.deepEqual(visible(), ["health"], "the enabled-only filter must resume on reconnect");
  panel.find("ButtonItem", "清除筛选").props.onClick();
  panel.render();
  const healthStar = panel.nodes("DialogButton").find((node) => node.props.children.props["aria-label"] === "收藏: 无限生命");
  assert.ok(healthStar);
  healthStar.props.onClick();
  panel.render();
  assert.ok(panel.nodes("DialogButton").every((node) => node.props.disabled), "stars must be disabled while saving");
  await panel.settle();
  assert.deepEqual(writes, [[12, hashA, "health", true]], "a star must call the favorites backend with the active game's executable hash");
  assert.equal(panel.originalControlActions(), 0, "favoriting must never invoke the original trainer control");
  assert.deepEqual(visible(), ["health", "money", "speed", "teleport"]);

  panel.find("ButtonItem", "常用收藏").props.onClick();
  panel.render();
  search("no match");
  panel.find("ToggleField", "只看收藏").props.onChange(true);
  panel.render();
  assert.deepEqual(visible(), []);
  panel.render({ ...runtime, app_id: 13 });
  await panel.settle();
  assert.equal(panel.find("TextField", "查找修改项").props.value, "", "switching games must reset the query");
  assert.equal(panel.find("ToggleField", "只看收藏").props.checked, false, "switching games must reset the filters");
  assert.equal(visible().length, 4, "switching games must reset collapsed groups");
  panel.unmount();

  const staleLoad = deferred();
  const switching = createPanelHarness({
    get: (appId) => appId === 12 ? staleLoad.promise : Promise.resolve(["speed"]),
    set: async () => [],
  }, runtime);
  switching.render({ ...runtime, app_id: 13 });
  await switching.settle();
  staleLoad.resolve(["health"]);
  await switching.settle();
  assert.equal(switching.nodes("OriginalControl")[0].props.option.id, "speed", "old game loads must not reach the new component scope");
  switching.unmount();

  let failed = true;
  const recovering = createPanelHarness({
    get: async () => { if (failed) throw new Error("disk unavailable"); return ["money"]; },
    set: async () => { throw new Error("unexpected favorite write"); },
  }, runtime);
  await recovering.settle();
  assert.ok(recovering.nodes("DialogButton").every((node) => node.props.disabled), "load errors must disable favorite actions");
  failed = false;
  recovering.find("ButtonItem", "点此重试").props.onClick();
  await recovering.settle();
  assert.equal(recovering.nodes("OriginalControl")[0].props.option.id, "money", "the retry button must load the saved collection");
  assert.ok(recovering.nodes("DialogButton").every((node) => !node.props.disabled));
  recovering.unmount();
}

(async () => {
  {
    let writes = 0;
    let failure = true;
    const controller = new OptionFavoritesController(12, hashA, {
      get: async () => { if (failure) throw new Error("disk unavailable"); return ["health"]; },
      set: async () => { writes += 1; return []; },
    });
    await controller.setFavorite("money", true);
    await controller.load();
    assert.equal(controller.getSnapshot().status, "error");
    await controller.setFavorite("money", true);
    assert.equal(writes, 0, "loading failures must never be treated as an empty collection to overwrite");
    failure = false;
    await controller.load();
    assert.deepEqual(controller.getSnapshot().favorites, ["health"], "retry must reload the stored favorites");
    assert.equal(controller.getSnapshot().status, "ready");
  }

  {
    const first = deferred();
    const second = deferred();
    let read = 0;
    const controller = new OptionFavoritesController(12, hashA, {
      get: () => (++read === 1 ? first.promise : second.promise),
      set: async () => [],
    });
    const a = controller.load();
    const b = controller.load();
    second.resolve(["money", "money"]);
    await b;
    first.resolve(["health"]);
    await a;
    assert.deepEqual(controller.getSnapshot().favorites, ["money"], "a late earlier load must not overwrite the current result");
  }

  {
    const pending = deferred();
    const calls = [];
    let reads = 0;
    const controller = new OptionFavoritesController(12, hashA.toUpperCase(), {
      get: async () => { reads += 1; return ["health"]; },
      set: (...args) => { calls.push(args); return pending.promise; },
    });
    await controller.load();
    const first = controller.setFavorite("money", true);
    await controller.setFavorite("speed", true);
    await controller.load();
    assert.equal(controller.getSnapshot().saving, true);
    assert.equal(reads, 1, "reload must not race an in-flight write");
    assert.deepEqual(calls, [[12, hashA, "money", true]], "concurrent clicks must not race or use an unnormalized hash");
    pending.resolve(["health", "money"]);
    await first;
    assert.deepEqual(controller.getSnapshot().favorites, ["health", "money"]);
    assert.equal(controller.getSnapshot().saving, false);
  }

  {
    let reads = 0;
    let writes = 0;
    const controller = new OptionFavoritesController(12, hashA, {
      get: async () => (++reads === 1 ? ["health"] : ["health", "money"]),
      set: async () => { writes += 1; throw new Error("response lost"); },
    });
    await controller.load();
    await controller.setFavorite("money", true);
    assert.deepEqual(controller.getSnapshot().favorites, ["health"], "failed writes must retain the last confirmed collection");
    assert.equal(controller.getSnapshot().status, "error");
    await controller.setFavorite("health", false);
    assert.equal(writes, 1, "ambiguous writes require reloading before the next edit");
    await controller.load();
    assert.deepEqual(controller.getSnapshot().favorites, ["health", "money"], "reload must reconcile a write that may have reached the server");
  }

  {
    const pending = deferred();
    const oldNotifications = [];
    const oldController = new OptionFavoritesController(12, hashA, {
      get: () => pending.promise,
      set: async () => [],
    });
    const unsubscribe = oldController.subscribe((state) => oldNotifications.push(state));
    const loading = oldController.load();
    unsubscribe();
    const notificationCount = oldNotifications.length;
    const nextController = new OptionFavoritesController(12, hashB, {
      get: async (appId, hash) => { assert.equal(appId, 12); assert.equal(hash, hashB); return ["speed"]; },
      set: async () => [],
    });
    await nextController.load();
    pending.resolve(["health"]);
    await loading;
    assert.equal(oldNotifications.length, notificationCount, "unmounted games must ignore async results");
    assert.deepEqual(nextController.getSnapshot().favorites, ["speed"], "switching executable versions must retain separate favorites");
    assert.notEqual(oldController.getSnapshot().status, "ready");
  }

  {
    const pending = deferred();
    const controller = new OptionFavoritesController(12, hashA, {
      get: async () => ["health"],
      set: () => pending.promise,
    });
    const notifications = [];
    const unsubscribe = controller.subscribe((state) => notifications.push(state));
    await controller.load();
    const saving = controller.setFavorite("money", true);
    unsubscribe();
    const count = notifications.length;
    controller.subscribe((state) => notifications.push(state));
    await controller.load();
    pending.resolve(["health", "money"]);
    await saving;
    assert.equal(notifications.length, count + 3, "a disposed write must not notify after subscribing again");
    assert.deepEqual(controller.getSnapshot().favorites, ["health"], "a stale write receipt must not replace a fresh read");
    assert.equal(controller.getSnapshot().saving, false, "reattaching must not retain a canceled UI saving state");
  }

  {
    let calls = 0;
    const controller = new OptionFavoritesController(12, "", {
      get: async () => { calls += 1; return []; },
      set: async () => { calls += 1; return []; },
    });
    await controller.load();
    await controller.setFavorite("health", true);
    assert.equal(calls, 0, "unidentified trainers must not read or write an arbitrary shared scope");
    assert.equal(controller.getSnapshot().status, "unavailable");
  }

  {
    const controller = new OptionFavoritesController(12, hashA, {
      get: async () => null,
      set: async () => [],
    });
    await controller.load();
    assert.equal(controller.getSnapshot().status, "error", "malformed persistence responses must fail closed");
  }

  await testPanelWiring();
  console.log("TrainerDeck runtime option filter, favorite race, and component wiring tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
