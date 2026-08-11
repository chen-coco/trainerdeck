import { toaster } from "@decky/api";
import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { withTimeout } from "./async";
import { listBindings, unbindTrainer } from "./backend";
import { t } from "./i18n";
import {
  readAppDetails,
  recoverTrainerLaunchOptions,
  writeLaunchOptionsSafely,
} from "./steam";
import type { SteamTarget, TrainerBindingRecord } from "./types";

export const RECOVERY_ROUTE = "/trainerdeck/settings/launch-options";

const BACKEND_TIMEOUT_MS = 8000;
const STEAM_READ_TIMEOUT_MS = 5000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function launchOptionsEqual(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

function recordName(record: TrainerBindingRecord): string {
  return record.display_name || record.title || t("未知游戏", "Unknown game");
}

function recordTargetLabel(record: TrainerBindingRecord): string {
  return record.target_type === "shortcut"
    ? t("非 Steam 快捷方式", "Non-Steam shortcut")
    : record.target_type === "steam"
      ? t("Steam 游戏", "Steam game")
      : t("游戏", "Game");
}

export type TrainerLaunchBindingRecovery = Pick<
  TrainerBindingRecord,
  | "app_id"
  | "managed_launch_executable"
  | "candidate_launch_executables"
  | "original_launch_options"
  | "applied_launch_options"
  | "target_type"
  | "launch_options_field"
  | "shortcut_exe"
>;

type LaunchField = SteamTarget["launchOptionsField"];

function launchOptionsForField(
  details: SteamTarget,
  field: LaunchField,
): string | undefined {
  return field === "shortcut"
    ? details.shortcutLaunchOptions
    : details.appLaunchOptions;
}

export async function restoreTrainerLaunchBinding(
  record: TrainerLaunchBindingRecovery,
): Promise<void> {
  const details = await readAppDetails(record.app_id, STEAM_READ_TIMEOUT_MS);
  const original = record.original_launch_options;
  const recordedTargetType = record.target_type === "steam" ||
      record.target_type === "shortcut"
    ? record.target_type
    : null;
  const recordedLaunchField = record.launch_options_field === "app" ||
      record.launch_options_field === "shortcut"
    ? record.launch_options_field
    : null;
  if (recordedTargetType && details.targetType !== recordedTargetType) {
    throw new Error(
      t(
        "当前游戏的目标类型与绑定记录不一致；为避免恢复到另一个游戏，已停止操作",
        "The current game type does not match the binding record. Recovery was stopped to avoid changing another game.",
      ),
    );
  }
  if (details.targetType === "steam" && recordedLaunchField === "shortcut") {
    throw new Error(
      t(
        "Steam 游戏的绑定记录不能指向快捷方式启动项，已停止操作",
        "A Steam game binding cannot point to shortcut launch options. Recovery was stopped.",
      ),
    );
  }
  if (
    recordedTargetType === "shortcut" &&
    record.shortcut_exe?.trim() &&
    details.shortcutExe?.trim() !== record.shortcut_exe.trim()
  ) {
    throw new Error(
      t(
        "非 Steam 快捷方式的可执行文件已经变化；为避免恢复到另一个游戏，已停止操作",
        "The Non-Steam shortcut executable has changed. Recovery was stopped to avoid changing another game.",
      ),
    );
  }

  const managedExecutables = Array.from(
    new Set([
      record.managed_launch_executable,
      ...record.candidate_launch_executables,
    ].filter(Boolean)),
  );
  const fields: LaunchField[] = recordedLaunchField
    ? [recordedLaunchField]
    : details.targetType === "shortcut"
      ? ["shortcut", "app"]
      : ["app"];
  const evaluated = fields.flatMap((field) => {
    const current = launchOptionsForField(details, field);
    if (current === undefined) {
      return [];
    }
    const alreadyRestored = original !== null &&
      launchOptionsEqual(current, original);
    return [{
      field,
      current,
      alreadyRestored,
      recovery: alreadyRestored
        ? null
        : recoverTrainerLaunchOptions(
            current,
            managedExecutables,
            original,
            record.applied_launch_options,
          ),
    }];
  });
  const restorable = evaluated.filter((candidate) =>
    candidate.recovery?.changed
  );
  if (restorable.length > 1) {
    throw new Error(
      t(
        "普通启动项与快捷方式启动项都含有 TrainerDeck 参数，无法安全判断旧版写入位置",
        "Both regular and shortcut launch options contain TrainerDeck parameters, so the legacy write location cannot be determined safely.",
      ),
    );
  }
  const selected = restorable[0];
  if (selected?.recovery) {
    await writeLaunchOptionsSafely(
      {
        appId: details.appId,
        targetType: details.targetType,
        launchOptionsField: selected.field,
        launchOptions: selected.current,
      },
      selected.recovery.launchOptions,
      STEAM_READ_TIMEOUT_MS,
    );
  } else if (!evaluated.some((candidate) => candidate.alreadyRestored)) {
    throw new Error(
      t(
        "当前启动项已被用户或其他插件修改，无法安全确认 TrainerDeck 参数归属，因此没有覆盖",
        "The current launch options were changed by the user or another plugin. TrainerDeck could not verify parameter ownership and left them unchanged.",
      ),
    );
  }

  await withTimeout(
    unbindTrainer(record.app_id, true),
    BACKEND_TIMEOUT_MS,
    t(
      "启动项已恢复，但保存解除绑定状态超时",
      "Launch options were restored, but saving the unbound state timed out.",
    ),
  );
}

export function TrainerDeckRecoveryPage() {
  const [records, setRecords] = useState<TrainerBindingRecord[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<number | "all" | null>(null);
  const loadRequest = useRef(0);

  const load = useCallback(async () => {
    const request = loadRequest.current + 1;
    loadRequest.current = request;
    setStatus("loading");
    setMessage("");
    try {
      const loaded = await withTimeout(
        listBindings(),
        BACKEND_TIMEOUT_MS,
        t(
          "读取启动项恢复记录超时",
          "Reading launch option recovery records timed out.",
        ),
      );
      if (loadRequest.current !== request) {
        return;
      }
      setRecords(loaded);
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
    return () => {
      loadRequest.current += 1;
    };
  }, [load]);

  const pendingRecords = useMemo(
    () => records.filter((record) => !record.launch_options_restored),
    [records],
  );

  const restoreOne = useCallback(async (record: TrainerBindingRecord) => {
    if (busy !== null) {
      return;
    }
    setBusy(record.app_id);
    try {
      await restoreTrainerLaunchBinding(record);
      toaster.toast({
        title: t("启动项已恢复", "Launch options restored"),
        body: t(
          `${recordName(record)}：已保留修改器文件和其他启动参数`,
          `${recordName(record)}: trainer files and other launch parameters were preserved.`,
        ),
      });
      await load();
    } catch (error) {
      toaster.toast({
        title: t("恢复失败", "Recovery failed"),
        body: errorText(error),
      });
    } finally {
      setBusy(null);
    }
  }, [busy, load]);

  const restoreAll = useCallback(async () => {
    if (busy !== null || pendingRecords.length === 0) {
      return;
    }
    setBusy("all");
    const failed: string[] = [];
    let restored = 0;
    try {
      for (const record of pendingRecords) {
        try {
          await restoreTrainerLaunchBinding(record);
          restored += 1;
        } catch (error) {
          failed.push(t(
            `${recordName(record)}：${errorText(error)}`,
            `${recordName(record)}: ${errorText(error)}`,
          ));
        }
      }
      toaster.toast({
        title: failed.length
          ? t("启动项恢复部分完成", "Launch option recovery partially completed")
          : t("启动项恢复完成", "Launch option recovery completed"),
        body: failed.length
          ? t(
            `已恢复 ${restored} 个；${failed.join("；")}`,
            `${restored} restored; ${failed.join("; ")}`,
          )
          : t(
            `已恢复 ${restored} 个游戏，修改器文件仍保留`,
            `Restored ${restored} games. Trainer files were preserved.`,
          ),
        duration: 7000,
      });
      await load();
    } finally {
      setBusy(null);
    }
  }, [busy, load, pendingRecords]);

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
      <PanelSection title={t("游戏启动项恢复", "Launch Option Recovery")}>
        <PanelSectionRow>
          <div style={{ fontSize: "12px", lineHeight: 1.5 }}>
            {t(
              "游戏无需处于运行状态。Steam 游戏与非 Steam 快捷方式都会按各自的启动项类型恢复；可在这里移除 TrainerDeck 写入的启动参数并解除同步绑定。修改器文件不会删除，CheatDeck 和用户自己的其他启动参数会保留。",
              "The game does not need to be running. Steam games and Non-Steam shortcuts are restored using their respective launch option types. You can remove parameters written by TrainerDeck and disconnect synchronization here. Trainer files, CheatDeck parameters, and your other launch options are preserved.",
            )}
          </div>
        </PanelSectionRow>
        {status !== "ready" && (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              description={status === "loading"
                ? t("正在读取恢复记录", "Loading recovery records")
                : message}
              disabled={status === "loading"}
              onClick={() => void load()}
            >
              {status === "loading"
                ? t("正在读取…", "Loading…")
                : t("读取失败，点此重试", "Load failed. Select to retry")}
            </ButtonItem>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            description={t(
              `待恢复 ${pendingRecords.length} 个游戏`,
              `${pendingRecords.length} games waiting for recovery`,
            )}
            disabled={busy !== null || pendingRecords.length === 0}
            onClick={() => void restoreAll()}
          >
            {busy === "all"
              ? t("正在逐个恢复…", "Restoring one by one…")
              : t("一键恢复全部启动项", "Restore All Launch Options")}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t("游戏记录", "Game Records")}>
        {status === "ready" && records.length === 0 && (
          <PanelSectionRow>
            <div style={{ fontSize: "12px", opacity: 0.78 }}>
              {t(
                "当前没有 TrainerDeck 启动项记录。",
                "There are no TrainerDeck launch option records.",
              )}
            </div>
          </PanelSectionRow>
        )}
        {records.map((record) => (
          <PanelSectionRow key={record.app_id}>
            <ButtonItem
              layout="below"
              description={
                record.launch_options_restored
                  ? t(
                    `${recordTargetLabel(record)} · 已恢复，修改器文件仍保留`,
                    `${recordTargetLabel(record)} · Restored; trainer files preserved`,
                  )
                  : record.original_launch_options === null
                    ? t(
                      `${recordTargetLabel(record)} · 旧版本未保存原值，将只移除可确认属于 TrainerDeck 的参数`,
                      `${recordTargetLabel(record)} · The old version did not save the original value; only verified TrainerDeck parameters will be removed`,
                    )
                    : t(
                      `${recordTargetLabel(record)} · 将恢复启用同步前的原始启动项`,
                      `${recordTargetLabel(record)} · Restore the original launch options from before synchronization`,
                    )
              }
              disabled={busy !== null || record.launch_options_restored}
              onClick={() => void restoreOne(record)}
            >
              {busy === record.app_id
                ? t(
                  `正在恢复 ${recordName(record)}…`,
                  `Restoring ${recordName(record)}…`,
                )
                : record.launch_options_restored
                  ? t(
                    `${recordName(record)} · 已恢复`,
                    `${recordName(record)} · Restored`,
                  )
                  : t(
                    `恢复 ${recordName(record)}`,
                    `Restore ${recordName(record)}`,
                  )}
            </ButtonItem>
          </PanelSectionRow>
        ))}
      </PanelSection>
    </div>
  );
}
