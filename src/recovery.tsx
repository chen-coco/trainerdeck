import { toaster } from "@decky/api";
import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { withTimeout } from "./async";
import { listBindings, unbindTrainer } from "./backend";
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
  return record.display_name || record.title || "未知游戏";
}

function recordTargetLabel(record: TrainerBindingRecord): string {
  return record.target_type === "shortcut"
    ? "非 Steam 快捷方式"
    : record.target_type === "steam"
      ? "Steam 游戏"
      : "游戏";
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
      "当前游戏的目标类型与绑定记录不一致；为避免恢复到另一个游戏，已停止操作",
    );
  }
  if (details.targetType === "steam" && recordedLaunchField === "shortcut") {
    throw new Error(
      "Steam 游戏的绑定记录不能指向快捷方式启动项，已停止操作",
    );
  }
  if (
    recordedTargetType === "shortcut" &&
    record.shortcut_exe?.trim() &&
    details.shortcutExe?.trim() !== record.shortcut_exe.trim()
  ) {
    throw new Error(
      "非 Steam 快捷方式的可执行文件已经变化；为避免恢复到另一个游戏，已停止操作",
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
      "普通启动项与快捷方式启动项都含有 TrainerDeck 参数，无法安全判断旧版写入位置",
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
      "当前启动项已被用户或其他插件修改，无法安全确认 TrainerDeck 参数归属，因此没有覆盖",
    );
  }

  await withTimeout(
    unbindTrainer(record.app_id, true),
    BACKEND_TIMEOUT_MS,
    "启动项已恢复，但保存解除绑定状态超时",
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
        "读取启动项恢复记录超时",
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
        title: "启动项已恢复",
        body: `${recordName(record)}：已保留修改器文件和其他启动参数`,
      });
      await load();
    } catch (error) {
      toaster.toast({ title: "恢复失败", body: errorText(error) });
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
          failed.push(`${recordName(record)}：${errorText(error)}`);
        }
      }
      toaster.toast({
        title: failed.length ? "启动项恢复部分完成" : "启动项恢复完成",
        body: failed.length
          ? `已恢复 ${restored} 个；${failed.join("；")}`
          : `已恢复 ${restored} 个游戏，修改器文件仍保留`,
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
      <PanelSection title="游戏启动项恢复">
        <PanelSectionRow>
          <div style={{ fontSize: "12px", lineHeight: 1.5 }}>
            游戏无需处于运行状态。Steam 游戏与非 Steam 快捷方式都会按各自的启动项类型恢复；可在这里移除 TrainerDeck 写入的启动参数并解除同步绑定。
            修改器文件不会删除，CheatDeck 和用户自己的其他启动参数会保留。
          </div>
        </PanelSectionRow>
        {status !== "ready" && (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              description={status === "loading" ? "正在读取恢复记录" : message}
              disabled={status === "loading"}
              onClick={() => void load()}
            >
              {status === "loading" ? "正在读取…" : "读取失败，点此重试"}
            </ButtonItem>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            description={`待恢复 ${pendingRecords.length} 个游戏`}
            disabled={busy !== null || pendingRecords.length === 0}
            onClick={() => void restoreAll()}
          >
            {busy === "all" ? "正在逐个恢复…" : "一键恢复全部启动项"}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="游戏记录">
        {status === "ready" && records.length === 0 && (
          <PanelSectionRow>
            <div style={{ fontSize: "12px", opacity: 0.78 }}>
              当前没有 TrainerDeck 启动项记录。
            </div>
          </PanelSectionRow>
        )}
        {records.map((record) => (
          <PanelSectionRow key={record.app_id}>
            <ButtonItem
              layout="below"
              description={
                record.launch_options_restored
                  ? `${recordTargetLabel(record)} · 已恢复，修改器文件仍保留`
                  : record.original_launch_options === null
                    ? `${recordTargetLabel(record)} · 旧版本未保存原值，将只移除可确认属于 TrainerDeck 的参数`
                    : `${recordTargetLabel(record)} · 将恢复启用同步前的原始启动项`
              }
              disabled={busy !== null || record.launch_options_restored}
              onClick={() => void restoreOne(record)}
            >
              {busy === record.app_id
                ? `正在恢复 ${recordName(record)}…`
                : record.launch_options_restored
                  ? `${recordName(record)} · 已恢复`
                  : `恢复 ${recordName(record)}`}
            </ButtonItem>
          </PanelSectionRow>
        ))}
      </PanelSection>
    </div>
  );
}
