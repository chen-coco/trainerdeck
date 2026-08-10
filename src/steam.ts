import { fetchNoCors } from "@decky/api";
import { Router, type Unregisterable } from "@decky/ui";

import type {
  SteamStoreCandidate,
  SteamTarget,
  TrainerSearchPlan,
  TrainerSearchQuery,
} from "./types";

type AppDetails = Parameters<
  Parameters<typeof SteamClient.Apps.RegisterForAppDetails>[1]
>[0];

const NON_STEAM_SHORTCUT_APP_TYPE = 0x40000000;

const MANAGED_ENV_KEYS = new Set([
  "PROTON_REMOTE_DEBUG_CMD",
  "PRESSURE_VESSEL_FILESYSTEMS_RW",
]);

type SteamStoreSearchItem = {
  type?: string;
  id?: number;
  name?: string;
};

type OnlineEnglishCandidate = {
  name: string;
  score: number;
  source:
    | "online-translation"
    | "wikimedia"
    | "steam-localized"
    | "steam-shortcut";
  steamCandidates?: SteamStoreCandidate[];
};

export type SteamSearchResolution = {
  originalQuery: string;
  searchQuery: string;
  appId?: number;
  localizedName?: string;
  warning?: string;
};

const SEARCH_PLAN_CACHE_MS = 24 * 60 * 60 * 1000;
const WEAK_SEARCH_PLAN_CACHE_MS = 5 * 60 * 1000;
const MAX_ONLINE_NAMES = 6;
const MAX_STEAM_CANDIDATES = 12;
const MAX_SERIES_QUERIES = 5;
const searchPlanCache = new Map<
  string,
  { expiresAt: number; value: TrainerSearchPlan }
>();

function normalizedGameName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s《》〈〉「」『』【】\[\]()（）:：·'"“”‘’.,，。!！?？_\-—™®©]/gu, "");
}

function includesChinese(value: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}

