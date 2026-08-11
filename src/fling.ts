import { fetchNoCors } from "@decky/api";

import { t } from "./i18n";
import type {
  SearchResponse,
  SteamStoreCandidate,
  TrainerEntry,
  TrainerSearchQuery,
} from "./types";

const FLING_ORIGIN = "https://flingtrainer.com";
const OFFICIAL_HOSTS = new Set(["flingtrainer.com", "www.flingtrainer.com"]);
const SEARCH_TIMEOUT_MS = 12000;

export type FlingSearchMode = "exact" | "series";

export interface FlingSearchOptions {
  mode?: FlingSearchMode;
  signal?: AbortSignal;
  limit?: number;
  perPage?: number;
  timeoutMs?: number;
}

export interface FlingMultiSearchOptions {
  mode?: FlingSearchMode;
  signal?: AbortSignal;
  concurrency?: number;
}

type WordPressSearchItem = {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  type?: unknown;
  subtype?: unknown;
};

function normalizedSearchText(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_]+/gu)
      ?.join(" ") ?? ""
  );
}

function containsQueryTokenSequence(words: string[], query: string[]): boolean {
  if (!query.length || query.length > words.length) {
    return false;
  }
  for (let start = 0; start <= words.length - query.length; start += 1) {
    if (
      query.every((token, index) => {
        const word = words[start + index];
        return word === token ||
          (index === query.length - 1 && token.length >= 2 && word.startsWith(token));
      })
    ) {
      return true;
    }
  }
  return false;
}

function officialTrainerUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(value, FLING_ORIGIN);
    if (
      url.protocol !== "https:" ||
      !OFFICIAL_HOSTS.has(url.hostname) ||
      !url.pathname.includes("/trainer/")
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
    return url.toString();
  } catch {
    return null;
  }
}

export function parseFlingSearchItems(
  query: string,
  payload: unknown,
  options: Pick<FlingSearchOptions, "mode" | "limit"> = {},
): TrainerEntry[] {
  if (!Array.isArray(payload)) {
    throw new Error(t(
      "FLiNG 搜索返回了无效数据",
      "FLiNG search returned invalid data",
    ));
  }
  const queryText = normalizedSearchText(query);
  const queryWords = queryText.split(" ").filter(Boolean);
  const queryTokens = new Set(queryWords);
  const seen = new Set<string>();
  const candidates: Array<{ score: number; entry: TrainerEntry }> = [];

  for (const raw of payload as WordPressSearchItem[]) {
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const pageUrl = officialTrainerUrl(raw.url);
    if (
      !title ||
      !pageUrl ||
      !/trainer/i.test(title) ||
      (raw.type !== undefined && raw.type !== "post") ||
      seen.has(pageUrl)
    ) {
      continue;
    }
    seen.add(pageUrl);
    const gameName = title.replace(/\s*[-–—]?\s*trainer.*$/i, "").trim();
    const searchable = normalizedSearchText(gameName);
    const searchableWords = searchable.split(" ").filter(Boolean);
    const searchableTokens = new Set(searchableWords);
    let overlap = 0;
    for (const token of queryTokens) {
      if (searchableTokens.has(token)) {
        overlap += 1;
      }
    }
    const coverage = overlap / Math.max(1, queryTokens.size);
    const exact = queryText === searchable;
    const phraseMatch = containsQueryTokenSequence(searchableWords, queryWords);
    if (options.mode === "exact" ? !exact : !phraseMatch && coverage < 0.75) {
      continue;
    }
    const score =
      exact
        ? 1000
        : phraseMatch
          ? 500
          : 100 * overlap;
    const numericId = Number(raw.id);
    candidates.push({
      score,
      entry: {
        id: Number.isFinite(numericId)
          ? `fling-official:${numericId}`
          : `fling-official:${encodeURIComponent(pageUrl)}`,
        provider: "fling-official",
        game_name: gameName || title,
        title,
        version: "",
        page_url: pageUrl,
        download_url: "",
      },
    });
  }

  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.entry.game_name.length - right.entry.game_name.length ||
      left.entry.title.localeCompare(right.entry.title),
  );
  const limit = Math.max(1, Math.min(options.limit ?? 12, 100));
  return candidates.slice(0, limit).map(({ entry }) => entry);
}

