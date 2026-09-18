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
  const emitted = [];
  const jsx = (type, props) => ({ type, props: props || {} });
  const context = {
    exports: {}, require: () => ({ jsx, jsxs: jsx }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect() {}, // These checks cover rendering and user events, not scheduling.
    t: (zh) => zh,
    localizedTrainerText: (value) => value?.zh_cn || value?.en || "",
  };
  for (const name of ["Dropdown", "TextField", "DialogButton", "ButtonItem", "Focusable", "ToggleField", "SmallNote", "FaExclamationCircle"])
    context[name] = name;
  vm.runInNewContext(compiled, context);
  return {
    emitted,
    render() {
      cursor = 0;
      const tree = context.exports.Row({ option, disabled: false, connected: true, gameAvailable: true, onToggle() {}, onAction() { emitted.push("action"); }, onValue(value) { emitted.push(value); } });
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
assert.equal(nodes("TextField").length, 0, "existing selection needs only a dropdown");
const items = nodes("Dropdown")[0].props.rgOptions;
assert.equal(items[1].data, "01", "names must keep leading zeros");
assert.equal(items[3].data, null, "new-location entry cannot collide with a string name");
nodes("Dropdown")[0].props.onChange({ data: null });
nodes = save.render();
assert.equal(nodes("TextField").length, 1);
assert.equal(nodes("TextField")[0].props.mustBeNumeric, false);
nodes("DialogButton")[0].props.onClick();
assert.deepEqual(save.emitted, [], "empty location names must not execute");
nodes("TextField")[0].props.onChange({ currentTarget: { value: "山谷营地" } });
nodes = save.render();
nodes("DialogButton")[0].props.onClick();
assert.deepEqual(save.emitted, ["山谷营地"]);
nodes("Dropdown")[0].props.onChange({ data: "01" });
nodes = save.render();
assert.equal(nodes("TextField").length, 0);
nodes("DialogButton")[0].props.onClick();
assert.deepEqual(save.emitted, ["山谷营地", "01"]);

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