function englishWords(value: string): string[] {
  return value.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function normalizedEnglishWords(value: string): string[] {
  return englishWords(value).map((word) => word.toLocaleLowerCase());
}

function normalizedEnglishPhrase(value: string): string {
  return normalizedEnglishWords(value).join(" ");
}

function containsWordSequence(words: string[], sequence: string[]): boolean {
  if (!sequence.length || sequence.length > words.length) {
    return false;
  }
  for (let start = 0; start <= words.length - sequence.length; start += 1) {
    if (sequence.every((word, index) => words[start + index] === word)) {
      return true;
    }
  }
  return false;
}

function cloneSearchPlan(plan: TrainerSearchPlan): TrainerSearchPlan {
  const cloneQuery = (query: TrainerSearchQuery): TrainerSearchQuery => ({
    ...query,
    steamCandidates: query.steamCandidates.map((candidate) => ({ ...candidate })),
  });
  return {
    ...plan,
    queries: plan.queries.map(cloneQuery),
    fallbackQueries: plan.fallbackQueries.map(cloneQuery),
    warnings: [...plan.warnings],
  };
}

async function fetchNoCorsWithTimeout(
  input: string,
  timeoutMs = 6000,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchNoCors(input, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut && !externalSignal?.aborted) {
      throw new Error("在线搜索请求超时");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export function currentRunningAppId(): number {
  const value = Number(Router?.MainRunningApp?.appid ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export async function resolveSteamSearchName(
  appId: number,
  fallback: string,
  timeoutMs = 6000,
  signal?: AbortSignal,
): Promise<string> {
  const localName = String(
    window.appStore?.GetAppOverviewByAppID(appId)?.sort_as || fallback,
  ).trim();
  if (!Number.isFinite(appId) || appId <= 0) {
    return localName;
  }
  try {
    const response = await fetchNoCorsWithTimeout(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&l=english`,
      timeoutMs,
      signal,
    );
    if (!response.ok) {
      return localName;
    }
    const payload = (await response.json()) as Record<
      string,
      { success?: boolean; data?: { name?: unknown } }
    >;
    const name = payload[String(appId)]?.data?.name;
    return typeof name === "string" && name.trim()
      ? name.trim()
      : localName;
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return localName;
  }
}

function cleanEnglishCandidate(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const original = value.replace(/\s+/g, " ").trim();
  if (!original) {
    return "";
  }
  const quoted = [...original.matchAll(/[“"]([^”"]{2,120})[”"]/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((candidate) => /[A-Za-z]/u.test(candidate));
  let candidate = quoted.length > 0 ? quoted[quoted.length - 1] : original;
  candidate = candidate
    .replace(
      /^(?:the\s+)?english\s+(?:name|title)\s+(?:of|for)\s+(?:the\s+)?(?:video\s+)?game(?:\s+series)?\s*(?::|is|called)?\s*/iu,
      "",
    )
    .replace(
      /\s*\((?:[^)]*(?:video\s+game|franchise|game\s+series)[^)]*)\)\s*$/iu,
      "",
    )
    .replace(/^[\s'“”"《》:：-]+|[\s'“”"《》:：.。-]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return candidate && /[A-Za-z]/u.test(candidate) && !includesChinese(candidate)
    ? candidate
    : "";
}

function shortcutEnglishNames(
  target?: Pick<SteamTarget, "shortcutExe" | "shortcutStartDir">,
): string[] {
  if (!target) {
    return [];
  }
  const rawPaths = [target.shortcutExe, target.shortcutStartDir]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().replace(/^["']+|["']+$/gu, ""));
  const candidates: string[] = [];
  for (const rawPath of rawPaths) {
    const segments = rawPath.replace(/\\/g, "/").split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const stem = last
      .replace(/\.exe$/iu, "")
      .replace(/(?:[-_ ](?:win(?:32|64)|shipping|launcher|client))+$/iu, "")
      .replace(/[-_.]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const cleaned = cleanEnglishCandidate(stem);
    if (
      !cleaned ||
      /^(?:game|game client|launcher|start|play|shipping|win32|win64|wine|proton)$/iu.test(
        cleaned,
      )
    ) {
      continue;
    }
    candidates.push(cleaned);
  }
  return [...new Map(candidates.map((name) => [normalizedEnglishPhrase(name), name])).values()]
    .filter(Boolean)
    .slice(0, 3);
}

function shortcutCandidatesForQuery(
  target: Pick<
    SteamTarget,
    "appId" | "name" | "shortcutExe" | "shortcutStartDir"
  > | undefined,
  query: string,
): OnlineEnglishCandidate[] {
  if (!target || target.appId <= 0) {
    return [];
  }
  const queryKey = normalizedGameName(query);
  const targetKey = normalizedGameName(target.name);
  const names = shortcutEnglishNames(target);
  const relatedToDisplay = Boolean(
    queryKey && targetKey &&
      (queryKey === targetKey || targetKey.includes(queryKey) || queryKey.includes(targetKey)),
  );
  const relatedToPath = names.some((name) => {
    const nameKey = normalizedGameName(name);
    return Boolean(
      queryKey && nameKey &&
        (queryKey === nameKey || nameKey.includes(queryKey) || queryKey.includes(nameKey)),
    );
  });
  if (!relatedToDisplay && !relatedToPath) {
    return [];
  }
  return names.map((name, index) => ({
    name,
    score: 2000 - index * 20,
    source: "steam-shortcut" as const,
    steamCandidates: [
      {
        appId: target.appId,
        name,
        localizedName: target.name,
        sourceQuery: query,
      },
    ],
  }));
}

function uniqueOnlineCandidates(
  values: OnlineEnglishCandidate[],
): OnlineEnglishCandidate[] {
  const deduplicated = new Map<string, OnlineEnglishCandidate>();
  for (const candidate of values) {
    const name = cleanEnglishCandidate(candidate.name);
    const key = normalizedEnglishPhrase(name);
    if (!key) {
      continue;
    }
    const previous = deduplicated.get(key);
    const preferred = !previous || candidate.score > previous.score
      ? { ...candidate, name }
      : previous;
    const steamCandidates = new Map(
      [
        ...(previous?.steamCandidates ?? []),
        ...(candidate.steamCandidates ?? []),
      ].map((item) => [item.appId, item]),
    );
    deduplicated.set(key, {
      ...preferred,
      steamCandidates: [...steamCandidates.values()],
    });
  }
  return [...deduplicated.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_ONLINE_NAMES);
}

async function searchTranslationMemory(
  query: string,
  signal?: AbortSignal,
): Promise<OnlineEnglishCandidate[]> {
  const values: OnlineEnglishCandidate[] = [];
  const prompts = [
    { text: query.slice(0, 80), primaryScore: 1350, matchScore: 1100 },
    {
      text: `电子游戏《${query.slice(0, 80)}》的官方英文名称`,
      primaryScore: 1250,
      matchScore: 1000,
    },
  ];
  const settled = await Promise.allSettled(
    prompts.map(async (prompt) => {
      const parameters = new URLSearchParams({
        q: prompt.text,
        langpair: "zh-CN|en",
      });
      const response = await fetchNoCorsWithTimeout(
        `https://api.mymemory.translated.net/get?${parameters.toString()}`,
        5000,
        signal,
      );
      if (!response.ok) {
        throw new Error(`在线跨语言搜索返回 HTTP ${response.status}`);
      }
      const payload = (await response.json()) as {
        responseData?: { translatedText?: unknown; match?: unknown };
        matches?: Array<{
          translation?: unknown;
          quality?: unknown;
          match?: unknown;
        }>;
      };
      return { payload, ...prompt };
    }),
  );
  for (const result of settled) {
    if (result.status !== "fulfilled") {
      continue;
    }
    const { payload, primaryScore, matchScore } = result.value;
    const primary = cleanEnglishCandidate(payload.responseData?.translatedText);
    const primaryMatch = Number(payload.responseData?.match);
    if (primary) {
      values.push({
        name: primary,
        score: primaryScore + (Number.isFinite(primaryMatch) ? primaryMatch * 100 : 0),
        source: "online-translation",
      });
    }
    for (const [index, match] of (payload.matches ?? []).entries()) {
      const name = cleanEnglishCandidate(match.translation);
      if (!name) {
        continue;
      }
      const quality = Number(match.quality);
      const confidence = Number(match.match);
      values.push({
        name,
        score:
          matchScore -
          index * 20 +
          (Number.isFinite(quality) ? Math.min(quality, 100) : 0) +
          (Number.isFinite(confidence) ? confidence * 100 : 0),
        source: "online-translation",
      });
    }
  }
  if (!values.length && settled.every((result) => result.status === "rejected")) {
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    throw rejected?.reason ?? new Error("在线跨语言搜索失败");
  }
  return uniqueOnlineCandidates(values);
}

async function searchWikimediaEnglishNames(
  query: string,
  signal?: AbortSignal,
): Promise<OnlineEnglishCandidate[]> {
  const parameters = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: `${query.slice(0, 80)} 电子游戏`,
    gsrnamespace: "0",
    gsrlimit: "12",
    prop: "description|langlinks",
    lllang: "en",
    lllimit: "max",
    redirects: "1",
    format: "json",
    formatversion: "2",
    origin: "*",
  });
  const response = await fetchNoCorsWithTimeout(
    `https://zh.wikipedia.org/w/api.php?${parameters.toString()}`,
    4500,
    signal,
  );
  if (!response.ok) {
    throw new Error(`Wikimedia 搜索返回 HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    query?: {
      pages?: Array<{
        index?: unknown;
        title?: unknown;
        description?: unknown;
        langlinks?: Array<{ lang?: unknown; title?: unknown }>;
      }>;
    };
  };
  const pages = [...(payload.query?.pages ?? [])].sort(
    (left, right) => Number(left.index ?? 999) - Number(right.index ?? 999),
  );
  return uniqueOnlineCandidates(
    pages.flatMap((page, index) => {
      const evidence = `${String(page.title ?? "")} ${String(
        page.description ?? "",
      )}`;
      if (!/(?:电子|電子|电脑|電腦|视频|遊戲|游戏|video|computer)\s*(?:game|游戏|遊戲)?/iu.test(evidence)) {
        return [];
      }
      return (page.langlinks ?? [])
        .filter((link) => link.lang === "en")
        .map((link) => ({
          name: String(link.title ?? ""),
          score: 1150 - index * 25,
          source: "wikimedia" as const,
        }));
    }),
  );
}

export async function searchSteamStoreCandidates(
  query: string,
  language: "english" | "schinese" = "english",
  signal?: AbortSignal,
  limit = MAX_STEAM_CANDIDATES,
): Promise<SteamStoreCandidate[]> {
  const term = query.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!term) {
    return [];
  }
  const deduplicated = new Map<number, SteamStoreCandidate>();
  for (const country of ["CN", "US"]) {
    const parameters = new URLSearchParams({ term, l: language, cc: country });
    const response = await fetchNoCorsWithTimeout(
      `https://store.steampowered.com/api/storesearch/?${parameters.toString()}`,
      6500,
      signal,
    );
    if (!response.ok) {
      continue;
    }
    const payload = (await response.json()) as { items?: SteamStoreSearchItem[] };
    for (const item of payload.items ?? []) {
      const appId = Number(item.id);
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (item.type !== "app" || !Number.isFinite(appId) || appId <= 0 || !name) {
        continue;
      }
      if (!deduplicated.has(appId)) {
        deduplicated.set(appId, { appId, name, sourceQuery: term });
      }
      if (deduplicated.size >= limit) {
        break;
      }
    }
    if (deduplicated.size > 0 || deduplicated.size >= limit) {
      break;
    }
  }
  return [...deduplicated.values()].slice(0, limit);
}

async function mapLimitSettled<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await operation(values[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), values.length) }, worker),
  );
  return results;
}

