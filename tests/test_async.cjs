const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

const source = fs.readFileSync("src/async.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: "async.ts",
}).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)(
  require,
  loaded,
  loaded.exports,
);

global.window = { clearTimeout, setTimeout };

(async () => {
  await assert.rejects(
    loaded.exports.withTimeout(new Promise(() => {}), 10, "request timeout"),
    /request timeout/,
  );
  assert.equal(
    await loaded.exports.withTimeout(Promise.resolve("ok"), 100, "timeout"),
    "ok",
  );
  console.log("Async deadline tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
