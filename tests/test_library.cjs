const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

function loadSource(file, dependencies = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    fileName: file,
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    loaded,
    loaded.exports,
  );
  return loaded.exports;
}

const policy = loadSource("src/library-state.ts");
const trainer = { id: "trainer-1", title: "Hollow Knight Trainer", game_name: "Hollow Knight", provider: "FLiNG", version: "1.5", folder: "/trainers/hollow-knight", executable: "/trainers/hollow-knight/trainer.exe", aliases: ["空洞骑士"] };
const target = { appId: 367520, name: "Hollow Knight", targetType: "steam", launchOptionsField: "app" };
const binding = { installation_id: trainer.id, app_id: target.appId, display_name: "空洞骑士", active: true, launch_options_restored: false, target_type: "steam" };

assert.notEqual(policy.installationKey(trainer), policy.installationKey({ ...trainer, folder: "/other-copy" }));
assert.equal(policy.installationBindingState(trainer, [], null), "no-target");
assert.equal(policy.installationBindingState(trainer, [binding], target), "bound-here");
assert.equal(policy.installationBindingState(trainer, [binding], { ...target, appId: 10 }), "bound-elsewhere");
assert.equal(policy.installationBindingState(trainer, [{ ...binding, active: false }], target), "bound-here", "Unrestored launch options still protect the files");
assert.equal(policy.installationBindingState(trainer, [{ ...binding, active: false, launch_options_restored: true }], target), "available");
assert.equal(policy.installationBindings({ ...trainer, folder: "/another-copy" }, [binding]).length, 1, "Ambiguous IDs are protected conservatively");
assert.equal(policy.installationBindingState(trainer, [{ ...binding, target_type: "shortcut", shortcut_exe: "old.exe" }], { ...target, targetType: "shortcut", shortcutExe: "new.exe" }), "bound-elsewhere");
assert.equal(policy.installationMatchesQuery(trainer, [binding], "空洞 1.5"), true);
assert.equal(policy.installationMatchesQuery(trainer, [], "fling knight"), true);
assert.equal(policy.installationMatchesQuery(trainer, [], "  "), true);
assert.equal(policy.installationMatchesQuery(trainer, [], "Knight 2.0"), false);
const retainedPath = { ...binding, installation_id: "new-version", installation_folder: "/trainers/new-version", candidate_launch_executables: [trainer.executable] };
assert.equal(policy.installationBindings(trainer, [retainedPath]).length, 0, "A retained recovery path is not the current installation binding");
assert.equal(policy.installationReferences(trainer, [retainedPath]).length, 1, "Old executable paths still protect an installation from deletion");
assert.equal(policy.installationReferences({ ...trainer, folder: "/another-copy" }, [binding]).length, 1, "Repeated IDs keep every copy protected until recovery");
assert.equal(policy.installationReferences(trainer, [{ ...retainedPath, candidate_launch_executables: [], managed_launch_executable: trainer.executable }]).length, 1);
assert.equal(policy.installationReferences(trainer, [{ ...retainedPath, candidate_launch_executables: [], installation_folder: trainer.folder }]).length, 1);
assert.equal(policy.installationReferences(trainer, [{ ...retainedPath, active: false, launch_options_restored: true }]).length, 0);
assert.equal(policy.installationReferences(trainer, [{ ...retainedPath, candidate_launch_executables: [`${trainer.folder}-new/trainer.exe`] }]).length, 0, "Sibling folder names do not protect unrelated files");

global.window = { clearTimeout, setTimeout };
const asyncHelpers = loadSource("src/async.ts");
const i18n = { t: (_zh, en) => en };