async function searchLocalizedSteamEnglishNames(
  query: string,
  signal?: AbortSignal,
): Promise<OnlineEnglishCandidate[]> {
  const normalizedQuery = normalizedGameName(query);
  const localized = (await searchSteamStoreCandidates(
    query,
    "schinese",
    signal,
    8,
  )).filter((candidate, index) => {
    const normalizedName = normalizedGameName(candidate.name);
    const textRelated =
      normalizedName === normalizedQuery ||
      normalizedName.includes(normalizedQuery) ||
      normalizedQuery.includes(normalizedName);
    return textRelated || index < 3;
  });
  const settled = await mapLimitSettled(localized, 3, async (candidate) => {
    const englishName = await resolveSteamSearchName(
      candidate.appId,
      candidate.name,
      6000,
      signal,
    );
    if (!englishName || includesChinese(englishName)) {
      return null;
    }
    return {
      name: englishName,
      score:
        normalizedGameName(candidate.name) === normalizedQuery
          ? 1400
          : normalizedGameName(candidate.name).includes(normalizedQuery) ||
              normalizedQuery.includes(normalizedGameName(candidate.name))
            ? 1100
            : 850,
      source: "steam-localized" as const,
      steamCandidates: [
        {
          appId: candidate.appId,
          name: englishName,
          localizedName: candidate.name,
          sourceQuery: query,
        },
      ],
    };
  });
  return uniqueOnlineCandidates(
    settled.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    ),
  );
}

