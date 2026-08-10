const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "fling.ts"), "utf8");
const panelSource = fs.readFileSync(path.join(root, "src", "index.tsx"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: "fling.ts",
}).outputText;

const requestedTerms = [];
const godOfWarUrl =
  "https://flingtrainer.com/trainer/god-of-war-trainer-2022/";
const ragnarokUrl =
  "https://flingtrainer.com/trainer/god-of-war-ragnarok-trainer/";
const payloads = {
  "Cyberpunk 2077": [
    {
      id: 15664,
      title: "Cyberpunk 2077 Trainer",
      url: "https://flingtrainer.com/trainer/cyberpunk-2077-trainer-16095388215/",
      type: "post",
      subtype: "post",
    },
    {
      id: 1,
      title: "Unrelated Game Trainer",
      url: "https://flingtrainer.com/trainer/unrelated-game-trainer/",
      type: "post",
    },
  ],
  "God of War": [
    {
      id: 2001,
      title: "God of War Trainer",
      url: godOfWarUrl,
      type: "post",
      subtype: "post",
    },
    {
      id: 2002,
      title: "God of War Ragnarok Trainer",
      url: ragnarokUrl,
      type: "post",
      subtype: "post",
    },
    {
      id: 2003,
      title: "Unrelated War Game Trainer",
      url: "https://flingtrainer.com/trainer/unrelated-war-game-trainer/",
      type: "post",
    },
    {
      id: 2004,
      title: "God of War Trainer",
      url: "https://example.com/trainer/god-of-war/",
      type: "post",
    },
  ],
  "God of War Ragnarok": [
    {
      id: 2002,
      title: "God of War Ragnarok Trainer",
      url: `${ragnarokUrl}?duplicate=1#section`,
      type: "post",
      subtype: "post",
    },
  ],
};
const loaded = { exports: {} };
const localRequire = (id) => {
  if (id === "@decky/api") {
    return {
      fetchNoCors: async (url) => {
        const term = new URL(url).searchParams.get("search") ?? "";
        requestedTerms.push(term);
        const payload = payloads[term] ?? [];
        return {
          ok: true,
          status: 200,
          headers: { get: () => String(payload.length) },
          json: async () => payload,
        };
      },
    };
  }
  return require(id);
};
new Function("require", "module", "exports", compiled)(
  localRequire,
  loaded,
  loaded.exports,
);

global.window = { clearTimeout, setTimeout };

const parsed = loaded.exports.parseFlingSearchItems(
  "Cyberpunk 2077",
  payloads["Cyberpunk 2077"],
);
assert.equal(parsed.length, 1);
assert.equal(parsed[0].id, "fling-official:15664");
assert.equal(parsed[0].game_name, "Cyberpunk 2077");
assert.equal(parsed[0].provider, "fling-official");

const seriesParsed = loaded.exports.parseFlingSearchItems(
  "God of War",
  payloads["God of War"],
  { mode: "series", limit: 100 },
);
assert.deepEqual(
  seriesParsed.map((entry) => entry.game_name),
  ["God of War", "God of War Ragnarok"],
);
const partialSeriesParsed = loaded.exports.parseFlingSearchItems(
  "God",
  payloads["God of War"],
  { mode: "series", limit: 100 },
);
assert.deepEqual(
  partialSeriesParsed.map((entry) => entry.game_name).sort(),
  ["God of War", "God of War Ragnarok"].sort(),
  "manual series search must preserve every matching result for an incomplete name",
);
const exactParsed = loaded.exports.parseFlingSearchItems(
  "God of War",
  payloads["God of War"],
  { mode: "exact", limit: 100 },
);
assert.deepEqual(exactParsed.map((entry) => entry.game_name), ["God of War"]);
const accentInsensitiveExact = loaded.exports.parseFlingSearchItems(
  "God of War Ragnarök",
  payloads["God of War Ragnarok"],
  { mode: "exact", limit: 100 },
);
assert.deepEqual(
  accentInsensitiveExact.map((entry) => entry.game_name),
  ["God of War Ragnarok"],
  "automatic exact search should ignore English title diacritics",
);
const tokenBoundaryResults = loaded.exports.parseFlingSearchItems(
  "Master",
  [
    {
      id: 3001,
      title: "Psychic Kung Fu Master Trainer",
      url: "https://flingtrainer.com/trainer/psychic-kung-fu-master-trainer/",
      type: "post",
    },
    {
      id: 3002,
      title: "Dead Rising Deluxe Remastered Trainer",
      url: "https://flingtrainer.com/trainer/dead-rising-deluxe-remaster-trainer/",
      type: "post",
    },
  ],
  { mode: "series", limit: 100 },
);
assert.deepEqual(
  tokenBoundaryResults.map((entry) => entry.game_name),
  ["Psychic Kung Fu Master"],
  "a translated word must not match inside Remaster or Remastered",
);
assert.match(
  panelSource,
  /\? \[\.\.\.plan\.queries, \.\.\.plan\.fallbackQueries\]/,
  "manual search must search both primary and fallback dynamic candidates",
);
assert.match(
  panelSource,
  /mode === "automatic" \? sortedItems\.slice\(0, 1\) : sortedItems/,
  "automatic search must collapse to one result while manual search keeps all results",
);
assert.throws(
  () => loaded.exports.parseFlingSearchItems("Cyberpunk 2077", {}),
  /无效数据/,
);

