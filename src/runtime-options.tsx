import {
  ButtonItem,
  DialogButton,
  Focusable,
  PanelSectionRow,
  TextField,
  ToggleField,
} from "@decky/ui";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { withTimeout } from "./async";
import { getOptionFavorites, setOptionFavorite } from "./backend";
import { localizedTrainerText, t } from "./i18n";
import {
  filterRuntimeOptions,
  groupRuntimeOptions,
  OptionFavoritesController,
  optionFavoriteScope,
} from "./runtime-options-model";
import type { TrainerRuntimeOption, TrainerRuntimeSnapshot } from "./types";

interface RuntimeOptionsPanelProps {
  runtime: TrainerRuntimeSnapshot;
  renderOption: (option: TrainerRuntimeOption) => ReactNode;
}

const FAVORITES_TIMEOUT_MS = 8000;
const noteStyle = { fontSize: "12px", lineHeight: 1.5, opacity: 0.8 };

export function RuntimeOptionsPanel(props: RuntimeOptionsPanelProps) {
  if (props.runtime.options.length === 0) return null;
  const scope = optionFavoriteScope(props.runtime.app_id, props.runtime.trainer_sha256);
  return (
    <ScopedRuntimeOptionsPanel
      key={scope || `unavailable:${props.runtime.app_id}`}
      {...props}
    />
  );
}