export function deriveSteamSearchRoots(
  seedNames: readonly string[],
  candidates: readonly SteamStoreCandidate[],
): TrainerSearchQuery[] {
  const seedTokens = new Set(seedNames.flatMap(normalizedEnglishWords));
  const documents = candidates.map((candidate) => ({
    candidate,
    displayWords: englishWords(candidate.name),
    words: normalizedEnglishWords(candidate.name),
  }));
  const phrases = new Map<
    string,
    { display: string; words: string[]; documents: Set<number>; startsTitle: boolean }
  >();
  for (const [documentIndex, document] of documents.entries()) {
    for (let start = 0; start < document.words.length; start += 1) {
      for (
        let length = 1;
        length <= Math.min(5, document.words.length - start);
        length += 1
      ) {
        const words = document.words.slice(start, start + length);
        const key = words.join(" ");
        const current = phrases.get(key) ?? {
          display: document.displayWords.slice(start, start + length).join(" "),
          words,
          documents: new Set<number>(),
          startsTitle: false,
        };
        current.documents.add(documentIndex);
        current.startsTitle ||= start === 0;
        phrases.set(key, current);
      }
    }
  }

  const ranked = [...phrases.entries()]
    .filter(([, phrase]) => {
      if (phrase.documents.size < 2) {
        return false;
      }
      const overlapsSeed = phrase.words.every((word) => seedTokens.has(word));
      if (!overlapsSeed && !phrase.startsTitle) {
        return false;
      }
      return phrase.words.length > 1 || phrase.words[0].length >= 5;
    })
    .map(([key, phrase]) => ({
      key,
      phrase,
      score:
        phrase.documents.size * 100 +
        phrase.words.length * 35 +
        key.length +
        (phrase.words.every((word) => seedTokens.has(word)) ? 250 : 0) +
        (phrase.startsTitle ? 60 : 0),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.phrase.words.length - left.phrase.words.length,
    );

  const selected: typeof ranked = [];
  for (const candidate of ranked) {
    if (
      selected.some((existing) =>
        containsWordSequence(existing.phrase.words, candidate.phrase.words) ||
        containsWordSequence(candidate.phrase.words, existing.phrase.words),
      )
    ) {
      continue;
    }
    selected.push(candidate);
    if (selected.length >= MAX_SERIES_QUERIES) {
      break;
    }
  }
  return selected.map(({ phrase, score }) => ({
    query: phrase.display,
    source: "steam-cluster",
    score,
    steamCandidates: documents
      .filter((document) => containsWordSequence(document.words, phrase.words))
      .map((document) => document.candidate),
  }));
}

async function cachedSteamFranchiseQueries(
  candidates: readonly SteamStoreCandidate[],
): Promise<TrainerSearchQuery[]> {
  if (typeof SteamClient === "undefined") {
    return [];
  }
  const apps = SteamClient.Apps as typeof SteamClient.Apps & {
    GetCachedAppDetails?: (appId: number) => Promise<string>;
  };
  if (typeof apps?.GetCachedAppDetails !== "function") {
    return [];
  }
  const discovered: TrainerSearchQuery[] = [];
  for (const candidate of candidates.slice(0, 8)) {
    try {
      const raw = await apps.GetCachedAppDetails(candidate.appId);
      if (!raw) {
        continue;
      }
      const parsed = JSON.parse(raw) as unknown;
      const details = Array.isArray(parsed)
        ? Object.fromEntries(
            parsed.filter(
              (item): item is [string, unknown] =>
                Array.isArray(item) && typeof item[0] === "string",
            ),
          )
        : parsed;
      if (!details || typeof details !== "object") {
        continue;
      }
      const associations = (details as {
        associations?: { data?: { rgFranchises?: unknown } };
      }).associations?.data?.rgFranchises;
      if (!Array.isArray(associations)) {
        continue;
      }
      const titleWords = normalizedEnglishWords(candidate.name);
      for (const franchise of associations) {
        const name = cleanEnglishCandidate(
          typeof franchise === "object" && franchise !== null && "strName" in franchise
            ? (franchise as { strName?: unknown }).strName
            : "",
        );
        const words = normalizedEnglishWords(name);
        if (!words.length || !containsWordSequence(titleWords, words)) {
          continue;
        }
        discovered.push({
          query: name,
          source: "steam-franchise",
          score: 1100 + words.length * 20,
          steamCandidates: candidates.filter((item) =>
            containsWordSequence(normalizedEnglishWords(item.name), words),
          ),
        });
      }
    } catch {
      // Steam only caches these associations for some library/store entries.
    }
  }
  return mergeSearchQueries(discovered);
}

function mergeSearchQueries(
  queries: readonly TrainerSearchQuery[],
): TrainerSearchQuery[] {
  const merged = new Map<string, TrainerSearchQuery>();
  for (const query of queries) {
    const cleaned = cleanEnglishCandidate(query.query);
    const key = normalizedEnglishPhrase(cleaned);
    if (!key) {
      continue;
    }
    const previous = merged.get(key);
    const steamCandidates = new Map<number, SteamStoreCandidate>();
    for (const candidate of [
      ...(previous?.steamCandidates ?? []),
      ...query.steamCandidates,
    ]) {
      steamCandidates.set(candidate.appId, candidate);
    }
    merged.set(key, {
      ...(previous && previous.score > query.score ? previous : query),
      query: cleaned,
      score: Math.max(previous?.score ?? 0, query.score),
      steamCandidates: [...steamCandidates.values()],
    });
  }
  return [...merged.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_SERIES_QUERIES);
}

export async function resolveManualSteamSearchPlan(
  value: string,
  preferredTarget?: Pick<
    SteamTarget,
    "appId" | "name" | "shortcutExe" | "shortcutStartDir"
  >,
  signal?: AbortSignal,
): Promise<TrainerSearchPlan> {
  const originalQuery = value.replace(/\s+/g, " ").trim().slice(0, 120);
  const empty: TrainerSearchPlan = {
    originalQuery,
    queries: [],
    fallbackQueries: [],
    warnings: [],
  };
  if (!originalQuery) {
    return empty;
  }
  const shortcutNames = shortcutEnglishNames(preferredTarget);
  const cacheKey = `${includesChinese(originalQuery) ? "zh" : "en"}:${normalizedGameName(originalQuery)}:${preferredTarget?.appId ?? 0}:${shortcutNames.map(normalizedEnglishPhrase).join("|")}`;
  const cached = searchPlanCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cloneSearchPlan({ ...cached.value, originalQuery });
  }

  if (!includesChinese(originalQuery)) {
    let steamCandidates: SteamStoreCandidate[] = [];
    const warnings: string[] = [];
    const shortcutCandidates = shortcutCandidatesForQuery(
      preferredTarget,
      originalQuery,
    );
    try {
      steamCandidates = await searchSteamStoreCandidates(
        originalQuery,
        "english",
        signal,
      );
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      warnings.push("Steam 英文候选暂不可用，已直接搜索 FLiNG。");
    }
    const plan: TrainerSearchPlan = {
      originalQuery,
      queries: mergeSearchQueries([
        {
          query: originalQuery,
          source: "manual-english",
          score: 1200,
          steamCandidates: [
            ...steamCandidates,
            ...shortcutCandidates.flatMap(
              (candidate) => candidate.steamCandidates ?? [],
            ),
          ],
        },
        ...shortcutCandidates.map((candidate) => ({
          query: candidate.name,
          source: candidate.source,
          score: candidate.score,
          steamCandidates: candidate.steamCandidates ?? [],
        })),
        ...deriveSteamSearchRoots([originalQuery], steamCandidates),
      ]),
      fallbackQueries: [],
      warnings,
    };
    searchPlanCache.set(cacheKey, {
      expiresAt: Date.now() + SEARCH_PLAN_CACHE_MS,
      value: cloneSearchPlan(plan),
    });
    return plan;
  }

  const warnings: string[] = [];
  const localCandidates: OnlineEnglishCandidate[] = [
    ...shortcutCandidatesForQuery(preferredTarget, originalQuery),
  ];
  if (
    preferredTarget &&
    preferredTarget.appId > 0 &&
    normalizedGameName(preferredTarget.name) === normalizedGameName(originalQuery)
  ) {
    const englishName = await resolveSteamSearchName(
      preferredTarget.appId,
      preferredTarget.name,
      6000,
      signal,
    );
    if (englishName && !includesChinese(englishName)) {
      localCandidates.push({
        name: englishName,
        score: 1600,
        source: "steam-localized",
        steamCandidates: [
          {
            appId: preferredTarget.appId,
            name: englishName,
            localizedName: preferredTarget.name,
            sourceQuery: originalQuery,
          },
        ],
      });
    }
  }

  const [translationResult, wikimediaResult, localizedSteamResult] =
    await Promise.allSettled([
    searchTranslationMemory(originalQuery, signal),
    searchWikimediaEnglishNames(originalQuery, signal),
    localCandidates.some((candidate) => candidate.source === "steam-shortcut")
      ? Promise.resolve([])
      : searchLocalizedSteamEnglishNames(originalQuery, signal),
  ]);
  if (signal?.aborted) {
    throw translationResult.status === "rejected"
      ? translationResult.reason
      : new Error("搜索已取消");
  }
  const translated =
    translationResult.status === "fulfilled" ? translationResult.value : [];
  const wikimedia =
    wikimediaResult.status === "fulfilled" ? wikimediaResult.value : [];
  const localizedSteam =
    localizedSteamResult.status === "fulfilled" ? localizedSteamResult.value : [];
  const onlineCandidates = uniqueOnlineCandidates([
    ...localCandidates,
    ...localizedSteam,
    ...translated,
    ...wikimedia,
  ]);
  if (translationResult.status === "rejected" && wikimedia.length) {
    warnings.push("在线翻译不可用，已使用 Wikimedia 跨语言结果。");
  }
  if (!onlineCandidates.length) {
    const plan = {
      ...empty,
      warnings: ["在线搜索没有解析出英文游戏名，请尝试更完整的中文名或英文名。"],
    };
    return plan;
  }

  const steamResults = await mapLimitSettled(
    onlineCandidates,
    3,
    (candidate) => searchSteamStoreCandidates(candidate.name, "english", signal),
  );
  if (signal?.aborted) {
    throw new Error("搜索已取消");
  }
  const allSteamCandidates: SteamStoreCandidate[] = [];
  const seedQueries: TrainerSearchQuery[] = [];
  for (const [index, result] of steamResults.entries()) {
    const candidate = onlineCandidates[index];
    const found = result.status === "fulfilled" ? result.value : [];
    allSteamCandidates.push(...found);
    seedQueries.push({
      query: candidate.name,
      source: candidate.source,
      score: candidate.score,
      steamCandidates: [
        ...(candidate.steamCandidates ?? []),
        ...found,
      ],
    });
  }
  if (
    steamResults.every((result) => result.status === "rejected") &&
    seedQueries.length
  ) {
    warnings.push("Steam 英文候选扩展失败，已直接使用在线解析结果。");
  }

  const roots = deriveSteamSearchRoots(
    onlineCandidates.map((candidate) => candidate.name),
    [...new Map(allSteamCandidates.map((item) => [item.appId, item])).values()],
  );
  const franchiseQueries = await cachedSteamFranchiseQueries(
    [...new Map(allSteamCandidates.map((item) => [item.appId, item])).values()],
  );
  const queries = mergeSearchQueries([
    ...seedQueries,
    ...franchiseQueries,
    ...roots,
  ]);
  const mainPhrases = queries.map((query) => normalizedEnglishWords(query.query));
  const fallbackQueries = mergeSearchQueries(
    seedQueries
      .filter((candidate) => {
        const words = normalizedEnglishWords(candidate.query);
        return !mainPhrases.some(
          (phrase) =>
            containsWordSequence(words, phrase) || containsWordSequence(phrase, words),
        );
      }),
  );
  const plan: TrainerSearchPlan = {
    originalQuery,
    queries,
    fallbackQueries,
    warnings:
      queries.length > 0
        ? warnings
        : ["在线搜索没有得到可验证的英文候选，请尝试英文游戏名。"],
  };
  if (plan.queries.length) {
    const verified = plan.queries.some(
      (query) =>
        query.source === "steam-shortcut" ||
        query.source === "steam-localized" ||
        query.source === "wikimedia" ||
        query.steamCandidates.some(
          (candidate) =>
            normalizedEnglishPhrase(candidate.name) ===
            normalizedEnglishPhrase(query.query),
        ),
    );
    searchPlanCache.set(cacheKey, {
      expiresAt:
        Date.now() + (verified ? SEARCH_PLAN_CACHE_MS : WEAK_SEARCH_PLAN_CACHE_MS),
      value: cloneSearchPlan(plan),
    });
  }
  return plan;
}

export async function resolveManualSteamSearch(
  value: string,
  preferredTarget?: Pick<
    SteamTarget,
    "appId" | "name" | "shortcutExe" | "shortcutStartDir"
  >,
): Promise<SteamSearchResolution> {
  const originalQuery = value.trim();
  const plan = await resolveManualSteamSearchPlan(value, preferredTarget);
  const selected = plan.queries[0] ?? plan.fallbackQueries[0];
  if (!selected) {
    return {
      originalQuery,
      searchQuery: originalQuery,
      warning: plan.warnings[0],
    };
  }
  const exact = selected.steamCandidates.find(
    (candidate) =>
      normalizedGameName(candidate.name) === normalizedGameName(selected.query),
  );
  const candidate = exact ?? selected.steamCandidates[0];
  return {
    originalQuery,
    searchQuery: selected.query,
    appId: candidate?.appId,
    localizedName: candidate?.localizedName,
    warning: plan.warnings[0],
  };
}

function readAppDetailsInternal(
  appId: number,
  timeoutMs: number,
  requireLaunchOptions: boolean,
): Promise<SteamTarget> {
  return new Promise((resolve, reject) => {
    let registration: Unregisterable | undefined;
    let timer: number | undefined;
    let settleTimer: number | undefined;
    let finished = false;
    let latestDetails: AppDetails | undefined;

    if (
      typeof SteamClient === "undefined" ||
      typeof SteamClient.Apps?.RegisterForAppDetails !== "function"
    ) {
      reject(new Error("当前 Steam 客户端不提供应用详情 API，无法安全读取启动项"));
      return;
    }

    const cleanup = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      if (settleTimer !== undefined) {
        window.clearTimeout(settleTimer);
      }
      window.setTimeout(() => registration?.unregister(), 0);
    };

    const finish = (details?: AppDetails, error?: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      const overview = window.appStore?.GetAppOverviewByAppID(appId);
      const targetType = detectSteamTargetType(appId, details) ?? "steam";
      const hasAppLaunchOptions =
        typeof details?.strLaunchOptions === "string";
      const appLaunchOptions = hasAppLaunchOptions
        ? details.strLaunchOptions
        : "";
      const shortcutLaunchOptions =
        typeof details?.strShortcutLaunchOptions === "string"
          ? details.strShortcutLaunchOptions
          : undefined;
      // CheatDeck and current Steam clients use the common app launch-options
      // field for both store apps and non-Steam shortcuts. Older clients can
      // expose only the shortcut-specific field, so retain that as a fallback.
      const launchOptionsField = hasAppLaunchOptions
        ? "app"
        : targetType === "shortcut" && shortcutLaunchOptions !== undefined
          ? "shortcut"
          : "app";
      const launchOptions = launchOptionsField === "shortcut"
        ? shortcutLaunchOptions ?? ""
        : appLaunchOptions;
      resolve({
        appId,
        name:
          details?.strDisplayName?.trim() ||
          overview?.display_name?.trim() ||
          `App ${appId}`,
        targetType,
        launchOptionsField,
        launchOptions,
        appLaunchOptions,
        shortcutLaunchOptions,
        running: currentRunningAppId() === appId,
        shortcutExe:
          typeof details?.strShortcutExe === "string"
            ? details.strShortcutExe.trim()
            : "",
        shortcutStartDir:
          typeof details?.strShortcutStartDir === "string"
            ? details.strShortcutStartDir.trim()
            : "",
      });
    };

    registration = SteamClient.Apps.RegisterForAppDetails(
      appId,
      (details: AppDetails) => {
        if (!details) {
          return;
        }
        latestDetails = { ...latestDetails, ...details } as AppDetails;
        const targetType = detectSteamTargetType(appId, latestDetails);
        const hasAppLaunchOptions =
          typeof latestDetails.strLaunchOptions === "string";
        const hasShortcutLaunchOptions =
          typeof latestDetails.strShortcutLaunchOptions === "string";
        const hasLaunchOptions = targetType === "shortcut"
          ? hasAppLaunchOptions || hasShortcutLaunchOptions
          : targetType === "steam"
            ? hasAppLaunchOptions
            : false;
        const hasShortcutMetadata = targetType !== "shortcut" ||
          typeof latestDetails.strShortcutLaunchOptions === "string" ||
          (typeof latestDetails.strShortcutExe === "string" &&
            latestDetails.strShortcutExe.trim().length > 0) ||
          (typeof latestDetails.strShortcutStartDir === "string" &&
            latestDetails.strShortcutStartDir.trim().length > 0);
        const hasShortcutIdentity = targetType !== "shortcut" ||
          (typeof latestDetails.strShortcutExe === "string" &&
            latestDetails.strShortcutExe.trim().length > 0) ||
          (typeof latestDetails.strShortcutStartDir === "string" &&
            latestDetails.strShortcutStartDir.trim().length > 0);
        const ready = requireLaunchOptions
          ? hasLaunchOptions
          : hasShortcutMetadata;
        const waitingForPreferredShortcutField = targetType === "shortcut" &&
          !hasAppLaunchOptions;
        if (
          targetType &&
          ready &&
          hasShortcutIdentity &&
          !waitingForPreferredShortcutField
        ) {
          finish(latestDetails);
          return;
        }
        if (settleTimer === undefined) {
          settleTimer = window.setTimeout(() => {
            settleTimer = undefined;
            if (finished || !latestDetails) {
              return;
            }
            const settledType = detectSteamTargetType(appId, latestDetails) ??
              "steam";
            const settledHasLaunchOptions = settledType === "shortcut"
              ? typeof latestDetails.strLaunchOptions === "string" ||
                typeof latestDetails.strShortcutLaunchOptions === "string"
              : typeof latestDetails.strLaunchOptions === "string";
            if (!requireLaunchOptions || settledHasLaunchOptions) {
              finish(latestDetails);
            }
          }, Math.min(75, Math.max(1, Math.floor(timeoutMs / 2))));
        }
      },
    );
    if (!finished) {
      timer = window.setTimeout(
        () => {
          if (requireLaunchOptions) {
            finish(
              undefined,
              new Error("读取目标启动项超时；为避免覆盖原设置，已停止操作"),
            );
          } else {
            finish(latestDetails);
          }
        },
        timeoutMs,
      );
    }
  });
}

