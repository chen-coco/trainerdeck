import { toaster } from "@decky/api";
import {
  ButtonItem,
  DialogButton,
  Focusable,
  PanelSection,
  PanelSectionRow,
  TextField,
} from "@decky/ui";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { withTimeout } from "./async";
import { deleteInstallation, listBindings, listInstalled } from "./backend";
import { t } from "./i18n";
import {
  installationBindingState,
  installationKey,
  installationMatchesQuery,
  installationReferences,
} from "./library-state";
import type { InstalledTrainer, SteamTarget, TrainerBindingRecord } from "./types";

const READ_TIMEOUT_MS = 8000;
export const LIBRARY_ROUTE = "/trainerdeck/library";

export interface TrainerLibraryProps {
  target: SteamTarget | null;
  backendReady: boolean;
  busy: boolean;
  refreshKey: number;
  onBind: (installation: InstalledTrainer) => Promise<boolean>;
  onOperationChange?: (busy: boolean) => void;
  alwaysExpanded?: boolean;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

function targetKey(target: SteamTarget | null): string {
  return JSON.stringify(target && [
    target.appId, target.targetType, target.launchOptionsField, target.shortcutExe,
  ]);
}

async function readLibrary(): Promise<{
  installations: InstalledTrainer[];
  bindings: TrainerBindingRecord[];
}> {
  const [installations, bindings] = await withTimeout(
    Promise.all([listInstalled(), listBindings()]),
    READ_TIMEOUT_MS,
    t("读取修改器库超时，请重试。", "Loading the trainer library timed out. Please retry."),
  );
  return { installations, bindings };
}

export function TrainerLibrary(props: TrainerLibraryProps) {
  const { target, backendReady, busy, refreshKey } = props;
  const [expanded, setExpanded] = useState(props.alwaysExpanded === true);
  const [query, setQuery] = useState("");
  const [details, setDetails] = useState<string | null>(null);
  const [installations, setInstallations] = useState<InstalledTrainer[]>([]);
  const [bindings, setBindings] = useState<TrainerBindingRecord[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadError, setLoadError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [operation, setOperation] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const mounted = useRef(false);
  const request = useRef(0);
  const operationLock = useRef(false);
  const pendingDelete = useRef<string | null>(null);
  const latest = useRef({ ...props, expanded, status, bindings });
  latest.current = { ...props, expanded, status, bindings };

  const reportDeleteError = useCallback((message: string) => {
    if (mounted.current) setActionMessage(message);
    toaster.toast({ title: t("暂时无法删除", "Could not delete trainer"), body: message, duration: 7000 });
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
      pendingDelete.current = null;
    };
  }, []);

  const load = useCallback(async () => {
    const currentRequest = ++request.current;
    if (!mounted.current || !latest.current.backendReady || !latest.current.expanded) {
      return;
    }
    setStatus("loading");
    setLoadError("");
    try {
      const loaded = await readLibrary();
      if (!mounted.current || currentRequest !== request.current) return;
      setInstallations(loaded.installations);
      setBindings(loaded.bindings);
      setStatus("ready");
    } catch (error) {
      if (!mounted.current || currentRequest !== request.current) return;
      // Do not treat a failed binding read as an empty binding list.
      setStatus("error");
      setLoadError(errorText(error));
    }
  }, []);

  useEffect(() => {
    if (expanded && backendReady) {
      void load();
    } else {
      request.current += 1;
      setStatus("idle");
    }
    return () => { request.current += 1; };
  }, [expanded, backendReady, refreshKey, target?.appId, load]);

  const beginOperation = useCallback((key: string): boolean => {
    if (!mounted.current || operationLock.current) return false;
    if (!latest.current.backendReady || latest.current.busy || latest.current.status !== "ready") {
      setActionMessage(t(
        "请等待当前操作完成，并刷新修改器库后重试。",
        "Wait for the current operation to finish, then refresh the library and retry.",
      ));
      return false;
    }
    operationLock.current = true;
    request.current += 1;
    setOperation(key);
    setActionMessage("");
    latest.current.onOperationChange?.(true);
    return true;
  }, []);

  const finishOperation = useCallback(() => {
    operationLock.current = false;
    latest.current.onOperationChange?.(false);
    if (mounted.current) setOperation(null);
  }, []);

  const bind = useCallback(async (installation: InstalledTrainer) => {
    const selectedTargetKey = targetKey(latest.current.target);
    if (!beginOperation(`bind:${installationKey(installation)}`)) return;
    try {
      const loaded = await readLibrary();
      if (!mounted.current) return;
      if (selectedTargetKey !== targetKey(latest.current.target)) {
        throw new Error(t("当前游戏已切换，请重新选择绑定。", "The current game changed. Select the binding again."));
      }
      if (installationBindingState(installation, loaded.bindings, latest.current.target) !== "available") {
        throw new Error(t(
          "绑定状态已变化；请先解除原绑定，或确认当前运行的游戏。",
          "The binding state changed. Remove the existing binding or check the running game first.",
        ));
      }
      const current = loaded.installations.find((item) => installationKey(item) === installationKey(installation));
      if (!current) throw new Error(t("此修改器已不在库中，请刷新后重试。", "This trainer is no longer in the library. Refresh and retry."));
      if (!latest.current.backendReady || latest.current.busy) {
        throw new Error(t("当前无法绑定，请稍后重试。", "Binding is unavailable. Please retry shortly."));
      }
      const bound = await latest.current.onBind(current);
      if (bound && mounted.current) {
        setActionMessage(t("已复用本地文件完成绑定。", "Bound using the existing local files."));
      }
    } catch (error) {
      if (mounted.current) setActionMessage(errorText(error));
    } finally {
      await load();
      finishOperation();
    }
  }, [beginOperation, finishOperation, load]);

  const remove = useCallback(async (installation: InstalledTrainer) => {
    if (pendingDelete.current !== installationKey(installation)) return;
    if (!beginOperation(`delete:${installationKey(installation)}`)) {
      if (mounted.current && !operationLock.current) reportDeleteError(t(
        "确认期间修改器库状态已变化，请刷新后重试。",
        "The library state changed while confirmation was open. Refresh and retry.",
      ));
      return;
    }
    // Confirmation starts the transaction before any async work. Navigating
    // away may stop UI updates, but must not silently cancel an accepted delete.
    pendingDelete.current = null;
    setConfirmation(null);
    try {
      const loaded = await readLibrary();
      if (installationReferences(installation, loaded.bindings).length > 0) {
        throw new Error(t(
          "此修改器仍被游戏启动项引用，请先在“游戏启动项恢复”中解除绑定。",
          "Game launch options still refer to this trainer. Unbind it in Launch Option Recovery first.",
        ));
      }
      if (!latest.current.backendReady || latest.current.busy) {
        throw new Error(t("当前无法删除，请稍后重试。", "Deletion is unavailable. Please retry shortly."));
      }
      // Do not time out a filesystem mutation and unlock other operations while
      // the backend could still be deleting the directory.
      const deleted = await deleteInstallation(installation.id, installation.folder);
      if (!deleted) throw new Error(t("未能删除修改器，请刷新后重试。", "The trainer was not deleted. Refresh and retry."));
      if (mounted.current) {
        setActionMessage(t("已删除本地修改器文件。", "Local trainer files deleted."));
        setDetails((current) => current === installationKey(installation) ? null : current);
      }
      toaster.toast({ title: t("删除完成", "Trainer deleted"), body: installation.title || installation.game_name });
    } catch (error) {
      reportDeleteError(errorText(error));
    } finally {
      await load();
      finishOperation();
    }
  }, [beginOperation, finishOperation, load, reportDeleteError]);

  const confirmRemove = useCallback((installation: InstalledTrainer) => {
    if (operationLock.current || !mounted.current) return;
    if (!latest.current.backendReady || latest.current.status !== "ready" || latest.current.busy) {
      reportDeleteError(t(
        "修改器库尚未就绪或有操作正在进行，请等待完成后刷新重试。",
        "The library is not ready or another operation is in progress. Wait, then refresh and retry.",
      ));
      return;
    }
    const protectedBindings = installationReferences(installation, latest.current.bindings);
    if (protectedBindings.length > 0) {
      const names = protectedBindings.map((record) => record.display_name || record.title).filter(Boolean).join("、");
      setDetails(installationKey(installation));
      reportDeleteError(t(
        `此修改器仍被${names ? `“${names}”` : "游戏"}的启动项引用。请先退出游戏，并在下方“管理与恢复启动项”中解除绑定，再返回删除。`,
        `Launch options${names ? ` for ${names}` : ""} still refer to this trainer. Exit the game and unbind it using Manage and Restore Launch Options below, then return to delete it.`,
      ));
      return;
    }
    pendingDelete.current = installationKey(installation);
    setConfirmation(pendingDelete.current);
    setActionMessage("");
  }, [reportDeleteError]);

  const cancelDelete = useCallback(() => {
    pendingDelete.current = null;
    setConfirmation(null);
  }, []);

  const unavailable = !backendReady || busy || operation !== null || status !== "ready";
  const visible = installations.filter((installation) => installationMatchesQuery(installation, bindings, query));

  return (
    <PanelSection title={t("我的修改器库", "My Trainer Library")}>
      {!props.alwaysExpanded && <PanelSectionRow>
        <ButtonItem
          layout="below"
          description={t("复用已下载文件、查看绑定和清理旧版。", "Reuse downloads, check bindings, and remove old versions.")}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("收起修改器库", "Collapse Library") : t("展开修改器库", "Open Library")}
        </ButtonItem>
      </PanelSectionRow>}
      {expanded && (
        <>
          <PanelSectionRow>
            <TextField
              label={t("筛选本地修改器", "Filter local trainers")}
              description={t("名称、版本或绑定游戏", "Name, version, or bound game")}
              value={query}
              bShowClearAction
              onChange={(event) => setQuery(event.target.value)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={!backendReady || busy || operation !== null || status === "loading"}
              description={!backendReady
                ? t("插件后端不可用，请先恢复后端连接。", "The plugin backend is unavailable. Restore its connection first.")
                : status === "error" ? loadError
                : status === "ready" ? t(`共 ${installations.length} 个，显示 ${visible.length} 个`, `${installations.length} total, ${visible.length} shown`)
                : t("正在读取本地文件和绑定记录。", "Reading local files and binding records.")}
              onClick={() => void load()}
            >
              {status === "loading" ? t("正在读取…", "Loading…")
                : status === "error" ? t("读取失败，重试", "Load failed. Retry")
                : t("刷新修改器库", "Refresh Library")}
            </ButtonItem>
          </PanelSectionRow>
          {actionMessage && <PanelSectionRow><div role="status" style={{ fontSize: "12px", lineHeight: 1.5 }}>{actionMessage}</div></PanelSectionRow>}
          {status === "ready" && installations.length === 0 && (
            <PanelSectionRow><div style={{ fontSize: "12px", opacity: 0.78 }}>{t("还没有下载的修改器。先搜索并下载，之后可在这里复用。", "No trainers downloaded yet. Search and download a trainer to reuse it here.")}</div></PanelSectionRow>
          )}
          {status === "ready" && installations.length > 0 && visible.length === 0 && (
            <PanelSectionRow><div style={{ fontSize: "12px", opacity: 0.78 }}>{t("没有匹配的本地修改器，请更换或清空筛选词。", "No local trainers match. Change or clear the filter.")}</div></PanelSectionRow>
          )}
          {status === "ready" && visible.map((installation) => {
            const key = installationKey(installation);
            const protectedBindings = installationReferences(installation, bindings);
            const bindingState = installationBindingState(installation, bindings, target);
            const boundNames = protectedBindings.map((record) => record.display_name || record.title || String(record.app_id)).join("、");
            return (
              <Fragment key={key}>
                <PanelSectionRow>
                  <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{installation.title || installation.game_name}</div>
                  <div style={{ fontSize: "12px", lineHeight: 1.5, opacity: 0.78 }}>
                    {installation.provider} · {installation.version || t("版本未知", "Unknown version")}
                    <div>{protectedBindings.length > 0 ? t(`启动项关联：${boundNames}`, `Launch option references: ${boundNames}`) : t("尚未绑定游戏", "Not bound to a game")}</div>
                  </div>
                  <ButtonItem
                    layout="below"
                    disabled={unavailable || bindingState !== "available"}
                    description={bindingState === "bound-elsewhere"
                      ? t("请先在“游戏启动项恢复”中解除原绑定。", "Remove the previous binding in Launch Option Recovery first.")
                      : bindingState === "no-target" ? t("先启动要绑定的游戏，再打开修改器库。", "Start the game you want to bind, then open the library.")
                      : bindingState === "available" ? t(`将绑定到 ${target?.name}；请确认修改器版本与游戏匹配。`, `Bind to ${target?.name}; check that the trainer version matches your game.`)
                      : t("此本地修改器已被当前游戏启动项引用。", "The current game's launch options already refer to this trainer.")}
                    onClick={() => void bind(installation)}
                  >
                    {operation === `bind:${key}` ? t("正在绑定…", "Binding…")
                      : bindingState === "bound-here" ? t("已绑定当前游戏", "Bound to Current Game")
                      : bindingState === "bound-elsewhere" ? t("已绑定其他目标", "Bound to Another Target")
                      : t("绑定当前游戏", "Bind to Current Game")}
                  </ButtonItem>
                  <Focusable style={{ display: "flex", gap: "8px", marginTop: "8px", marginBottom: "10px" }}>
                    <DialogButton style={{ minWidth: 0, flex: 1 }} onClick={() => setDetails((current) => current === key ? null : key)}>
                      {details === key ? t("收起详情", "Hide Details") : t("文件详情", "File Details")}
                    </DialogButton>
                    <DialogButton style={{ minWidth: 0, flex: 1 }} disabled={operation !== null} onClick={() => confirmRemove(installation)}>
                      {operation === `delete:${key}` ? t("正在删除…", "Deleting…") : t("删除文件", "Delete Files")}
                    </DialogButton>
                  </Focusable>
                  {confirmation === key && (
                    <div role="group" aria-label={t("确认删除本地修改器", "Confirm local trainer deletion")} style={{ border: "1px solid #d9a34b", borderRadius: "4px", padding: "10px", marginBottom: "10px", fontSize: "12px", lineHeight: 1.5, overflowWrap: "anywhere" }}>
                      <div style={{ fontWeight: 600 }}>{t("删除本地修改器？", "Delete local trainer?")}</div>
                      <div>{installation.title || installation.game_name} · {installation.version || t("版本未知", "Unknown version")}</div>
                      <div>{installation.folder}</div>
                      <p>{t(
                        "将永久删除此目录中的修改器及相关本地文件，无法撤销。之后可重新下载。",
                        "This permanently deletes the trainer and related local files in this folder. This cannot be undone. You can download it again later.",
                      )}</p>
                      <Focusable style={{ display: "flex", gap: "8px" }}>
                        <DialogButton style={{ minWidth: 0, flex: 1 }} disabled={operation !== null} onClick={() => void remove(installation)}>
                          {t("永久删除", "Delete permanently")}
                        </DialogButton>
                        <DialogButton style={{ minWidth: 0, flex: 1 }} disabled={operation !== null} onClick={cancelDelete}>
                          {t("取消", "Cancel")}
                        </DialogButton>
                      </Focusable>
                    </div>
                  )}
                  {protectedBindings.length > 0 && (
                    <div style={{ fontSize: "12px", lineHeight: 1.5, marginBottom: "10px" }}>
                      {t("仍有游戏启动项引用；需先退出游戏并解除绑定，再删除文件。", "Game launch options still use these files. Exit the game and unbind before deleting.")}
                    </div>
                  )}
                  {details === key && (
                    <div style={{ fontSize: "12px", lineHeight: 1.5, overflowWrap: "anywhere", marginBottom: "10px", opacity: 0.78 }}>
                      <div>{t("目录：", "Folder: ")}{installation.folder}</div>
                      <div>{t("程序：", "Executable: ")}{installation.executable}</div>
                      {installation.installed_at && <div>{t("下载时间：", "Downloaded: ")}{installation.installed_at}</div>}
                      {protectedBindings.length > 0 && <div>{t("解除绑定并恢复启动项后，才能删除文件。", "Unbind and restore launch options before deleting these files.")}</div>}
                    </div>
                  )}
                </PanelSectionRow>
              </Fragment>
            );
          })}
        </>
      )}
    </PanelSection>
  );
}