function ScopedRuntimeOptionsPanel({ runtime, renderOption }: RuntimeOptionsPanelProps) {
  const [query, setQuery] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const trainerSha256 = runtime.trainer_sha256.trim().toLowerCase();
  const controller = useMemo(
    () => new OptionFavoritesController(runtime.app_id, trainerSha256, {
      get: (appId, hash) => withTimeout(
        getOptionFavorites(appId, hash),
        FAVORITES_TIMEOUT_MS,
        t("读取收藏超时，请重试", "Loading favorites timed out. Please retry."),
      ),
      set: (appId, hash, optionId, favorite) => withTimeout(
        setOptionFavorite(appId, hash, optionId, favorite),
        FAVORITES_TIMEOUT_MS,
        t("保存收藏超时，请重新读取确认", "Saving favorites timed out. Reload to confirm."),
      ),
    }),
    [runtime.app_id, trainerSha256],
  );
  const [favoritesState, setFavoritesState] = useState(() => controller.getSnapshot());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setFavoritesState);
    void controller.load();
    return unsubscribe;
  }, [controller]);

  const favorites = new Set(favoritesState.favorites);
  const activeStateAvailable = runtime.connected && runtime.game_available === true;
  const filtered = filterRuntimeOptions(runtime.options, favorites, {
    query,
    favoritesOnly,
    activeOnly: activeOnly && activeStateAvailable,
  });
  const groups = groupRuntimeOptions(filtered, favorites);
  const activeCount = runtime.options.filter((option) => option.active === true).length;
  const favoriteCount = runtime.options.filter((option) => favorites.has(option.id)).length;
  const filteredByUser = Boolean(query.trim() || favoritesOnly || activeOnly);

  const resetFilters = () => {
    setQuery("");
    setFavoritesOnly(false);
    setActiveOnly(false);
  };

  const toggleGroup = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <>
      <PanelSectionRow>
        <TextField
          label={t("查找修改项", "Find trainer options")}
          description={t("支持中文、英文名称和分组", "Search Chinese or English names and groups")}
          value={query}
          bShowClearAction
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label={favoritesState.status === "ready"
            ? t(`只看收藏 (${favoriteCount})`, `Favorites only (${favoriteCount})`)
            : t("只看收藏", "Favorites only")}
          checked={favoritesOnly}
          disabled={favoritesState.status !== "ready" && !favoritesOnly}
          onChange={setFavoritesOnly}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label={t("只看已开启", "Enabled only")}
          description={!activeStateAvailable && activeOnly
            ? t(
              "状态暂不可用，已暂停此筛选并保留修改项；游戏连接恢复后继续筛选",
              "Status is unavailable. This filter is paused so options remain visible; it resumes when the game reconnects.",
            )
            : undefined}
          checked={activeOnly}
          onChange={setActiveOnly}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={noteStyle} aria-live="polite">
          {activeStateAvailable
            ? t(
              `${filtered.length} / ${runtime.options.length} 项 · 已开启 ${activeCount} 项`,
              `${filtered.length} / ${runtime.options.length} options · ${activeCount} enabled`,
            )
            : t(
              `${filtered.length} / ${runtime.options.length} 项 · 状态暂不可用`,
              `${filtered.length} / ${runtime.options.length} options · Status unavailable`,
            )}
          {favoritesState.saving && ` · ${t("正在保存收藏…", "Saving favorites…")}`}
        </div>
      </PanelSectionRow>
      {favoritesState.status === "loading" && (
        <PanelSectionRow>
          <div style={noteStyle}>{t("正在读取收藏…", "Loading favorites…")}</div>
        </PanelSectionRow>
      )}
      {favoritesState.status === "unavailable" && (
        <PanelSectionRow>
          <div style={noteStyle}>
            {t("修改器识别完成后即可收藏修改项", "Favorites will be available once this trainer is identified.")}
          </div>
        </PanelSectionRow>
      )}
      {favoritesState.status === "error" && (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            description={favoritesState.message}
            onClick={() => void controller.load()}
          >
            {t("收藏尚未同步，点此重试", "Favorites are not synchronized. Select to retry")}
          </ButtonItem>
        </PanelSectionRow>
      )}
      {filteredByUser && (
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={resetFilters}>
            {t("清除筛选", "Clear filters")}
          </ButtonItem>
        </PanelSectionRow>
      )}
      {filtered.length === 0 && (
        <PanelSectionRow>
          <div style={noteStyle}>
            {favoritesOnly && favoritesState.status !== "ready"
              ? t("请先重新读取收藏后再查看筛选结果", "Reload favorites to view the filtered results.")
              : favoritesOnly && favoriteCount === 0
              ? t("还没有收藏的修改项。选择修改项旁的 ☆ 即可收藏。", "No favorite options yet. Select ☆ beside an option to save it.")
              : t("没有符合筛选条件的修改项", "No options match these filters.")}
          </div>
        </PanelSectionRow>
      )}
      {groups.map((group) => {
        const groupLabel = group.favorite
          ? t("常用收藏", "Favorites")
          : localizedTrainerText(group.label) || t("其他修改项", "Other options");
        const isCollapsed = collapsed.has(group.id);
        return (
          <Fragment key={group.id}>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                onClick={() => toggleGroup(group.id)}
              >
                <span aria-expanded={!isCollapsed}>
                  {`${isCollapsed ? "▶" : "▼"} ${groupLabel} (${group.options.length})`}
                </span>
              </ButtonItem>
            </PanelSectionRow>
            {!isCollapsed && group.options.map((option) => {
              const favorite = favorites.has(option.id);
              const label = localizedTrainerText(option.labels) || option.id;
              const action = favorite ? t("取消收藏", "Remove favorite") : t("收藏", "Add favorite");
              return (
                <PanelSectionRow key={option.id}>
                  <Focusable
                    flow-children="horizontal"
                    style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 40px", gap: "8px", width: "100%", alignItems: "start" }}
                  >
                    <div style={{ minWidth: 0 }}>{renderOption(option)}</div>
                    <DialogButton
                      disabled={favoritesState.status !== "ready" || favoritesState.saving}
                      onOKActionDescription={action}
                      onClick={() => void controller.setFavorite(option.id, !favorite)}
                      style={{ minWidth: "40px", width: "40px", minHeight: "40px", padding: 0, color: favorite ? "#ffd76a" : undefined }}
                    >
                      <span aria-label={`${action}: ${label}`} title={`${action}: ${label}`}>
                        {favorite ? "★" : "☆"}
                      </span>
                    </DialogButton>
                  </Focusable>
                </PanelSectionRow>
              );
            })}
          </Fragment>
        );
      })}
    </>
  );
}