function detectSteamTargetType(
  appId: number,
  details?: AppDetails,
): SteamTarget["targetType"] | undefined {
  const overview = window.appStore?.GetAppOverviewByAppID(appId) as
    | {
        app_type?: unknown;
        BIsShortcut?: () => boolean;
      }
    | undefined;
  const appType = Number(overview?.app_type ?? 0);
  if (appType === NON_STEAM_SHORTCUT_APP_TYPE) {
    return "shortcut";
  }
  if (
    (typeof details?.strShortcutExe === "string" &&
      details.strShortcutExe.trim().length > 0) ||
    (typeof details?.strShortcutStartDir === "string" &&
      details.strShortcutStartDir.trim().length > 0)
  ) {
    return "shortcut";
  }
  if (typeof overview?.BIsShortcut === "function") {
    try {
      if (overview.BIsShortcut()) {
        return "shortcut";
      }
    } catch {
      // Fall through to the stable numeric app type and detail fields.
    }
  }
  if (Number.isFinite(appType) && appType !== 0) {
    return "steam";
  }
  return undefined;
}

export function readAppSummary(
  appId: number,
  timeoutMs = 2500,
): Promise<SteamTarget> {
  return readAppDetailsInternal(appId, timeoutMs, false);
}

export function readAppDetails(
  appId: number,
  timeoutMs = 2500,
): Promise<SteamTarget> {
  return readAppDetailsInternal(appId, timeoutMs, true);
}

