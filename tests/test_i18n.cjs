const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "i18n.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2021,
  },
  fileName: "i18n.ts",
}).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)(
  require,
  loaded,
  loaded.exports,
);

const { localizedTrainerText, resolveUiLanguage, t } = loaded.exports;

for (const locale of ["zh", "zh-CN", "zh-Hans", "zh-TW", "zh_HK"]) {
  assert.equal(resolveUiLanguage(locale), "zh", `${locale} must use Chinese UI`);
  assert.equal(t("中文", "English", locale), "中文");
}

for (const locale of ["en", "en-US", "de-DE", "ja-JP", ""]) {
  assert.equal(resolveUiLanguage(locale), "en", `${locale} must use English UI`);
  assert.equal(t("中文", "English", locale), "English");
}

const trainerText = {
  zh_cn: "简体标签",
  zh_tw: "繁體標籤",
  en: "English label",
};
assert.equal(localizedTrainerText(trainerText, "zh-CN"), "简体标签");
assert.equal(localizedTrainerText(trainerText, "zh-TW"), "繁體標籤");
assert.equal(localizedTrainerText(trainerText, "en-GB"), "English label");
assert.equal(
  localizedTrainerText({ zh_cn: "后备标签" }, "en-US"),
  "后备标签",
  "trainer labels must retain a safe fallback when English is unavailable",
);

for (const file of ["index.tsx", "settings.tsx", "recovery.tsx"]) {
  const uiSource = fs.readFileSync(path.join(root, "src", file), "utf8");
  assert.match(uiSource, /import \{[^}]*\bt\b[^}]*\} from "\.\/i18n";/s);

  const sourceFile = ts.createSourceFile(
    file,
    uiSource,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TSX,
  );
  const untranslated = [];
  const insideTranslationCall = (node) => {
    for (let current = node.parent; current; current = current.parent) {
      if (
        ts.isCallExpression(current) &&
        ts.isIdentifier(current.expression) &&
        current.expression.text === "t"
      ) {
        return true;
      }
    }
    return false;
  };
  const visit = (node) => {
    const literalText = ts.isTemplateExpression(node)
      ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("")
      : ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : "";
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      /[\u3400-\u9fff\uf900-\ufaff]/u.test(literalText) &&
      !insideTranslationCall(node)
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      untranslated.push(`${file}:${position.line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.deepEqual(
    untranslated,
    [],
    `${file} contains Chinese UI strings outside t(...)`,
  );
}

const indexSource = fs.readFileSync(path.join(root, "src", "index.tsx"), "utf8");
assert.match(indexSource, /t\("当前目标", "Current Target"\)/);
assert.match(indexSource, /t\("搜索修改器", "Search Trainers"\)/);
assert.match(indexSource, /t\("设置", "Settings"\)/);
assert.doesNotMatch(
  indexSource,
  /function localizedText|navigator\.language/,
  "language detection and trainer-label fallback must stay centralized",
);

console.log("TrainerDeck i18n tests passed");