// A small hook host lets the component's real callbacks run with controlled
// backend promises. No Decky/Steam runtime or browser DOM is needed.
function mountLibrary(overrides = {}, backend = {}) {
  const slots = [];
  let cursor = 0;
  let dirty = true;
  let effects = [];
  let tree;
  let alive = true;
  let writesAfterUnmount = 0;
  const toasts = [];
  let props = { target, backendReady: true, busy: false, refreshKey: 0, onBind: async () => true, ...overrides };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    Fragment: "Fragment",
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: initial };
      return [slots[index].value, (next) => {
        if (!alive) { writesAfterUnmount++; return; }
        const value = typeof next === "function" ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { value: callback, dependencies };
      return slots[index].value;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        effects.push(() => {
          slots[index]?.cleanup?.();
          slots[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  const ui = Object.fromEntries(["ButtonItem", "ConfirmModal", "DialogButton", "Focusable", "PanelSection", "PanelSectionRow", "TextField"].map((name) => [name, name]));
  ui.showModal = () => { throw new Error("Deletion must not depend on the host modal API"); };
  const jsx = (type, props) => ({ type, props });
  const { TrainerLibrary } = loadSource("src/library.tsx", {
    "@decky/api": { toaster: { toast: (toast) => toasts.push(toast) } },
    "@decky/ui": ui,
    "react": react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "./async": asyncHelpers,
    "./backend": { listInstalled: async () => [trainer], listBindings: async () => [], deleteInstallation: async () => true, ...backend },
    "./i18n": i18n,
    "./library-state": policy,
  });
  function render() {
    for (let count = 0; dirty; count++) {
      assert.ok(count < 30, "Render should settle");
      dirty = false;
      cursor = 0;
      effects = [];
      tree = TrainerLibrary(props);
      effects.forEach((effect) => effect());
    }
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
  function button(label) {
    const result = nodes(tree).find((node) => ["ButtonItem", "DialogButton"].includes(node.type) && text(node.props.children) === label);
    assert.ok(result, `Missing button: ${label}. Tree: ${text(tree)}`);
    return result.props;
  }
  function click(label) {
    const props = button(label);
    if (props.disabled) return false;
    props.onClick();
    render();
    return true;
  }
  render();
  return {
    async flush() { for (let count = 0; count < 12; count++) { await Promise.resolve(); if (alive) render(); } },
    update(next) { props = { ...props, ...next }; dirty = true; render(); },
    button,
    // Decky's DialogButton suppresses onClick when disabled, even when it can
    // still receive controller focus. Never bypass that behavior in tests.
    click,
    text: () => text(tree),
    toasts,
    confirmation: () => nodes(tree).find((node) => node.props?.role === "group" && node.props?.["aria-label"] === "Confirm local trainer deletion"),
    confirm: () => click("Delete permanently"),
    cancel: () => click("Cancel"),
    writesAfterUnmount: () => writesAfterUnmount,
    unmount() { alive = false; slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

(async () => {
  let installedReads = 0;
  let bindingsFail = true;
  let protectedDeleteCalls = 0;
  const failed = mountLibrary({}, {
    listInstalled: async () => { installedReads++; return [trainer]; },
    listBindings: async () => { if (bindingsFail) throw new Error("bindings unavailable"); return [binding]; },
    deleteInstallation: async () => { protectedDeleteCalls++; return true; },
  });
  assert.equal(installedReads, 0, "Collapsed library should not read the backend");
  failed.click("Open Library");
  await failed.flush();
  assert.equal(failed.button("Load failed. Retry").description, "bindings unavailable");
  assert.ok(!failed.text().includes("Delete Files"), "Failed binding reads must never expose an apparently unbound item");
  bindingsFail = false;
  failed.click("Load failed. Retry");
  await failed.flush();
  assert.equal(failed.button("Delete Files").disabled, false, "Protected delete must explain the reason instead of silently swallowing clicks");
  assert.equal(failed.button("Bound to Current Game").disabled, true);
  assert.equal(failed.click("Bound to Current Game"), false, "The harness must honor the native disabled-event gate");
  assert.equal(failed.click("Delete Files"), true);
  await failed.flush();
  assert.equal(protectedDeleteCalls, 0);
  assert.equal(failed.confirmation(), undefined, "A protected trainer must never open destructive confirmation");
  assert.ok(failed.text().includes("Manage and Restore Launch Options"), "Explain how to make the files safe to remove");
  assert.ok(failed.text().includes(trainer.folder), "Protected deletion opens file details");
  assert.ok(failed.toasts.at(-1).body.includes(binding.display_name));
  assert.equal(failed.toasts.at(-1).title, "Could not delete trainer");
  failed.unmount();

  const older = deferred();
  let reads = 0;
  const stale = mountLibrary({}, { listInstalled: () => ++reads === 1 ? older.promise : Promise.resolve([{ ...trainer, title: "Fresh trainer" }]) });
  stale.click("Open Library");
  await stale.flush();
  stale.click("Collapse Library");
  await stale.flush();
  stale.click("Open Library");
  await stale.flush();
  older.resolve([{ ...trainer, title: "Obsolete trainer" }]);
  await stale.flush();
  assert.ok(stale.text().includes("Fresh trainer"));
  assert.ok(!stale.text().includes("Obsolete trainer"));
  stale.unmount();

  let protectedNow = false;
  let deleted = 0;
  const operationChanges = [];
  const guarded = mountLibrary({ onOperationChange: (value) => operationChanges.push(value) }, {
    listBindings: async () => protectedNow ? [retainedPath] : [],
    deleteInstallation: async () => { deleted++; return true; },
  });
  guarded.click("Open Library");
  await guarded.flush();
  guarded.click("Delete Files");
  assert.ok(guarded.confirmation(), "The confirmation is visible inside the trainer row");
  assert.ok(JSON.stringify(guarded.confirmation()).includes(trainer.folder));
  assert.ok(JSON.stringify(guarded.confirmation()).includes(trainer.version));
  assert.ok(JSON.stringify(guarded.confirmation()).includes("cannot be undone"));
  assert.equal(deleted, 0, "Opening confirmation must not send a deletion RPC");
  protectedNow = true;
  guarded.confirm();
  await guarded.flush();
  assert.equal(deleted, 0, "A new binding while confirmation is open must block deletion");
  assert.deepEqual(operationChanges, [true, false]);
  assert.ok(guarded.text().includes("Unbind it in Launch Option Recovery first"));
  guarded.unmount();

  const historical = mountLibrary({ alwaysExpanded: true }, {
    listBindings: async () => [retainedPath],
    deleteInstallation: async () => { throw new Error("Protected path must never reach delete RPC"); },
  });
  await historical.flush();
  assert.ok(historical.text().includes("Launch option references:"));
  assert.equal(historical.button("Bind to Current Game").disabled, false, "A historical path reference does not become a current-ID binding");
  historical.click("Delete Files");
  await historical.flush();
  assert.equal(historical.confirmation(), undefined);
  assert.ok(historical.toasts.at(-1).body.includes("still refer to this trainer"));
  historical.unmount();

  let remaining = [trainer];
  const removed = [];
  const deletable = mountLibrary({ target: null }, {
    listInstalled: async () => remaining,
    deleteInstallation: async (...args) => { removed.push(args); remaining = []; return true; },
  });
  deletable.click("Open Library");
  await deletable.flush();
  assert.equal(deletable.button("Bind to Current Game").disabled, true, "Reuse binding needs a running target");
  assert.equal(deletable.button("Delete Files").disabled, false, "Unused trainers can be deleted without a running game");
  deletable.click("Delete Files");
  await deletable.flush();
  assert.deepEqual(removed, [], "The first delete press only opens confirmation");
  deletable.cancel();
  assert.deepEqual(removed, [], "Cancel must preserve the local files");
  assert.equal(deletable.confirmation(), undefined);
  deletable.click("Delete Files");
  deletable.confirm();
  await deletable.flush();
  assert.deepEqual(removed, [[trainer.id, trainer.folder]], "Delete uses both the ID and exact displayed folder");
  assert.ok(deletable.text().includes("No trainers downloaded yet"));
  assert.ok(deletable.text().includes("Local trainer files deleted"));
  assert.equal(deletable.toasts.at(-1).title, "Trainer deleted");
  deletable.unmount();

  let immediateReads = 0;
  const expanded = mountLibrary({ alwaysExpanded: true }, {
    listInstalled: async () => { immediateReads++; return [trainer]; },
  });
  await expanded.flush();
  assert.equal(immediateReads, 1, "The settings library reads on entry without an extra expand action");
  assert.ok(!expanded.text().includes("Open Library"));
  assert.ok(!expanded.text().includes("Collapse Library"));
  assert.ok(expanded.text().includes(trainer.title));
  expanded.update({ busy: true });
  assert.equal(expanded.click("Delete Files"), true, "An unrelated operation should produce feedback when delete is selected");
  await expanded.flush();
  assert.equal(expanded.confirmation(), undefined);
  assert.ok(expanded.text().includes("another operation is in progress"));
  assert.ok(expanded.toasts.at(-1).body.includes("another operation is in progress"));
  expanded.unmount();

  let deleteFailures = 0;
  const failedDelete = mountLibrary({ alwaysExpanded: true }, {
    deleteInstallation: async () => { deleteFailures++; throw new Error("Trainer process is still running"); },
  });
  await failedDelete.flush();
  failedDelete.click("Delete Files");
  failedDelete.confirm();
  await failedDelete.flush();
  assert.equal(deleteFailures, 1);
  assert.ok(failedDelete.text().includes("Trainer process is still running"));
  assert.ok(failedDelete.text().includes(trainer.title), "A failed delete must retain the library item");
  assert.equal(failedDelete.toasts.at(-1).title, "Could not delete trainer");
  assert.equal(failedDelete.toasts.at(-1).body, "Trainer process is still running");
  assert.equal(failedDelete.button("Delete Files").disabled, false, "A failed operation must release its lock");
  failedDelete.unmount();

  for (const failAfterUnmount of [false, true]) {
    const preflight = deferred();
    const detachedOperations = [];
    let detachedReads = 0;
    let detachedDeletes = 0;
    const detached = mountLibrary({
      alwaysExpanded: true,
      onOperationChange: (value) => detachedOperations.push(value),
    }, {
      listBindings: () => ++detachedReads === 2 ? preflight.promise : Promise.resolve([]),
      deleteInstallation: async (id, folder) => {
        assert.equal(id, trainer.id);
        assert.equal(folder, trainer.folder);
        detachedDeletes++;
        if (failAfterUnmount) throw new Error("Delete rejected after leaving the page");
        return true;
      },
    });
    await detached.flush();
    detached.click("Delete Files");
    detached.confirm();
    assert.deepEqual(detachedOperations, [true], "Confirmation must acquire the operation lock before awaiting preflight");
    assert.equal(detachedDeletes, 0);
    detached.unmount();
    preflight.resolve([]);
    await detached.flush();
    assert.equal(detachedDeletes, 1, "A confirmed deletion survives page unmount during preflight");
    assert.deepEqual(detachedOperations, [true, false]);
    assert.equal(detached.toasts.at(-1).title, failAfterUnmount ? "Could not delete trainer" : "Trainer deleted");
    assert.equal(detached.writesAfterUnmount(), 0, "Detached completion must only report globally, without writing component state");
  }

  const validation = deferred();
  let bindReads = 0;
  let bound = 0;
  const switched = mountLibrary({ onBind: async () => { bound++; return true; } }, {
    listBindings: () => ++bindReads === 2 ? validation.promise : Promise.resolve([]),
  });
  switched.click("Open Library");
  await switched.flush();
  switched.click("Bind to Current Game");
  assert.equal(switched.click("Binding…"), false, "A second native activation is disabled while validating");
  switched.update({ target: { ...target, appId: 42, name: "Another game" } });
  validation.resolve([]);
  await switched.flush();
  assert.equal(bound, 0, "Switching targets during validation must not bind the new target");
  assert.ok(switched.text().includes("The current game changed"));
  switched.unmount();

  console.log("Trainer library safety and interaction tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