function shellTokens(value: string): string[] {
  const tokens: string[] = [];
  let start = -1;
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (start < 0) {
      if (/\s/.test(character)) {
        continue;
      }
      start = index;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      tokens.push(value.slice(start, index));
      start = -1;
    }
  }
  if (start >= 0) {
    tokens.push(value.slice(start));
  }
  return tokens;
}

type LiteralShellToken = {
  raw: string;
  value: string;
};

function literalShellTokens(source: string): LiteralShellToken[] | null {
  const tokens: LiteralShellToken[] = [];
  let rawStart = -1;
  let value = "";
  let quote: "'" | "\"" | null = null;

  const finish = (end: number) => {
    if (rawStart < 0) {
      return;
    }
    tokens.push({ raw: source.slice(rawStart, end), value });
    rawStart = -1;
    value = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (!quote && /[\r\n]/.test(character)) {
      return null;
    }
    if (rawStart < 0) {
      if (/\s/.test(character)) {
        continue;
      }
      rawStart = index;
    }
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        value += character;
      }
      continue;
    }
    if (quote === "\"") {
      if (character === "\"") {
        quote = null;
        continue;
      }
      if (character === "\\") {
        const next = source[index + 1];
        if (next === undefined || next === "\r" || next === "\n") {
          return null;
        }
        if (next === "$" || next === "`" || next === "\"" || next === "\\") {
          value += next;
          index += 1;
        } else {
          value += `\\${next}`;
          index += 1;
        }
        continue;
      }
      if (character === "$" || character === "`") {
        return null;
      }
      value += character;
      continue;
    }
    if (/\s/.test(character)) {
      finish(index);
      continue;
    }
    if ("|&;<>()".includes(character) || character === "#") {
      return null;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === "\"") {
      quote = "\"";
      continue;
    }
    if (character === "\\") {
      const next = source[index + 1];
      if (next === undefined || next === "\r" || next === "\n") {
        return null;
      }
      value += next;
      index += 1;
      continue;
    }
    if (character === "$" || character === "`") {
      return null;
    }
    value += character;
  }
  if (quote) {
    return null;
  }
  finish(source.length);
  return tokens;
}