export async function searchFlingTrainers(
  query: string,
  options: FlingSearchOptions = {},
): Promise<SearchResponse> {
  const term = query.replace(/\s+/g, " ").trim().slice(0, 120);
  if (term.length < 2) {
    throw new Error(t(
      "搜索词至少需要 2 个字符",
      "The search term must contain at least 2 characters",
    ));
  }
  const perPage = Math.max(1, Math.min(options.perPage ?? 20, 100));
  const parameters = new URLSearchParams({
    search: term,
    per_page: String(perPage),
    subtype: "post",
  });
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? SEARCH_TIMEOUT_MS);
  try {
    const response = await fetchNoCors(
      `${FLING_ORIGIN}/wp-json/wp/v2/search?${parameters.toString()}`,
      {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(t(
        `FLiNG 搜索服务返回 HTTP ${response.status}`,
        `FLiNG search service returned HTTP ${response.status}`,
      ));
    }
    const items = parseFlingSearchItems(term, await response.json(), {
      mode: options.mode,
      limit: options.limit,
    });
    const total = Number(response.headers?.get?.("X-WP-Total") ?? 0);
    return {
      items,
      warnings: [
        ...(items.length === 0 && !/[A-Za-z]/.test(term)
          ? [t(
            "FLiNG 官方索引使用英文游戏名；请使用 Steam 英文名搜索",
            "The official FLiNG index uses English game names. Search with the English Steam title.",
          )]
          : []),
        ...(total > perPage
          ? [t(
            `FLiNG 返回 ${total} 条原始记录，本次已检查前 ${perPage} 条。`,
            `FLiNG returned ${total} raw records; the first ${perPage} were checked.`,
          )]
          : []),
      ],
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    if (timedOut) {
      throw new Error(
        t(
          `FLiNG 搜索在 ${Math.ceil((options.timeoutMs ?? SEARCH_TIMEOUT_MS) / 1000)} 秒内没有响应，请检查网络后重试`,
          `FLiNG search did not respond within ${Math.ceil((options.timeoutMs ?? SEARCH_TIMEOUT_MS) / 1000)} seconds. Check your connection and try again.`,
        ),
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function compatibleAppIds(
  entry: TrainerEntry,
  candidates: readonly SteamStoreCandidate[],
): number[] {
  const gameName = normalizedSearchText(entry.game_name);
  return [...new Set(
    candidates
      .filter((candidate) => normalizedSearchText(candidate.name) === gameName)
      .map((candidate) => candidate.appId),
  )];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapQueriesWithLimit<T>(
  queries: readonly TrainerSearchQuery[],
  limit: number,
  operation: (query: TrainerSearchQuery, index: number) => Promise<T>,
): Promise<Array<PromiseSettledResult<T>>> {
  const results = new Array<PromiseSettledResult<T>>(queries.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < queries.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await operation(queries[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), queries.length) }, worker),
  );
  return results;
}

export async function searchFlingTrainersMany(
  inputQueries: readonly TrainerSearchQuery[],
  options: FlingMultiSearchOptions = {},
): Promise<SearchResponse> {
  const unique = new Map<string, TrainerSearchQuery>();
  for (const query of inputQueries) {
    const term = query.query.replace(/\s+/g, " ").trim().slice(0, 120);
    const key = normalizedSearchText(term);
    if (!key) {
      continue;
    }
    const previous = unique.get(key);
    const cleaned = { ...query, query: term };
    if (!previous) {
      unique.set(key, cleaned);
      continue;
    }
    const preferred = query.score > previous.score ? cleaned : previous;
    const steamCandidates = new Map(
      [...(previous.steamCandidates ?? []), ...(query.steamCandidates ?? [])].map(
        (candidate) => [candidate.appId, candidate],
      ),
    );
    unique.set(key, {
      ...preferred,
      steamCandidates: [...steamCandidates.values()],
    });
  }
  const queries = [...unique.values()];
  if (!queries.length) {
    return {
      items: [],
      warnings: [t(
        "没有可用于 FLiNG 的英文搜索候选。",
        "No English search candidates are available for FLiNG.",
      )],
    };
  }

  const settled = await mapQueriesWithLimit(
    queries,
    options.concurrency ?? 3,
    (query) =>
      searchFlingTrainers(query.query, {
        mode: options.mode ?? "series",
        signal: options.signal,
        limit: options.mode === "exact" ? 12 : 100,
        perPage: options.mode === "exact" ? 20 : 100,
      }),
  );
  if (options.signal?.aborted) {
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    throw rejected?.reason ?? new Error(t("搜索已取消", "Search cancelled"));
  }

  const merged = new Map<string, TrainerEntry>();
  const warnings: string[] = [];
  let completed = 0;
  for (const [index, result] of settled.entries()) {
    const query = queries[index];
    if (result.status === "rejected") {
      warnings.push(t(
        `“${query.query}”搜索失败：${errorText(result.reason)}`,
        `Search for “${query.query}” failed: ${errorText(result.reason)}`,
      ));
      continue;
    }
    completed += 1;
    warnings.push(...result.value.warnings);
    for (const entry of result.value.items) {
      const key = entry.page_url || entry.id;
      const previous = merged.get(key);
      const appIds = compatibleAppIds(entry, query.steamCandidates);
      const matchedQueries = new Set([
        ...(previous?.matched_queries ?? []),
        query.query,
      ]);
      const allAppIds = new Set([
        ...(previous?.compatible_app_ids ?? []),
        ...appIds,
      ]);
      merged.set(key, {
        ...(previous ?? entry),
        matched_queries: [...matchedQueries],
        compatible_app_ids: [...allAppIds],
        search_match:
          allAppIds.size > 0
            ? "exact-app"
            : options.mode === "exact"
              ? "unverified"
              : "series",
      });
    }
  }
  if (completed === 0) {
    throw new Error(warnings[0] ?? t(
      "FLiNG 搜索全部失败",
      "All FLiNG searches failed",
    ));
  }
  return {
    items: [...merged.values()],
    warnings: [...new Set(warnings)],
  };
}
