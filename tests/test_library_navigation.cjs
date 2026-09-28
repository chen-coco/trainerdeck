const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

function loadSource(file, dependencies) {
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: file,
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    loaded,
    loaded.exports,
  );
  return loaded.exports;
}

// Render the real page functions. Defer effects so route/visibility tests never
// contact Steam or the network; selected effects are explicitly exercised below.
let hookContext;
const react = {
  Fragment: "Fragment",
  useState(initial) {
    const value = typeof initial === "function" ? initial() : initial;
    return [value, () => {}];
  },
  useRef: (current) => ({ current }),
  useCallback: (callback) => callback,
  useEffect: (callback, dependencies) => hookContext.effects.push({ callback, dependencies }),
};
function render(component, props = {}) {
  hookContext = { effects: [] };
  const tree = component(props);
  return { tree, effects: hookContext.effects };
}
function nodes(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
function text(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  return node && typeof node === "object" ? text(node.props?.children) : "";
}
function click(tree, label) {
  const button = nodes(tree).find((node) => node.type === "ButtonItem" && text(node.props.children) === label);
  assert.ok(button, `Missing visible button: ${label}`);
  assert.ok(!button.props.disabled, `Button must be operable: ${label}`);
  button.props.onClick();
}

const navigation = [];
const notifications = [];
const routes = new Map();
const removedRoutes = [];
let registeredRecovery = 0;
let unregisteredRecovery = 0;
let cancelledRecovery = 0;
let automaticDecisions = 0;
let searches = 0;
const jsx = (type, props) => ({ type, props });
const ui = Object.fromEntries([
  "ButtonItem", "ConfirmModal", "DialogButton", "Dropdown", "Focusable",
  "PanelSection", "PanelSectionRow", "TextField", "ToggleField",
].map((name) => [name, name]));
ui.staticClasses = { Title: "Title" };
ui.Navigation = {
  CloseSideMenus: () => navigation.push("close-menus"),
  Navigate: (path) => navigation.push(path),
};
ui.showModal = () => { throw new Error("Navigation tests must not open confirmation dialogs"); };
const api = {
  definePlugin: (factory) => factory,
  toaster: { toast: (value) => notifications.push(value) },
  FileSelectionType: { FOLDER: "folder" },
  routerHook: {
    addRoute(path, component, options) {
      assert.ok(!routes.has(path), `Duplicate route: ${path}`);
      routes.set(path, { component, options });
    },
    removeRoute(path) { removedRoutes.push(path); routes.delete(path); },
  },
};
const shared = {
  "@decky/api": api,
  "@decky/ui": ui,
  "react": react,
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  "./async": { withTimeout: (promise) => promise },
  "./backend": {},
  "./i18n": { t: (_zh, en) => en, localizedTrainerText: (value) => value?.en || "" },
};
const recovery = {
  RECOVERY_ROUTE: "/trainerdeck/settings/launch-options",
  TrainerDeckRecoveryPage: () => null,
};
const libraryState = loadSource("src/library-state.ts", {});
const library = loadSource("src/library.tsx", { ...shared, "./library-state": libraryState });
const settings = loadSource("src/settings.tsx", { ...shared, "./library": library, "./recovery": recovery });
const index = loadSource("src/index.tsx", {
  ...shared,
  "react-icons/fa": { FaBolt: "FaBolt", FaExclamationCircle: "FaExclamationCircle" },
  "./library": library,
  "./settings": settings,
  "./recovery": recovery,
  "./runtime-options": { RuntimeOptionsPanel: () => null },
  "./automatic-add": {
    decideAutomaticAdd: () => { automaticDecisions++; return { action: "wait" }; },
  },
  "./fling": { searchFlingTrainersMany: () => { searches++; throw new Error("Unexpected online search"); } },
  "./input-recovery": { qamInputRecoveryController: {} },
  "./input-recovery-route": {
    cancelInputRecoverySession: () => { cancelledRecovery++; },
    registerInputRecoveryUi: () => { registeredRecovery++; },
    unregisterInputRecoveryUi: () => { unregisteredRecovery++; },
  },
  "./steam": { currentRunningAppId: () => 367520 },
});

const plugin = index.default();
assert.equal(registeredRecovery, 1);
assert.equal(library.LIBRARY_ROUTE, "/trainerdeck/library");
assert.deepEqual([...routes.keys()].sort(), [
  library.LIBRARY_ROUTE,
  settings.SETTINGS_ROUTE,
  recovery.RECOVERY_ROUTE,
].sort());
assert.equal(routes.get(library.LIBRARY_ROUTE).options.exact, true);

const home = render(plugin.content.type, plugin.content.props);
assert.equal(nodes(home.tree).filter((node) => node.type === library.TrainerLibrary).length, 0, "The main panel must not contain the library");
click(home.tree, "Open Settings");
assert.deepEqual(navigation.splice(0), ["close-menus", settings.SETTINGS_ROUTE]);
assert.equal(cancelledRecovery, 1, "Navigation cancels the focus-recovery transition before closing menus");

assert.equal(routes.get(settings.SETTINGS_ROUTE).component, settings.TrainerDeckSettingsPage);
const settingsPage = render(routes.get(settings.SETTINGS_ROUTE).component);
click(settingsPage.tree, "My Trainer Library");
assert.deepEqual(navigation.splice(0), ["/trainerdeck/library"], "The real settings button opens the registered library route");

const libraryEntry = render(routes.get(library.LIBRARY_ROUTE).component).tree;
assert.equal(libraryEntry.type, plugin.content.type, "The library route reuses Content's binding and target logic");
assert.equal(libraryEntry.props.libraryPage, true);
const libraryPage = render(libraryEntry.type, libraryEntry.props);
const visibleLibraries = nodes(libraryPage.tree).filter((node) => node.type === library.TrainerLibrary);
assert.equal(visibleLibraries.length, 1);
assert.equal(visibleLibraries[0].props.alwaysExpanded, true, "The route opens the downloaded list immediately");
assert.equal(visibleLibraries[0].props.busy, false, "Library deletion must not wait for current-game binding reads");
assert.ok(!nodes(libraryPage.tree).some((node) => node.type === "PanelSection" && node.props.title === "Search Trainers"), "The library route must not render the search panel");
click(libraryPage.tree, "Manage and Restore Launch Options");
assert.deepEqual(navigation.splice(0), ["close-menus", recovery.RECOVERY_ROUTE]);

function automaticEffect(page) {
  // Locate the captured effect by its imported decision function, then execute
  // the actual callback. The assertion checks behavior, not a source pattern.
  const matches = page.effects.filter(({ callback }) => callback.toString().includes("decideAutomaticAdd"));
  assert.equal(matches.length, 1, "There must be one automatic-add coordinator");
  return matches[0].callback;
}
automaticEffect(home)();
assert.equal(automaticDecisions, 1, "The main panel still runs the automatic-add coordinator");
automaticEffect(libraryPage)();
assert.equal(automaticDecisions, 1, "Opening the library must skip automatic-add decisions and search work");
assert.equal(searches, 0);
assert.equal(notifications.length, 0);

plugin.onDismount();
assert.equal(unregisteredRecovery, 1);
assert.equal(routes.size, 0);
assert.ok(removedRoutes.includes("/trainerdeck/library"), "Unload must remove the library route");
console.log("Trainer library navigation and automatic-search isolation tests passed");