function normalizedLinuxPath(value: string): string | null {
  if (!value.startsWith("/") || /[\0\r\n]/.test(value)) {
    return null;
  }
  const components: string[] = [];
  for (const component of value.split("/")) {
    if (!component || component === ".") {
      continue;
    }
    if (component === "..") {
      if (!components.length) {
        return null;
      }
      components.pop();
      continue;
    }
    components.push(component);
  }
  return `/${components.join("/")}`;
}

/**
 * Returns the one trainer executable represented by CheatDeck's standard
 * sidecar pair. Complex, duplicated, dynamic or incomplete commands fail
 * closed so TrainerDeck never silently takes ownership of an unknown command.
 */
export function detectCheatDeckTrainerExecutable(existing: string): string | null {
  const tokens = literalShellTokens(existing);
  if (!tokens) {
    return null;
  }
  const markers = tokens.filter(
    (token) => token.raw === "%command%" && token.value === "%command%",
  );
  if (markers.length !== 1) {
    return null;
  }
  const markerIndex = tokens.indexOf(markers[0]);
  const assignments = tokens
    .map((token, index) => {
      const equalsAt = token.value.indexOf("=");
      return equalsAt > 0
        ? {
            index,
            raw: token.raw,
            key: token.value.slice(0, equalsAt),
            value: token.value.slice(equalsAt + 1),
          }
        : null;
    })
    .filter((assignment): assignment is NonNullable<typeof assignment> =>
      assignment !== null
    );
  const remoteCommands = assignments.filter(
    (assignment) => assignment.key === "PROTON_REMOTE_DEBUG_CMD",
  );
  const sharedDirectories = assignments.filter(
    (assignment) => assignment.key === "PRESSURE_VESSEL_FILESYSTEMS_RW",
  );
  const firstPrefixIndex = tokens
    .slice(0, markerIndex)
    .findIndex((token) =>
      !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.raw)
    );
  if (
    remoteCommands.length !== 1 ||
    sharedDirectories.length !== 1 ||
    !remoteCommands[0].raw.startsWith("PROTON_REMOTE_DEBUG_CMD=") ||
    !sharedDirectories[0].raw.startsWith(
      "PRESSURE_VESSEL_FILESYSTEMS_RW=",
    ) ||
    remoteCommands[0].index >= markerIndex ||
    sharedDirectories[0].index >= markerIndex ||
    (firstPrefixIndex >= 0 &&
      (remoteCommands[0].index > firstPrefixIndex ||
        sharedDirectories[0].index > firstPrefixIndex))
  ) {
    return null;
  }

  const remoteWords = literalShellTokens(remoteCommands[0].value);
  if (!remoteWords || remoteWords.length !== 1) {
    return null;
  }
  const executable = normalizedLinuxPath(remoteWords[0].value);
  const directory = normalizedLinuxPath(sharedDirectories[0].value);
  if (!executable || !directory || !/\.exe$/i.test(executable)) {
    return null;
  }
  const separator = executable.lastIndexOf("/");
  return separator > 0 && executable.slice(0, separator) === directory
    ? executable
    : null;
}

function isManagedToken(token: string): boolean {
  const equalsAt = token.indexOf("=");
  if (equalsAt <= 0) {
    return false;
  }
  return MANAGED_ENV_KEYS.has(token.slice(0, equalsAt));
}

export function removeTrainerLaunchOptions(existing: string): string {
  return shellTokens(existing)
    .filter((token) => !isManagedToken(token))
    .join(" ")
    .trim();
}

export function hasManagedTrainerLaunchOptions(existing: string): boolean {
  return shellTokens(existing).some(isManagedToken);
}

export function hasCheatDeckLaunchOptions(existing: string): boolean {
  const keys = new Set(
    shellTokens(existing).flatMap((token) => {
      const equalsAt = token.indexOf("=");
      return equalsAt > 0 ? [token.slice(0, equalsAt)] : [];
    }),
  );
  return [...MANAGED_ENV_KEYS].every((key) => keys.has(key));
}

export function hasCheatDeckLaunchConfiguration(
  target: Pick<
    SteamTarget,
    "launchOptions" | "appLaunchOptions" | "shortcutLaunchOptions"
  >,
): boolean {
  return [
    target.launchOptions,
    target.appLaunchOptions,
    target.shortcutLaunchOptions ?? "",
  ].some(hasManagedTrainerLaunchOptions);
}

