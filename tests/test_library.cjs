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
const binding = { installation_id: trainer.id, app_id: target.appId, display_name: "空洞骑士", bound_at: "2026-10-17T01:02:03Z", active: true, launch_options_restored: false, target_type: "steam" };

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
function mountLibrary(overrides = {}, backend = {}, recovery = false, steam = {}) {
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
    useMemo(factory, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { value: factory(), dependencies };
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
  const component = loadSource(recovery ? "src/recovery.tsx" : "src/library.tsx", {
    "@decky/api": { toaster: { toast: (toast) => toasts.push(toast) } },
    "@decky/ui": ui,
    "react": react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "./async": asyncHelpers,
    "./backend": { listInstalled: async () => [trainer], listBindings: async () => [], deleteInstallation: async () => true, forgetTrainerBinding: async () => true, ...backend },
    "./i18n": i18n,
    "./library-state": policy,
    "./steam": {
      readAppDetails: async () => { throw new Error("Steam details unavailable"); },
      recoverTrainerLaunchOptions: () => { throw new Error("Unexpected Steam recovery"); },
      writeLaunchOptionsSafely: async () => { throw new Error("Unexpected Steam write"); },
      ...steam,
    },
  });
  const Component = recovery ? component.TrainerDeckRecoveryPage : component.TrainerLibrary;
  function render() {
    for (let count = 0; dirty; count++) {
      assert.ok(count < 30, "Render should settle");
      dirty = false;
      cursor = 0;
      effects = [];
      tree = Component(props);
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
    confirm: () => click(text(tree).includes("Force Unbind and Delete") ? "Force Unbind and Delete" : "Delete permanently"),
    confirmForget: () => click("Remove Record (Keep Files)"),
    forgetConfirmation: () => nodes(tree).find((node) => node.props?.role === "group" && node.props?.["aria-label"] === "Confirm forced unbinding"),
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
  assert.ok(failed.confirmation(), "A protected trainer opens explicit forced deletion confirmation");
  assert.ok(failed.text().includes("Original launch options will not be restored"));
  assert.ok(failed.text().includes(trainer.folder));
  assert.ok(failed.text().includes(binding.display_name));
  assert.ok(failed.text().includes("Force Unbind and Delete"));
  failed.cancel();
  assert.equal(protectedDeleteCalls, 0, "Cancel must preserve bindings and files");
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
  assert.ok(guarded.text().includes("binding records changed while confirmation was open"));
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
  assert.ok(historical.confirmation(), "Historical executable references are included in forced deletion confirmation");
  assert.ok(historical.text().includes(binding.display_name));
  historical.cancel();
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

  const secondBinding = { ...retainedPath, app_id: 20, display_name: "Deleted game shortcut", bound_at: "2026-10-17T02:03:04Z" };
  let forcedInstallations = [trainer];
  let forcedBindings = [binding, secondBinding];
  const forcedCalls = [];
  const forced = mountLibrary({ alwaysExpanded: true, target: null }, {
    listInstalled: async () => forcedInstallations,
    listBindings: async () => forcedBindings,
    deleteInstallation: async (...args) => {
      forcedCalls.push(args);
      forcedInstallations = [];
      forcedBindings = [];
      return true;
    },
  });
  await forced.flush();
  forced.click("Delete Files");
  assert.ok(forced.text().includes(secondBinding.display_name), "Every referenced game must be named before force deletion");
  assert.deepEqual(forcedCalls, [], "Opening forced confirmation is not authorization to mutate");
  forced.confirm();
  await forced.flush();
  const identities = [binding, secondBinding].map(({ app_id, installation_id, bound_at }) => ({ app_id, installation_id, bound_at }));
  assert.deepEqual(forcedCalls, [[trainer.id, trainer.folder, identities]], "Force deletion sends the exact confirmed binding identities and folder, including historical paths");
  assert.ok(forced.text().includes("Bindings removed and local trainer files deleted"));
  forced.unmount();

  for (const replacement of [
    [{ ...binding, bound_at: "new binding timestamp" }],
    [{ ...binding, installation_id: "replacement", installation_folder: trainer.folder }],
    [binding, secondBinding],
    [],
  ]) {
    let references = [binding];
    let writes = 0;
    const changed = mountLibrary({ alwaysExpanded: true }, {
      listBindings: async () => references,
      deleteInstallation: async () => { writes++; return true; },
    });
    await changed.flush();
    changed.click("Delete Files");
    references = replacement;
    changed.confirm();
    await changed.flush();
    assert.equal(writes, 0, "A changed, added, or removed reference must require a new confirmation");
    assert.ok(changed.text().includes("binding records changed while confirmation was open"));
    assert.equal(changed.button("Delete Files").disabled, false);
    changed.unmount();
  }

  let forceReadCount = 0;
  let unreadableWrites = 0;
  const unreadable = mountLibrary({ alwaysExpanded: true }, {
    listBindings: async () => {
      if (++forceReadCount === 2) throw new Error("Reference preflight unavailable");
      return [binding];
    },
    deleteInstallation: async () => { unreadableWrites++; return true; },
  });
  await unreadable.flush();
  unreadable.click("Delete Files");
  unreadable.confirm();
  await unreadable.flush();
  assert.equal(unreadableWrites, 0, "Failed preflight cannot authorize forced deletion");
  assert.ok(unreadable.text().includes("Reference preflight unavailable"));
  unreadable.unmount();

  const forcePreflight = deferred();
  let detachedForceReads = 0;
  let detachedForceWrites = 0;
  const detachedForce = mountLibrary({ alwaysExpanded: true, target: null }, {
    listBindings: () => ++detachedForceReads === 2 ? forcePreflight.promise : Promise.resolve([binding]),
    deleteInstallation: async (...args) => {
      detachedForceWrites++;
      assert.deepEqual(args, [trainer.id, trainer.folder, [identities[0]]]);
      return true;
    },
  });
  await detachedForce.flush();
  detachedForce.click("Delete Files");
  detachedForce.confirm();
  detachedForce.unmount();
  forcePreflight.resolve([binding]);
  await detachedForce.flush();
  assert.equal(detachedForceWrites, 1, "Accepted force deletion survives leaving the library during preflight");
  assert.equal(detachedForce.writesAfterUnmount(), 0);
  assert.equal(detachedForce.toasts.at(-1).title, "Trainer deleted");

  let recoveryRecords = [{ ...binding, title: "Old game", shortcut_exe: "/deleted/game.exe" }];
  let steamReads = 0;
  let normalUnbinds = 0;
  let fileDeletes = 0;
  const forgotten = [];
  const recovery = mountLibrary({}, {
    listBindings: async () => recoveryRecords,
    unbindTrainer: async () => { normalUnbinds++; return true; },
    forgetTrainerBinding: async (...args) => { forgotten.push(args); recoveryRecords = []; return true; },
    deleteInstallation: async () => { fileDeletes++; return true; },
  }, true, {
    readAppDetails: async () => { steamReads++; throw new Error("Reading deleted shortcut timed out"); },
  });
  await recovery.flush();
  recovery.click(`Restore ${binding.display_name}`);
  await recovery.flush();
  assert.equal(steamReads, 1);
  assert.equal(normalUnbinds, 0, "Ordinary recovery must not bypass Steam identity checks");
  assert.equal(recovery.toasts.at(-1).title, "Recovery failed");
  recovery.click("Force Unbind / Remove Record");
  assert.ok(recovery.forgetConfirmation());
  assert.ok(recovery.text().includes("/deleted/game.exe"));
  assert.ok(recovery.text().includes("without restoring or changing Steam launch options"));
  assert.deepEqual(forgotten, []);
  recovery.cancel();
  assert.equal(recovery.forgetConfirmation(), undefined);
  assert.deepEqual(forgotten, [], "Cancelling force-unbind preserves the record");
  recovery.click("Force Unbind / Remove Record");
  recovery.confirmForget();
  await recovery.flush();
  assert.deepEqual(forgotten, [[binding.app_id, binding.installation_id, binding.bound_at]]);
  assert.equal(steamReads, 1, "Force-unbind never queries the missing game");
  assert.equal(normalUnbinds, 0, "Force-unbind does not pretend launch options were restored");
  assert.equal(fileDeletes, 0, "Force-unbind always keeps trainer files");
  assert.ok(recovery.text().includes("There are no TrainerDeck launch option records"));
  recovery.unmount();
  assert.equal(policy.installationBindingState(trainer, recoveryRecords, { ...target, appId: 123 }), "available", "The same local trainer can be bound to the reinstalled game after forgetting the orphan");

  let historyCalls = 0;
  const history = mountLibrary({}, {
    listBindings: async () => [{ ...binding, active: false, launch_options_restored: true }],
    forgetTrainerBinding: async () => { historyCalls++; return true; },
  }, true);
  await history.flush();
  assert.equal(history.button(`${binding.display_name} · Restored`).disabled, true);
  assert.equal(history.button("Force Unbind / Remove Record").disabled, false, "Restored historical records can also be removed");
  history.click("Force Unbind / Remove Record");
  history.confirmForget();
  await history.flush();
  assert.equal(historyCalls, 1);
  history.unmount();

  let rejectedCalls = 0;
  const rejected = mountLibrary({}, {
    listBindings: async () => [binding],
    forgetTrainerBinding: async (...args) => {
      rejectedCalls++;
      assert.deepEqual(args, [binding.app_id, binding.installation_id, binding.bound_at]);
      throw new Error("Binding changed since confirmation");
    },
  }, true);
  await rejected.flush();
  rejected.click("Force Unbind / Remove Record");
  rejected.confirmForget();
  await rejected.flush();
  assert.equal(rejectedCalls, 1);
  assert.ok(rejected.text().includes("Binding changed since confirmation"));
  assert.ok(rejected.text().includes(binding.display_name), "Failed force-unbind retains the record");
  assert.equal(rejected.button("Force Unbind / Remove Record").disabled, false, "Rejected mutations release the operation lock");
  assert.equal(rejected.toasts.at(-1).title, "Could not remove binding record");
  rejected.unmount();

  const forgetMutation = deferred();
  let detachedForgets = 0;
  const detachedRecovery = mountLibrary({}, {
    listBindings: async () => [binding],
    forgetTrainerBinding: async () => { detachedForgets++; return forgetMutation.promise; },
  }, true);
  await detachedRecovery.flush();
  detachedRecovery.click("Force Unbind / Remove Record");
  detachedRecovery.confirmForget();
  detachedRecovery.unmount();
  forgetMutation.resolve(true);
  await detachedRecovery.flush();
  assert.equal(detachedForgets, 1);
  assert.equal(detachedRecovery.writesAfterUnmount(), 0, "Accepted force-unbind completes without writing unmounted state");
  assert.equal(detachedRecovery.toasts.at(-1).title, "Binding record removed");

  const rpcCalls = [];
  const realBackend = loadSource("src/backend.ts", {
    "@decky/api": { callable: (name) => async (...args) => { rpcCalls.push([name, ...args]); return true; } },
  });
  await realBackend.forgetTrainerBinding(binding.app_id, binding.installation_id, binding.bound_at);
  await realBackend.deleteInstallation(trainer.id, trainer.folder, identities);
  await realBackend.deleteInstallation(trainer.id, trainer.folder);
  assert.deepEqual(rpcCalls, [
    ["forget_trainer_binding", binding.app_id, binding.installation_id, binding.bound_at],
    ["delete_installation", trainer.id, trainer.folder, identities],
    ["delete_installation", trainer.id, trainer.folder],
  ], "Real callable wrappers preserve the new RPC contract and ordinary deletion arguments");

  console.log("Trainer library safety and interaction tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
