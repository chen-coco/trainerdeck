import {
  FileSelectionType,
  openFilePicker,
  toaster,
} from "@decky/api";
import {
  ButtonItem,
  Navigation,
  PanelSection,
  PanelSectionRow,
  ToggleField,
} from "@decky/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import { withTimeout } from "./async";
import { getSettings, saveSettings } from "./backend";
import { t } from "./i18n";
import { RECOVERY_ROUTE } from "./recovery";
import type { TrainerDeckSettings } from "./types";

export const SETTINGS_ROUTE = "/trainerdeck/settings";
export const SETTINGS_CHANGED_EVENT = "trainerdeck-settings-changed";
export const DEFAULT_TRAINER_ROOT = "/home/deck/Downloads/trainer";
export const DEFAULT_SETTINGS: TrainerDeckSettings = {
  schema_version: 3,
  trainer_root: DEFAULT_TRAINER_ROOT,
  auto_search_and_add: false,
  restore_input_on_qam_close: false,
};

const SETTINGS_TIMEOUT_MS = 8000;

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function publishSettings(settings: TrainerDeckSettings): void {
  window.dispatchEvent(
    new CustomEvent<TrainerDeckSettings>(SETTINGS_CHANGED_EVENT, {
      detail: settings,
    }),
  );
}

