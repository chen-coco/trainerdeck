import type { LocalizedTrainerText, TrainerRuntimeOption } from "./types";

export interface RuntimeOptionFilters {
  query: string;
  favoritesOnly: boolean;
  activeOnly: boolean;
}

export interface RuntimeOptionGroup {
  id: string;
  label: LocalizedTrainerText;
  favorite: boolean;
  options: TrainerRuntimeOption[];
}

export function optionFavoriteScope(appId: number, trainerSha256: string): string {
  const hash = trainerSha256.trim().toLowerCase();
  return Number.isSafeInteger(appId) && appId > 0 && /^[a-f0-9]{64}$/.test(hash)
    ? `${appId}:${hash}`
    : "";
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function filterRuntimeOptions(
  options: TrainerRuntimeOption[],
  favorites: ReadonlySet<string>,
  filters: RuntimeOptionFilters,
): TrainerRuntimeOption[] {
  const tokens = normalizeSearch(filters.query).trim().split(/\s+/).filter(Boolean);
  return options.filter((option) => {
    if (filters.favoritesOnly && !favorites.has(option.id)) return false;
    if (filters.activeOnly && option.active !== true) return false;
    const text = normalizeSearch([
      option.id,
      ...Object.values(option.labels),
      ...Object.values(option.group),
    ].join(" "));
    return tokens.every((token) => text.includes(token));
  });
}

export function groupRuntimeOptions(
  options: TrainerRuntimeOption[],
  favorites: ReadonlySet<string>,
): RuntimeOptionGroup[] {
  const pinned = options.filter((option) => favorites.has(option.id));
  const groups = new Map<string, RuntimeOptionGroup>();
  for (const option of options) {
    if (favorites.has(option.id)) continue;
    const id = `group:${JSON.stringify([
      option.group.en || "",
      option.group.zh_cn || "",
      option.group.zh_tw || "",
    ])}`;
    const group = groups.get(id);
    if (group) {
      group.options.push(option);
    } else {
      groups.set(id, { id, label: option.group, favorite: false, options: [option] });
    }
  }
  return [
    ...(pinned.length
      ? [{ id: "favorites", label: {}, favorite: true, options: pinned }]
      : []),
    ...groups.values(),
  ];
}

export interface OptionFavoritesState {
  status: "unavailable" | "loading" | "ready" | "error";
  favorites: string[];
  saving: boolean;
  message: string;
}

export interface OptionFavoritesClient {
  get: (appId: number, trainerSha256: string) => Promise<string[]>;
  set: (
    appId: number,
    trainerSha256: string,
    optionId: string,
    favorite: boolean,
  ) => Promise<string[]>;
}

function normalizeFavorites(favorites: string[]): string[] {
  if (!Array.isArray(favorites) || favorites.some((id) => typeof id !== "string")) {
    throw new Error("Invalid saved favorites response");
  }
  return [...new Set(favorites.filter(Boolean))];
}

/** Owns one game's executable scope; concurrent writes and stale responses never replace its state. */
export class OptionFavoritesController {
  private state: OptionFavoritesState;
  private request = 0;
  private listener: ((state: OptionFavoritesState) => void) | undefined;
  private readonly hash: string;
  private readonly validScope: boolean;

  constructor(
    private readonly appId: number,
    trainerSha256: string,
    private readonly client: OptionFavoritesClient,
  ) {
    this.hash = trainerSha256.trim().toLowerCase();
    this.validScope = Boolean(optionFavoriteScope(appId, this.hash));
    this.state = {
      status: this.validScope ? "loading" : "unavailable",
      favorites: [],
      saving: false,
      message: "",
    };
  }

  getSnapshot(): OptionFavoritesState {
    return this.state;
  }

  subscribe(listener: (state: OptionFavoritesState) => void): () => void {
    this.listener = listener;
    listener(this.state);
    return () => {
      if (this.listener === listener) {
        this.listener = undefined;
        this.request += 1;
        this.state = {
          ...this.state,
          status: this.validScope ? "loading" : "unavailable",
          saving: false,
        };
      }
    };
  }

  private publish(state: OptionFavoritesState): void {
    this.state = state;
    this.listener?.(state);
  }

  async load(): Promise<void> {
    if (!this.validScope || this.state.saving) return;
    const request = ++this.request;
    this.publish({ ...this.state, status: "loading", message: "" });
    try {
      const favorites = normalizeFavorites(await this.client.get(this.appId, this.hash));
      if (request !== this.request) return;
      this.publish({ status: "ready", favorites, saving: false, message: "" });
    } catch (error) {
      if (request !== this.request) return;
      this.publish({
        ...this.state,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async setFavorite(optionId: string, favorite: boolean): Promise<void> {
    if (!this.validScope || this.state.status !== "ready" || this.state.saving || !optionId) {
      return;
    }
    const request = ++this.request;
    this.publish({ ...this.state, saving: true, message: "" });
    try {
      const favorites = normalizeFavorites(
        await this.client.set(this.appId, this.hash, optionId, favorite),
      );
      if (request !== this.request) return;
      this.publish({ status: "ready", favorites, saving: false, message: "" });
    } catch (error) {
      if (request !== this.request) return;
      // A failed write can have reached the server. Re-read before allowing another edit.
      this.publish({
        ...this.state,
        status: "error",
        saving: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