(async () => {
  const response = await loaded.exports.searchFlingTrainers("Cyberpunk 2077");
  assert.equal(response.items.length, 1);
  assert.deepEqual(response.warnings, []);

  const seriesResponse = await loaded.exports.searchFlingTrainers("God of War", {
    mode: "series",
    limit: 100,
    perPage: 100,
  });
  assert.deepEqual(
    seriesResponse.items.map((entry) => entry.game_name),
    ["God of War", "God of War Ragnarok"],
  );
  const exactResponse = await loaded.exports.searchFlingTrainers("God of War", {
    mode: "exact",
  });
  assert.deepEqual(
    exactResponse.items.map((entry) => entry.game_name),
    ["God of War"],
  );

  requestedTerms.length = 0;
  const multiResponse = await loaded.exports.searchFlingTrainersMany(
    [
      {
        query: "God of War",
        source: "steam-cluster",
        score: 1000,
        steamCandidates: [
          {
            appId: 1593500,
            name: "God of War",
            sourceQuery: "God of War",
          },
          {
            appId: 2322010,
            name: "God of War Ragnarok",
            sourceQuery: "God of War",
          },
        ],
      },
      {
        query: "God of War Ragnarok",
        source: "steam-cluster",
        score: 900,
        steamCandidates: [
          {
            appId: 2322010,
            name: "God of War Ragnarok",
            sourceQuery: "God of War Ragnarok",
          },
        ],
      },
      {
        query: "  god   of war  ",
        source: "wikimedia",
        score: 100,
        steamCandidates: [
          {
            appId: 777,
            name: "God of War",
            sourceQuery: "god of war",
          },
        ],
      },
    ],
    { mode: "series", concurrency: 2 },
  );
  assert.deepEqual(
    [...requestedTerms].sort(),
    ["God of War", "God of War Ragnarok"].sort(),
    "normalized duplicate queries should issue only one request",
  );
  assert.equal(multiResponse.items.length, 2, "duplicate URLs must be merged");

  const godOfWar = multiResponse.items.find(
    (entry) => entry.game_name === "God of War",
  );
  assert.deepEqual(godOfWar.compatible_app_ids, [1593500, 777]);
  assert.deepEqual(godOfWar.matched_queries, ["God of War"]);
  assert.equal(godOfWar.search_match, "exact-app");

  const ragnarok = multiResponse.items.find(
    (entry) => entry.game_name === "God of War Ragnarok",
  );
  assert.deepEqual(ragnarok.compatible_app_ids, [2322010]);
  assert.deepEqual(ragnarok.matched_queries, [
    "God of War",
    "God of War Ragnarok",
  ]);
  assert.equal(ragnarok.search_match, "exact-app");
  assert.equal(ragnarok.page_url, ragnarokUrl);

  console.log(
    "FLiNG exact/series, multi-query dedupe, and AppID tests passed",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