export function TrainerDeckSettingsPage() {
  const [settings, setSettings] =
    useState<TrainerDeckSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const loadRequest = useRef(0);

  const load = useCallback(async () => {
    const request = loadRequest.current + 1;
    loadRequest.current = request;
    setStatus("loading");
    setMessage("");
    try {
      const loaded = await withTimeout(
        getSettings(),
        SETTINGS_TIMEOUT_MS,
        t(
          "读取设置超时，请确认 TrainerDeck 后端已加载",
          "Reading settings timed out. Make sure the TrainerDeck backend is loaded.",
        ),
      );
      if (loadRequest.current !== request) {
        return;
      }
      setSettings({ ...DEFAULT_SETTINGS, ...loaded });
      setStatus("ready");
    } catch (error) {
      if (loadRequest.current !== request) {
        return;
      }
      setStatus("error");
      setMessage(errorText(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = useCallback(
    async (next: TrainerDeckSettings, successMessage: string) => {
      if (saving) {
        return false;
      }
      loadRequest.current += 1;
      setSettings(next);
      setSaving(true);
      try {
        const saved = await withTimeout(
          saveSettings(next),
          SETTINGS_TIMEOUT_MS,
          t("保存设置超时，请稍后重试", "Saving settings timed out. Try again later."),
        );
        const normalized = { ...DEFAULT_SETTINGS, ...saved };
        setSettings(normalized);
        setStatus("ready");
        setMessage("");
        publishSettings(normalized);
        toaster.toast({ title: "TrainerDeck", body: successMessage });
        return true;
      } catch (error) {
        const detail = errorText(error);
        setStatus("error");
        setMessage(t(`当前更改尚未保存：${detail}`, `Changes were not saved: ${detail}`));
        toaster.toast({
          title: t("更改尚未保存", "Changes not saved"),
          body: t(
            `${detail}；目录选择器仍可继续使用`,
            `${detail}. You can still use the folder picker.`,
          ),
        });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [saving],
  );

  const pickTrainerRoot = useCallback(async () => {
    if (saving || picking) {
      return;
    }
    setPicking(true);
    try {
      const configuredPath = settings.trainer_root.trim();
      const startPath =
        configuredPath && configuredPath !== DEFAULT_TRAINER_ROOT
          ? configuredPath
          : "/home/deck/Downloads";
      const result = await openFilePicker(
        FileSelectionType.FOLDER,
        startPath,
        false,
        true,
      );
      const selectedPath = String(
        result?.realpath || result?.path || "",
      ).trim();
      if (!selectedPath) {
        return;
      }
      await persist(
        { ...settings, trainer_root: selectedPath },
        t(
          `下载目录已更新：${selectedPath}`,
          `Download folder updated: ${selectedPath}`,
        ),
      );
    } catch (error) {
      if (/cancel/i.test(errorText(error))) {
        return;
      }
      toaster.toast({
        title: t("选择目录失败", "Could not select folder"),
        body: errorText(error),
      });
    } finally {
      setPicking(false);
    }
  }, [persist, picking, saving, settings]);

  const openRecoveryPage = useCallback(() => {
    try {
      Navigation.Navigate(RECOVERY_ROUTE);
    } catch (error) {
      toaster.toast({
        title: t("打开恢复页面失败", "Could not open recovery page"),
        body: errorText(error),
      });
    }
  }, []);

  return (
    <div
      style={{
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        minHeight: "100%",
        overflowY: "auto",
        paddingBottom: "24px",
        paddingTop: "48px",
      }}
    >
      <PanelSection title={t("TrainerDeck 设置", "TrainerDeck Settings")}>
        {status !== "ready" && (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              description={
                status === "loading"
                  ? t("正在连接插件后端", "Connecting to the plugin backend")
                  : message
              }
              disabled={status === "loading"}
              onClick={() => void load()}
            >
              {status === "loading"
                ? t("正在读取设置…", "Loading settings…")
                : t("读取失败，点此重试", "Load failed. Select to retry")}
            </ButtonItem>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ToggleField
            label={t(
              "自动搜索并添加当前游戏",
              "Automatically find and add the current game",
            )}
            description={t(
              "开启后会自动精确搜索；唯一核验到当前 Steam AppID 时继续下载并绑定，非 Steam 快捷方式需手动确认。检测到已有 CheatDeck 启动设置时自动跳过。关闭时仍会自动填入游戏名，只进行手动搜索",
              "When enabled, TrainerDeck searches for an exact match and downloads and binds it only when a single result is verified against the current Steam AppID. Non-Steam shortcuts require manual confirmation. Games with existing CheatDeck launch options are skipped. When disabled, the game name is still filled in for manual search.",
            )}
            checked={settings.auto_search_and_add}
            disabled={saving || status !== "ready"}
            onChange={(value) =>
              void persist(
                { ...settings, auto_search_and_add: value },
                value
                  ? t(
                    "已开启自动搜索并添加当前游戏",
                    "Automatic search and add enabled",
                  )
                  : t(
                    "已关闭自动搜索并添加；仍会自动填入游戏名",
                    "Automatic search and add disabled; the game name will still be filled in",
                  ),
              )
            }
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label={t(
              "关闭快捷菜单时恢复游戏输入",
              "Restore game input when closing Quick Access",
            )}
            description={t(
              "本轮成功操作过修改器后，关闭整个 SteamOS 右侧快捷菜单时，短暂进入整屏焦点过渡并由 Steam 原生接口返回游戏，重新建立手柄输入；适用于仅接收前台控制器输入的游戏",
              "After a successful trainer action, closing the SteamOS Quick Access menu briefly opens a full-screen focus transition and uses Steam's native API to return to the game and restore controller input. This helps games that only accept input while in the foreground.",
            )}
            checked={settings.restore_input_on_qam_close}
            disabled={saving || status !== "ready"}
            onChange={(value) =>
              void persist(
                { ...settings, restore_input_on_qam_close: value },
                value
                  ? t(
                    "已开启关闭快捷菜单时恢复游戏输入",
                    "Game input recovery on Quick Access close enabled",
                  )
                  : t(
                    "已关闭快捷菜单时恢复游戏输入",
                    "Game input recovery on Quick Access close disabled",
                  ),
              )
            }
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t("游戏启动项恢复", "Launch Option Recovery")}>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            description={t(
              "游戏无法启动时，一键移除 TrainerDeck 参数并保留其他启动项和修改器文件",
              "If a game no longer starts, remove TrainerDeck parameters while preserving other launch options and trainer files.",
            )}
            onClick={openRecoveryPage}
          >
            {t("管理与恢复启动项", "Manage and Restore Launch Options")}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t("下载目录", "Download Folder")}>
        <PanelSectionRow>
          <div
            style={{
              fontSize: "12px",
              lineHeight: 1.5,
              overflowWrap: "anywhere",
            }}
          >
            {settings.trainer_root || DEFAULT_TRAINER_ROOT}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={saving || picking}
            onClick={() => void pickTrainerRoot()}
          >
            {picking
              ? t("正在选择目录…", "Selecting folder…")
              : saving
                ? t("正在保存…", "Saving…")
                : t("选择下载目录", "Select Download Folder")}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </div>
  );
}