export function shlexQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function shellDoubleQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")}"`;
}

function managedLaunchTokens(executable: string): [string, string] {
  const separator = executable.lastIndexOf("/");
  if (!executable.startsWith("/") || separator <= 0) {
    throw new Error("修改器路径必须是 Linux 绝对路径");
  }
  if (/[\r\n]/.test(executable) || /%command%/i.test(executable)) {
    throw new Error("修改器路径包含 Steam 启动参数不支持的字符");
  }
  return [
    `PROTON_REMOTE_DEBUG_CMD=${shellDoubleQuote(shlexQuote(executable))}`,
    `PRESSURE_VESSEL_FILESYSTEMS_RW=${shellDoubleQuote(
      executable.slice(0, separator),
    )}`,
  ];
}

export function ownsTrainerLaunchOptions(
  existing: string,
  executable: string,
): boolean {
  let expected: [string, string];
  try {
    expected = managedLaunchTokens(executable);
  } catch {
    return false;
  }
  const tokens = shellTokens(existing);
  return tokens.includes(expected[0]);
}

export function removeOwnedTrainerLaunchOptions(
  existing: string,
  executable: string,
): string {
  if (!ownsTrainerLaunchOptions(existing, executable)) {
    return existing;
  }
  const expected = new Set(managedLaunchTokens(executable));
  return shellTokens(existing)
    .filter((token) => !expected.has(token))
    .join(" ")
    .trim();
}

export function buildTrainerLaunchOptions(
  existing: string,
  executable: string,
  cheatDeckExecutable?: string,
): string {
  const [remoteCommand, sharedDirectory] = managedLaunchTokens(executable);
  let preserved = existing.trim();
  if (hasManagedTrainerLaunchOptions(existing)) {
    const detected = detectCheatDeckTrainerExecutable(existing);
    const expected = cheatDeckExecutable
      ? normalizedLinuxPath(cheatDeckExecutable)
      : null;
    if (!detected || !expected || detected !== expected) {
      throw new Error(
        "检测到已有但无法安全交接的修改器启动项；仅支持路径与当前修改器一致的标准 CheatDeck 单程序配置",
      );
    }
    if (normalizedLinuxPath(executable) === detected) {
      return existing;
    }
    preserved = removeTrainerLaunchOptions(existing);
  }
  const managed = `${remoteCommand} ${sharedDirectory}`;
  if (!preserved) {
    return `${managed} %command%`;
  }
  return shellTokens(preserved).includes("%command%")
    ? `${managed} ${preserved}`
    : `${managed} %command% ${preserved}`;
}

export interface TrainerLaunchRecovery {
  launchOptions: string;
  changed: boolean;
  owned: boolean;
  usedBackup: boolean;
}

export function recoverTrainerLaunchOptions(
  existing: string,
  executable: string | readonly string[],
  originalLaunchOptions?: string | null,
  appliedLaunchOptions = "",
): TrainerLaunchRecovery {
  const originalSaved = originalLaunchOptions !== null &&
    originalLaunchOptions !== undefined;
  const appliedMatches = appliedLaunchOptions.trim().length > 0 &&
    existing.trim() === appliedLaunchOptions.trim();
  const candidates = (Array.isArray(executable) ? executable : [executable])
    .filter((candidate): candidate is string => candidate.length > 0);

  if (originalSaved && appliedMatches) {
    return {
      launchOptions: originalLaunchOptions,
      changed: existing !== originalLaunchOptions,
      owned: candidates.some((candidate) =>
        ownsTrainerLaunchOptions(existing, candidate)
      ),
      usedBackup: true,
    };
  }
  let cleaned = existing;
  let owned = false;
  for (const candidate of candidates) {
    if (!ownsTrainerLaunchOptions(cleaned, candidate)) {
      continue;
    }
    owned = true;
    cleaned = removeOwnedTrainerLaunchOptions(cleaned, candidate);
  }
  if (!owned) {
    return {
      launchOptions: existing,
      changed: false,
      owned: false,
      usedBackup: false,
    };
  }

  if (
    originalSaved &&
    detectCheatDeckTrainerExecutable(originalLaunchOptions) !== null
  ) {
    const originalManaged = shellTokens(originalLaunchOptions)
      .filter(isManagedToken)
      .join(" ");
    const restored = `${originalManaged} ${cleaned}`.trim();
    return {
      launchOptions: restored,
      changed: restored !== existing,
      owned: true,
      usedBackup: false,
    };
  }

  return {
    launchOptions:
      !originalSaved && cleaned.trim().toLowerCase() === "%command%"
        ? ""
        : cleaned,
    changed: true,
    owned: true,
    usedBackup: false,
  };
}

export function writeLaunchOptions(
  appId: number,
  field: SteamTarget["launchOptionsField"],
  launchOptions: string,
): void {
  if (field === "shortcut") {
    if (typeof SteamClient.Apps.SetShortcutLaunchOptions !== "function") {
      throw new Error(
        "当前 Steam 客户端不提供非 Steam 快捷方式启动项 API，已停止写入",
      );
    }
    SteamClient.Apps.SetShortcutLaunchOptions(appId, launchOptions);
    return;
  }
  SteamClient.Apps.SetAppLaunchOptions(appId, launchOptions);
}

function waitForSteam(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export async function writeLaunchOptionsSafely(
  observed: Pick<
    SteamTarget,
    | "appId"
    | "targetType"
    | "launchOptionsField"
    | "launchOptions"
  >,
  nextLaunchOptions: string,
  timeoutMs = 5000,
): Promise<void> {
  const beforeWrite = await readAppDetails(observed.appId, timeoutMs);
  if (beforeWrite.targetType !== observed.targetType) {
    throw new Error("Steam 目标类型在操作期间发生变化，已停止写入");
  }
  const beforeValue = observed.launchOptionsField === "shortcut"
    ? beforeWrite.shortcutLaunchOptions
    : beforeWrite.appLaunchOptions;
  if (beforeValue !== observed.launchOptions) {
    throw new Error(
      "目标启动项在操作期间已被用户或其他插件修改，已停止写入以避免覆盖",
    );
  }

  writeLaunchOptions(
    observed.appId,
    observed.launchOptionsField,
    nextLaunchOptions,
  );
  let lastValue: string | undefined = beforeValue;
  for (const delay of [200, 500, 900]) {
    await waitForSteam(delay);
    const confirmed = await readAppDetails(observed.appId, timeoutMs);
    if (confirmed.targetType !== observed.targetType) {
      throw new Error("Steam 目标类型在写入期间发生变化，无法安全确认启动项");
    }
    lastValue = observed.launchOptionsField === "shortcut"
      ? confirmed.shortcutLaunchOptions
      : confirmed.appLaunchOptions;
    if (lastValue === nextLaunchOptions) {
      return;
    }
  }
  throw new Error(
    `Steam 没有确认目标的新启动项，恢复记录已保留。当前值：${lastValue || "（空）"}`,
  );
}
