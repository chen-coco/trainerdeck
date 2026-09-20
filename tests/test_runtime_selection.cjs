const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

// Execute the actual row's JSX and event handlers with lightweight host
// primitives. Steam's React/Decky runtime is supplied by the device at runtime.
const source = fs.readFileSync("src/index.tsx", "utf8");
const rowSource = source.slice(source.indexOf("function RuntimeOptionRow("), source.indexOf("interface InstallAndBindOptions"));
assert.ok(rowSource.length > 1000);
const compiled = ts.transpileModule(rowSource + "\nexports.Row = RuntimeOptionRow;", {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function rowHarness(option) {
  const slots = [];
  let cursor = 0;
  let changed = false;
  let effects = [];
  const emitted = [];
  const jsx = (type, props) => ({ type, props: props || {} });
  const context = {
    exports: {}, require: () => ({ jsx, jsxs: jsx }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => {
        const next = typeof value === "function" ? value(slots[index]) : value;
        if (!Object.is(slots[index], next)) { slots[index] = next; changed = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, offset) => !Object.is(value, previous[offset]))) {
        slots[index] = dependencies;
        effects.push(effect);
      }
    },
    t: (zh) => zh,
    localizedTrainerText: (value) => value?.zh_cn || value?.en || "",
  };
  for (const name of ["Dropdown", "TextField", "DialogButton", "ButtonItem", "Focusable", "ToggleField", "SmallNote", "FaExclamationCircle"])
    context[name] = name;
  vm.runInNewContext(compiled, context);
  return {
    emitted,
    render(update) {
      option = { ...option, ...update };
      let tree;
      // Flush state synchronization effects so a field disappearing during
      // typing cannot be hidden by a render-only hook stub.
      for (let pass = 0; ; pass++) {
        assert.ok(pass < 20, "row effects must settle");
        cursor = 0;
        changed = false;
        effects = [];
        tree = context.exports.Row({ option, disabled: false, connected: true, gameAvailable: true, onToggle() {}, onAction() { emitted.push("action"); }, onValue(value) { emitted.push(value); } });
        for (const effect of effects) effect();
        if (!changed) break;
      }
      const nodes = [];
      function visit(value) {
        if (Array.isArray(value)) return value.forEach(visit);
        if (value && typeof value === "object") { nodes.push(value); visit(value.props?.children); }
      }
      visit(tree);
      return (type) => nodes.filter((node) => node.type === type);
    },
  };
}

const base = {
  id: "save_location", labels: { zh_cn: "保存位置" }, tooltips: {}, group: {},
  kind: "select", active: false, controllable: false, action_controllable: false,
  value_controllable: true, value_type: "text", value_apply_mode: "invoke",
  value: "1", choices: ["1", "01", "营地"], choice_editable: true,
};
const save = rowHarness(base);
let nodes = save.render();
assert.equal(nodes("Dropdown").length, 1);
assert.equal(nodes("TextField").length, 1, "an editable dropdown must always offer direct input");
assert.equal(nodes("TextField")[0].props.value, "1");
assert.equal(nodes("TextField")[0].props.mustBeNumeric, false);
const items = nodes("Dropdown")[0].props.rgOptions;
assert.equal(items[1].data, "01", "names must keep leading zeros");
assert.equal(items.length, 3, "dropdown contains the trainer's choices without an editing-mode entry");
nodes("TextField")[0].props.onChange({ currentTarget: { value: "" } });
nodes = save.render();
assert.equal(nodes("TextField").length, 1, "clearing the field must keep it mounted");
nodes("DialogButton")[0].props.onClick();
assert.deepEqual(save.emitted, [], "empty location names must not execute");
nodes("TextField")[0].props.onChange({ currentTarget: { value: "1" } });
nodes = save.render();
assert.equal(nodes("TextField").length, 1, "matching the current value must not close the input mid-typing");
nodes("TextField")[0].props.onChange({ currentTarget: { value: "12" } });
nodes = save.render();
assert.equal(nodes("TextField")[0].props.value, "12");
assert.equal(nodes("Dropdown")[0].props.selectedOption, undefined);
nodes("DialogButton")[0].props.onClick();
assert.deepEqual(save.emitted, ["12"], "a typed number outside the list must execute");
nodes = save.render({ value_pending: true });
assert.equal(nodes("TextField")[0].props.disabled, true);
nodes = save.render({ value_pending: false, value: "12", choices: [...base.choices, "12"] });
assert.equal(nodes("TextField").length, 1, "applying a newly listed value must retain direct input");
assert.equal(nodes("Dropdown")[0].props.selectedOption, "12");
nodes("TextField")[0].props.onChange({ currentTarget: { value: "山谷营地" } });
nodes = save.render();
nodes("DialogButton")[0].props.onClick();
assert.deepEqual(save.emitted, ["12", "山谷营地"]);
nodes("Dropdown")[0].props.onChange({ data: "01" });
nodes = save.render();
assert.equal(nodes("TextField")[0].props.value, "01", "selecting an option updates the editable value");
nodes("DialogButton")[0].props.onClick();
assert.deepEqual(save.emitted, ["12", "山谷营地", "01"]);
nodes("TextField")[0].props.onChange({ currentTarget: { value: "0012" } });
nodes = save.render({ value: "2", choices: ["2", "01"] });
assert.equal(nodes("TextField")[0].props.value, "0012", "snapshot refreshes must preserve an unfinished edit");
nodes("DialogButton")[0].props.onClick();
assert.deepEqual(save.emitted, ["12", "山谷营地", "01", "0012"]);
nodes = save.render({ value_pending: true });
nodes = save.render({ value_pending: false, value: "", value_error: "" });
assert.equal(nodes("TextField").length, 1, "native selection resets must keep the input available");
assert.equal(nodes("TextField")[0].props.value, "");

const editableTeleport = rowHarness({ ...base, id: "teleport", labels: { zh_cn: "瞬间转移" }, value: "", choices: [] });
nodes = editableTeleport.render();
assert.equal(nodes("Dropdown")[0].props.disabled, true);
assert.equal(nodes("TextField")[0].props.disabled, false, "an empty choice list must not block direct input");
nodes("TextField")[0].props.onChange({ currentTarget: { value: "007" } });
nodes = editableTeleport.render();
let preventedEnter = false;
nodes("TextField")[0].props.onKeyDown({ key: "Enter", preventDefault() { preventedEnter = true; } });
assert.equal(preventedEnter, true);
assert.deepEqual(editableTeleport.emitted, ["007"]);

const teleport = rowHarness({ ...base, choice_editable: false });
nodes = teleport.render();
assert.equal(nodes("Dropdown")[0].props.rgOptions.length, 3);
assert.equal(nodes("TextField").length, 0);
nodes("DialogButton")[0].props.onClick();
assert.deepEqual(teleport.emitted, ["1"], "unchanged location can be used repeatedly");
nodes = rowHarness({ ...base, choices: [], choice_editable: false }).render();
assert.equal(nodes("DialogButton")[0].props.disabled, true);

const marker = rowHarness({ ...base, kind: "action", value_type: "none", value_apply_mode: "none", value_controllable: false, action_controllable: true, value: undefined });
nodes = marker.render();
assert.equal(nodes("Dropdown").length, 0);
assert.equal(nodes("TextField").length, 0, "marker teleport must never demand a value");
nodes("DialogButton")[0].props.onClick();
assert.deepEqual(marker.emitted, ["action"]);
console.log("TrainerDeck selection rendering and interaction checks passed");
