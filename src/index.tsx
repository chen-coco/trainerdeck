import {
  addEventListener,
  definePlugin,
  removeEventListener,
  routerHook,
  toaster,
} from "@decky/api";
import {
  ButtonItem,
  DialogButton,
  Focusable,
  Navigation,
  PanelSection,
  PanelSectionRow,
  staticClasses,
  TextField,
  ToggleField,
} from "@decky/ui";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { FaBolt, FaExclamationCircle } from "react-icons/fa";

import { withTimeout } from "./async";
import { decideAutomaticAdd } from "./automatic-add";
import {
  bindTrainer,
  downloadTrainer,
  getBinding,
  getBackendStatus,
  getSettings,
  getTrainerRuntime,
  invokeTrainerOption,
  prepareTrainerBridge,
  setTrainerOption,
  setTrainerOptionValue,
} from "./backend";
import { searchFlingTrainersMany } from "./fling";
import { qamInputRecoveryController } from "./input-recovery";
import {
  cancelInputRecoverySession,
  registerInputRecoveryUi,
  requestInputRecoveryTransition,
  unregisterInputRecoveryUi,
} from "./input-recovery-route";
import {
  buildTrainerLaunchOptions,
  currentRunningAppId,
  hasCheatDeckLaunchConfiguration,
  readAppDetails,
  readAppSummary,
  recoverTrainerLaunchOptions,
  resolveManualSteamSearchPlan,
  writeLaunchOptionsSafely,
} from "./steam";
import {
  DEFAULT_SETTINGS,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_ROUTE,
  TrainerDeckSettingsPage,
} from "./settings";
import {
  RECOVERY_ROUTE,
  restoreTrainerLaunchBinding,
  TrainerDeckRecoveryPage,
} from "./recovery";
import type {
  InstalledTrainer,
  BackendStatus,
  LocalizedTrainerText,
  SteamTarget,
  TrainerDeckSettings,
  TrainerEntry,
  TrainerRuntimeOption,
  TrainerRuntimeSnapshot,
} from "./types";

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function notify(title: string, body: string): void {
  toaster.toast({ title, body, duration: 5000 });
}

function SmallNote({ children }: { children: string }) {
  return (
    <div style={{ fontSize: "12px", lineHeight: 1.35, opacity: 0.78 }}>
      {children}
    </div>
  );
}

function launchOptionsBeforeBinding(
  details: SteamTarget,
  binding: InstalledTrainer | null,
): string {
  if (!binding) {
    return details.launchOptions;
  }
  const recordedTargetType = binding.target_type === "steam" ||
      binding.target_type === "shortcut"
    ? binding.target_type
    : null;
  if (recordedTargetType && recordedTargetType !== details.targetType) {
    throw new Error(
      "当前 AppID 的目标类型与已有绑定不一致；请先恢复并解除旧绑定",
    );
  }
  if (
    recordedTargetType === "shortcut" &&
    binding.shortcut_exe?.trim() &&
    binding.shortcut_exe.trim() !== details.shortcutExe?.trim()
  ) {
    throw new Error(
      "非 Steam 快捷方式的可执行文件已变化；请先恢复并解除旧绑定",
    );
  }
  const managedExecutables = [
    binding.managed_launch_executable || "",
    ...(binding.candidate_launch_executables || []),
  ];
  const recover = (launchOptions: string) =>
    recoverTrainerLaunchOptions(
      launchOptions,
      managedExecutables,
      binding.original_launch_options,
      binding.applied_launch_options || "",
    );
  const recordedField = binding.launch_options_field === "app" ||
      binding.launch_options_field === "shortcut"
    ? binding.launch_options_field
    : null;

  if (recordedField) {
    const recordedOptions = recordedField === "app"
      ? details.appLaunchOptions
      : details.shortcutLaunchOptions;
    if (recordedOptions === undefined) {
      throw new Error(
        "Steam 没有返回旧绑定使用的启动项字段；为避免覆盖原设置，请先使用“一键恢复启动项”处理旧绑定",
      );
    }
    const recovered = recover(recordedOptions);
    if (recordedField !== details.launchOptionsField && recovered.changed) {
      throw new Error(
        "检测到旧绑定使用另一种启动项字段；请先使用“一键恢复启动项”清理旧绑定，再重新添加修改器",
      );
    }
    return recordedField === details.launchOptionsField
      ? recovered.launchOptions
      : details.launchOptions;
  }

  if (details.targetType === "shortcut") {
    const appRecovery = recover(details.appLaunchOptions);
    const shortcutRecovery = details.shortcutLaunchOptions === undefined
      ? null
      : recover(details.shortcutLaunchOptions);
    const appOwned = appRecovery.changed;
    const shortcutOwned = Boolean(shortcutRecovery?.changed);
    if (appOwned && shortcutOwned) {
      throw new Error(
        "普通启动项和快捷方式启动项中都检测到旧绑定；请先使用“一键恢复启动项”逐项确认并清理",
      );
    }
    const ownedField = appOwned ? "app" : shortcutOwned ? "shortcut" : null;
    if (ownedField && ownedField !== details.launchOptionsField) {
      throw new Error(
        "检测到旧版绑定使用另一种启动项字段；请先使用“一键恢复启动项”清理旧绑定，再重新添加修改器",
      );
    }
    if (details.launchOptionsField === "app") {
      return appRecovery.launchOptions;
    }
    return shortcutRecovery?.launchOptions ?? details.launchOptions;
  }

  return recover(details.appLaunchOptions).launchOptions;
}

function localizedText(value: LocalizedTrainerText): string {
  const language = navigator.language.toLowerCase();
  if (language.startsWith("zh-tw") || language.startsWith("zh-hk")) {
    return value.zh_tw || value.zh_cn || value.en || "";
  }
  if (language.startsWith("zh")) {
    return value.zh_cn || value.zh_tw || value.en || "";
  }
  return value.en || value.zh_cn || value.zh_tw || "";
}

const REQUIRED_RUNTIME_CAPABILITIES = [
  "action_command_v1",
  "value_command_v1",
  "value_command_receipt_v1",
  "trainer_window_visible_v1",
  "auto_return_confirmation_v1",
  "localized_widget_fallback_v1",
  "nonblocking_ui_commands_v1",
  "independent_heartbeat_v1",
] as const;

function RuntimeOptionRow({
  option,
  disabled,
  connected,
  gameAvailable,
  onToggle,
  onValue,
  onAction,
}: {
  option: TrainerRuntimeOption;
  disabled: boolean;
  connected: boolean;
  gameAvailable: boolean;
  onToggle: (desired: boolean) => void;
  onValue: (value: string) => void;
  onAction: () => void;
}) {
  const [draft, setDraft] = useState(option.value ?? "");
  const [dirty, setDirty] = useState(false);
  const [focused, setFocused] = useState(false);
  const [gamepadFocused, setGamepadFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [tooltipPinned, setTooltipPinned] = useState(false);
  const [validationError, setValidationError] = useState("");
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const label = localizedText(option.labels) || option.id;
  const tooltip = localizedText(option.tooltips);
  const hasToggle = option.controllable && option.active !== null;
  const hasValue = option.value_controllable;
  const hasAction = option.action_controllable && !hasToggle && !hasValue;
  const valueIsNumeric = option.value_type !== "text";
  const rowDisabled =
    disabled ||
    option.pending ||
    option.value_pending ||
    option.action_pending ||
    !gameAvailable;
  const tooltipVisible =
    Boolean(tooltip) &&
    (focused || gamepadFocused || hovered || tooltipPinned);
  const tooltipColor =
    option.tooltip_style === "important" ? "#ff6b73" : "#66c0f4";

  useEffect(() => {
    if (option.value_pending) {
      return;
    }
    if (!dirty || draft === (option.value ?? "")) {
      setDraft(option.value ?? "");
      setDirty(false);
      setValidationError("");
    }
  }, [dirty, draft, option.value, option.value_pending]);

  useEffect(() => {
    if ((!focused && !gamepadFocused) || !tooltip) {
      return;
    }
    const timer = window.setTimeout(() => {
      tooltipRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focused, gamepadFocused, tooltip]);

  const validateValue = (): string => {
    const value = draft.trim();
    if (!value) {
      return "请输入数值";
    }
    if (value.length > 200) {
      return "输入内容过长";
    }
    if (!valueIsNumeric) {
      return "";
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return "请输入有效数字";
    }
    if (option.value_type === "integer" && !Number.isInteger(numeric)) {
      return "该项目只接受整数";
    }
    if (option.minimum !== undefined && numeric < option.minimum) {
      return `不能小于 ${option.minimum}`;
    }
    if (option.maximum !== undefined && numeric > option.maximum) {
      return `不能大于 ${option.maximum}`;
    }
    return "";
  };

  const submitValue = () => {
    const error = validateValue();
    setValidationError(error);
    if (!error) {
      onValue(draft.trim());
    }
  };

  const labelNode = (
    <span style={{ alignItems: "center", display: "inline-flex", gap: "7px" }}>
      <span>{label}</span>
      {tooltip && (
        <FaExclamationCircle
          aria-label="此修改项有说明"
          color={tooltipColor}
          title={tooltip}
        />
      )}
    </span>
  );
  const rangeDescription = [
    option.minimum !== undefined ? `最小 ${option.minimum}` : "",
    option.maximum !== undefined ? `最大 ${option.maximum}` : "",
    option.step !== undefined ? `步长 ${option.step}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const description =
    validationError ||
    option.action_error ||
    option.value_error ||
    option.error ||
    (option.action_pending
      ? "正在执行修改器动作…"
      : option.value_pending
      ? `正在写入数值 ${option.desired_value ?? draft}…`
      : option.pending
      ? `等待修改器核心确认${option.desired ? "开启" : "关闭"}…`
      : !connected
        ? "bridge 连接已断开，状态暂不可用"
      : !gameAvailable
        ? "游戏尚未被修改器检测到"
        : option.value !== undefined && !hasValue
          ? `当前值：${option.value}（当前 bridge 只读）`
        : option.active === null && !hasValue
          ? "当前状态不可用"
          : "");

  return (
    <Focusable
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.contains(next)) {
          setFocused(false);
        }
      }}
      onGamepadFocus={() => setGamepadFocused(true)}
      onGamepadBlur={() => setGamepadFocused(false)}
      onActivate={
        rowDisabled && tooltip
          ? () => setTooltipPinned((current) => !current)
          : undefined
      }
      onOKActionDescription={rowDisabled && tooltip ? "查看说明" : undefined}
      aria-label={rowDisabled && tooltip ? `${label}：查看说明` : undefined}
      role={rowDisabled && tooltip ? "button" : undefined}
      tabIndex={rowDisabled && tooltip ? 0 : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ width: "100%" }}
    >
      {hasToggle && (
        <ToggleField
          label={labelNode}
          description={description || undefined}
          checked={option.active as boolean}
          disabled={rowDisabled}
          tooltip={tooltip || undefined}
          onChange={onToggle}
        />
      )}

      {hasValue && (
        <div style={{ marginTop: hasToggle ? "6px" : 0 }}>
          {!hasToggle && (
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "6px" }}>
              {labelNode}
            </div>
          )}
          <div
            style={{
              alignItems: "end",
              display: "grid",
              gap: "7px",
              gridTemplateColumns: "minmax(0, 1fr) auto",
            }}
          >
            <TextField
              label={hasToggle ? "数值" : undefined}
              description={rangeDescription || undefined}
              value={draft}
              mustBeNumeric={valueIsNumeric}
              rangeMin={option.minimum}
              rangeMax={option.maximum}
              disabled={rowDisabled}
              inputMode={valueIsNumeric ? "decimal" : "text"}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setDirty(true);
                setValidationError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitValue();
                }
              }}
            />
            <DialogButton
              disabled={
                rowDisabled ||
                (!dirty && option.value_apply_mode !== "invoke")
              }
              onClick={submitValue}
              style={{ minWidth: "68px" }}
            >
              {option.value_apply_mode === "invoke" ? "执行" : "应用"}
            </DialogButton>
          </div>
          {!description && option.value_apply_mode === "stage_then_toggle" && (
            <SmallNote>
              {option.active === true
                ? "应用时会自动关闭并重新开启此功能，使新数值由修改器核心重新载入。"
                : "应用时会写入新数值并同时开启此功能。"}
            </SmallNote>
          )}
          {description && <SmallNote>{description}</SmallNote>}
        </div>
      )}

      {hasAction && (
        <div
          style={{
            alignItems: "center",
            display: "grid",
            gap: "10px",
            gridTemplateColumns: "minmax(0, 1fr) auto",
          }}
        >
          <div>
            <div style={{ fontSize: "14px", fontWeight: 600 }}>{labelNode}</div>
            <SmallNote>
              {description || "这是一次性动作；按下“应用”后会直接调用修改器原功能。"}
            </SmallNote>
          </div>
          <DialogButton
            disabled={rowDisabled}
            onClick={onAction}
            style={{ minWidth: "76px" }}
          >
            {option.action_pending ? "应用中…" : "应用"}
          </DialogButton>
        </div>
      )}

      {!hasToggle && !hasValue && !hasAction && (
        <ButtonItem
          layout="below"
          highlightOnFocus
          description={
            description ||
            (option.kind === "action"
              ? "该数值/动作项目尚未开放直接写入"
              : "该项目不支持直接同步")
          }
          tooltip={tooltip || undefined}
        >
          {labelNode}
        </ButtonItem>
      )}

      {tooltipVisible && (
        <div
          ref={tooltipRef}
          role="note"
          aria-live="polite"
          style={{
            background: `${tooltipColor}18`,
            borderLeft: `3px solid ${tooltipColor}`,
            borderRadius: "4px",
            color: "#f2f2f2",
            fontSize: "12px",
            lineHeight: 1.45,
            marginTop: "7px",
            padding: "8px 10px",
            whiteSpace: "pre-wrap",
          }}
        >
          {tooltip}
        </div>
      )}
    </Focusable>
  );
}

interface InstallAndBindOptions {
  allowExplicitTargetSelection?: boolean;
  automatic?: boolean;
  automaticOperationKey?: string;
  shouldContinue?: () => boolean;
}

interface SharedInstallLock {
  startedAt: number;
  token: string;
}

type TrainerDeckGlobal = typeof globalThis & {
  __trainerDeckAutomaticDownloadHandledV1?: Record<string, number>;
  __trainerDeckInstallLockV1?: SharedInstallLock;
};

const AUTOMATIC_DOWNLOAD_HANDLED_MS = 30 * 60 * 1000;

function sharedInstallLock(): SharedInstallLock | null {
  return (globalThis as TrainerDeckGlobal).__trainerDeckInstallLockV1 ?? null;
}

function acquireSharedInstallLock(token: string): boolean {
  const shared = globalThis as TrainerDeckGlobal;
  if (shared.__trainerDeckInstallLockV1) {
    return false;
  }
  shared.__trainerDeckInstallLockV1 = { startedAt: Date.now(), token };
  return true;
}

function releaseSharedInstallLock(token: string): void {
  const shared = globalThis as TrainerDeckGlobal;
  if (shared.__trainerDeckInstallLockV1?.token === token) {
    delete shared.__trainerDeckInstallLockV1;
  }
}

function automaticDownloadWasHandled(key: string): boolean {
  const shared = globalThis as TrainerDeckGlobal;
  const handledAt = shared.__trainerDeckAutomaticDownloadHandledV1?.[key] ?? 0;
  if (handledAt > 0 && Date.now() - handledAt < AUTOMATIC_DOWNLOAD_HANDLED_MS) {
    return true;
  }
  if (handledAt > 0 && shared.__trainerDeckAutomaticDownloadHandledV1) {
    delete shared.__trainerDeckAutomaticDownloadHandledV1[key];
  }
  return false;
}

function markAutomaticDownloadHandled(key: string): void {
  const shared = globalThis as TrainerDeckGlobal;
  const handled = shared.__trainerDeckAutomaticDownloadHandledV1 ?? {};
  handled[key] = Date.now();
  shared.__trainerDeckAutomaticDownloadHandledV1 = handled;
}

function Content() {
  const initialRunningAppId = useRef(currentRunningAppId()).current;
  const [settings, setSettings] =
    useState<TrainerDeckSettings>(DEFAULT_SETTINGS);
  const [settingsStatus, setSettingsStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [backendMessage, setBackendMessage] = useState("");
  const [backendChecking, setBackendChecking] = useState(true);
  const [selectedAppId, setSelectedAppId] = useState(initialRunningAppId);
  const [runningAppId, setRunningAppId] = useState(initialRunningAppId);
  const [target, setTarget] = useState<SteamTarget | null>(null);
  const [binding, setBinding] = useState<InstalledTrainer | null>(null);
  const [bindingReady, setBindingReady] = useState(false);
  const [bindingRetryAttempt, setBindingRetryAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [automaticQuery, setAutomaticQuery] = useState("");
  const [automaticQueryReady, setAutomaticQueryReady] = useState(false);
  const [resultMode, setResultMode] = useState<"manual" | "automatic">("manual");
  const [results, setResults] = useState<TrainerEntry[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [searchStage, setSearchStage] = useState("");
  const [needsRestart, setNeedsRestart] = useState(false);
  const [runtime, setRuntime] = useState<TrainerRuntimeSnapshot | null>(null);
  const [runtimeRequest, setRuntimeRequest] = useState<string | null>(null);
  const lastAutomaticAdd = useRef("");
  const searchRequest = useRef(0);
  const searchAbort = useRef<AbortController | null>(null);
  const activeSearchMode = useRef<"manual" | "automatic" | null>(null);
  const backendRequest = useRef(0);
  const selectedAppIdRef = useRef(selectedAppId);
  const targetRef = useRef(target);
  const bindingRef = useRef(binding);
  const settingsRef = useRef(settings);
  const automaticAddGeneration = useRef(0);
  const automaticAddInFlight = useRef<string | null>(null);
  const automaticDownloadHandled = useRef<string | null>(null);
  const automaticAddManuallySuppressed = useRef(false);
  const automaticAddWasEnabled = useRef(settings.auto_search_and_add);
  const bindingRequest = useRef(0);
  const installInFlight = useRef<string | null>(null);
  selectedAppIdRef.current = selectedAppId;
  targetRef.current = target;
  bindingRef.current = binding;
  settingsRef.current = settings;

  useEffect(() => {
    return () => {
      // A download/bind transaction owns the page-global lock and must finish
      // so its recovery record and Steam write stay paired. Earlier automatic
      // work is cancellable and must not survive a remounted Decky panel.
      if (installInFlight.current === null) {
        automaticAddGeneration.current += 1;
        searchAbort.current?.abort();
        searchRequest.current += 1;
      }
    };
  }, []);

  const acceptRuntimeSnapshot = useCallback(
    (snapshot: TrainerRuntimeSnapshot) => {
      setRuntime((current) =>
        current &&
        current.app_id === snapshot.app_id &&
        (current.epoch > snapshot.epoch ||
          (current.epoch === snapshot.epoch &&
            current.revision > snapshot.revision))
          ? current
          : snapshot,
      );
    },
    [],
  );

  const checkBackend = useCallback(async () => {
    const request = backendRequest.current + 1;
    backendRequest.current = request;
    setBackendChecking(true);
    setBackendMessage("");
    try {
      const status = await withTimeout(
        getBackendStatus(),
        2500,
        "TrainerDeck Python 后端未连接",
      );
      if (backendRequest.current !== request) {
        return;
      }
      setBackendStatus(status);
      if (!status.core_ready) {
        setBackendMessage(
          status.core_error || "后端存储尚未初始化，下载和设置保存暂不可用",
        );
      } else if (!status.runtime_ready) {
        setBackendMessage(
          status.runtime_error || "修改器面板同步组件尚未启动",
        );
      }
    } catch (error) {
      if (backendRequest.current !== request) {
        return;
      }
      setBackendStatus(null);
      setBackendMessage(errorText(error));
    } finally {
      if (backendRequest.current === request) {
        setBackendChecking(false);
      }
    }
  }, []);

  useEffect(() => {
    void checkBackend();
    return () => {
      backendRequest.current += 1;
    };
  }, [checkBackend]);

  const runSearch = useCallback(async (
    value: string,
    mode: "manual" | "automatic" = "manual",
  ): Promise<TrainerEntry[]> => {
    if (mode === "manual") {
      automaticAddGeneration.current += 1;
      automaticAddManuallySuppressed.current = true;
    }
    const term = value.trim();
    if (term.length < 2) {
      notify("TrainerDeck", "请输入至少 2 个字符");
      return [];
    }
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    activeSearchMode.current = mode;
    const request = searchRequest.current + 1;
    searchRequest.current = request;
    let timedOut = false;
    const totalTimer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 22000);
    setBusy("search");
    setSearchStage(
      mode === "automatic" ? "正在搜索当前游戏…" : "正在在线解析游戏名…",
    );
    try {
      const currentTarget = targetRef.current;
      const automaticNeedsResolution =
        mode === "automatic" && /[\u3400-\u9fff\uf900-\ufaff]/u.test(term);
      const plan = mode === "automatic" && !automaticNeedsResolution
        ? {
            originalQuery: term,
            queries: [
              {
                query: term,
                source: "current-game" as const,
                score: 2000,
                steamCandidates: currentTarget
                  ? [
                      {
                        appId: currentTarget.appId,
                        name: term,
                        localizedName: currentTarget.name,
                        sourceQuery: term,
                      },
                    ]
                  : [],
              },
            ],
            fallbackQueries: [],
            warnings: [],
          }
        : await resolveManualSteamSearchPlan(
            term,
            currentTarget ?? undefined,
            controller.signal,
          );
      if (searchRequest.current !== request || controller.signal.aborted) {
        return [];
      }
      const searchQueries = mode === "manual"
        ? [...plan.queries, ...plan.fallbackQueries]
        : plan.queries;
      if (!searchQueries.length) {
        const message = plan.warnings[0] ?? "没有解析出可搜索的英文游戏名";
        setResults([]);
        setWarnings([message]);
        notify("没有找到结果", message);
        return [];
      }
      setSearchStage("正在搜索 FLiNG…");
      const response = await searchFlingTrainersMany(searchQueries, {
        mode: mode === "automatic" ? "exact" : "series",
        signal: controller.signal,
        concurrency: 3,
      });
      if (searchRequest.current !== request || controller.signal.aborted) {
        return [];
      }
      const currentAppId = targetRef.current?.appId ?? 0;
      const sortedItems = [...response.items].sort(
        (left, right) =>
          Number(right.compatible_app_ids?.includes(currentAppId) ?? false) -
          Number(left.compatible_app_ids?.includes(currentAppId) ?? false),
      );
      const visibleItems =
        mode === "automatic" ? sortedItems.slice(0, 1) : sortedItems;
      setResultMode(mode);
      setResults(visibleItems);
      const resolvedNames = searchQueries
        .map((candidate) => candidate.query)
        .filter((candidate, index, values) => values.indexOf(candidate) === index)
        .slice(0, 5);
      const resolutionNote =
        mode === "manual" &&
          (/[\u3400-\u9fff\uf900-\ufaff]/u.test(term) || resolvedNames.length > 1)
          ? `在线搜索将“${term}”解析为：${resolvedNames.join("、")}`
          : "";
      const resultCountNote =
        mode === "manual" && visibleItems.length > 0
          ? `部分名称搜索共找到 ${visibleItems.length} 个匹配结果。`
          : "";
      setWarnings([
        ...(resolutionNote ? [resolutionNote] : []),
        ...(resultCountNote ? [resultCountNote] : []),
        ...plan.warnings,
        ...response.warnings,
      ]);
      if (!visibleItems.length) {
        notify(
          "没有找到结果",
          plan.warnings[0] || response.warnings[0] || resolutionNote ||
            "请尝试更完整的中文名或英文名",
        );
      }
      return mode === "automatic" ? sortedItems : visibleItems;
    } catch (error) {
      if (controller.signal.aborted) {
        if (timedOut && searchRequest.current === request) {
          const message = "在线解析与 FLiNG 搜索在 22 秒内没有完成，请检查网络后重试";
          setResults([]);
          setWarnings([message]);
          notify("搜索超时", message);
        }
        return [];
      }
      if (searchRequest.current === request) {
        const message = errorText(error);
        setResults([]);
        setWarnings([message]);
        notify("搜索失败", message);
      }
      return [];
    } finally {
      window.clearTimeout(totalTimer);
      if (searchAbort.current === controller) {
        searchAbort.current = null;
        activeSearchMode.current = null;
      }
      if (searchRequest.current === request) {
        setBusy(null);
        setSearchStage("");
      }
    }
  }, []);

  const cancelSearch = useCallback(() => {
    searchAbort.current?.abort();
    searchAbort.current = null;
    activeSearchMode.current = null;
    searchRequest.current += 1;
    setBusy((current) => (current === "search" ? null : current));
    setSearchStage("");
    notify("TrainerDeck", "已取消本次搜索");
  }, []);

  useEffect(() => {
    let alive = true;
    setSettingsStatus("loading");
    void withTimeout(
      getSettings(),
      8000,
      "设置后端暂未响应",
    )
      .then((value) => {
        if (alive) {
          setSettings({ ...DEFAULT_SETTINGS, ...value });
          setSettingsStatus("ready");
        }
      })
      .catch((error: unknown) => {
        if (alive) {
          const message = errorText(error);
          setSettingsStatus("error");
          notify("读取设置失败", message);
        }
      });
    const handleSettingsChanged = (event: Event) => {
      const detail = (event as CustomEvent<TrainerDeckSettings>).detail;
      if (detail) {
        setSettings({ ...DEFAULT_SETTINGS, ...detail });
        setSettingsStatus("ready");
      }
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    return () => {
      alive = false;
      window.removeEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    };
  }, []);

  useEffect(() => {
    let refreshTimer: number | undefined;
    let pollTimer: number | undefined;
    const initial = currentRunningAppId();
    let observedAppId = initial;
    if (initial > 0) {
      setRunningAppId(initial);
      setSelectedAppId(initial);
    }
    const applyRunningApp = (appId: number) => {
      const previousAppId = observedAppId;
      observedAppId = appId;
      setRunningAppId(appId);
      setSelectedAppId((selected) =>
        appId > 0 ? appId : selected === previousAppId ? 0 : selected,
      );
    };
    const gameSessions = (
      globalThis as typeof globalThis & {
        SteamClient?: typeof SteamClient;
      }
    ).SteamClient?.GameSessions;
    let registration: { unregister(): void } | undefined;
    if (
      typeof gameSessions?.RegisterForAppLifetimeNotifications === "function"
    ) {
      try {
        registration = gameSessions.RegisterForAppLifetimeNotifications(
          (notification) => {
            const appId = Number(notification.unAppID);
            if (notification.bRunning && appId > 0) {
              if (refreshTimer !== undefined) {
                window.clearTimeout(refreshTimer);
                refreshTimer = undefined;
              }
              applyRunningApp(appId);
              return;
            }
            if (!notification.bRunning) {
              if (refreshTimer !== undefined) {
                window.clearTimeout(refreshTimer);
              }
              refreshTimer = window.setTimeout(() => {
                refreshTimer = undefined;
                applyRunningApp(currentRunningAppId());
              }, 200);
            }
          },
        );
      } catch (error) {
        console.warn(
          "TrainerDeck could not subscribe to Steam game sessions; using polling",
          error,
        );
      }
    }
    if (!registration) {
      pollTimer = window.setInterval(() => {
        const current = currentRunningAppId();
        if (current !== observedAppId) {
          applyRunningApp(current);
        }
      }, 2000);
    }
    return () => {
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
      }
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
      }
      registration?.unregister();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    automaticAddGeneration.current += 1;
    automaticAddInFlight.current = null;
    automaticDownloadHandled.current = null;
    automaticAddManuallySuppressed.current = false;
    bindingRequest.current += 1;
    searchAbort.current?.abort();
    searchAbort.current = null;
    activeSearchMode.current = null;
    searchRequest.current += 1;
    setBusy((current) => (current === "search" ? null : current));
    setSearchStage("");
    setQuery("");
    setAutomaticQuery("");
    setAutomaticQueryReady(false);
    lastAutomaticAdd.current = "";
    setResults([]);
    setWarnings([]);
    bindingRef.current = null;
    setBindingReady(false);
    setBindingRetryAttempt(0);
    if (selectedAppId <= 0) {
      setTarget(null);
      setBinding(null);
      setRuntime(null);
      setBindingReady(true);
      return () => {
        alive = false;
      };
    }
    setTarget(null);
    setBinding(null);
    setRuntime(null);
    setNeedsRestart(false);
    void readAppSummary(selectedAppId)
      .then((details) => {
        if (!alive) {
          return;
        }
        const updated = {
          ...details,
          running: currentRunningAppId() === selectedAppId,
        };
        setTarget(updated);
        setQuery((current) => current.trim() || updated.name);
        setNeedsRestart(false);
      })
      .catch((error: unknown) =>
        notify("读取 Steam 游戏信息失败", errorText(error)),
      );
    return () => {
      alive = false;
    };
  }, [selectedAppId]);

  useEffect(() => {
    if (
      selectedAppId <= 0 ||
      bindingReady ||
      (bindingRetryAttempt > 0 && backendStatus?.core_ready !== true)
    ) {
      return;
    }
    let alive = true;
    const appId = selectedAppId;
    const request = bindingRequest.current + 1;
    bindingRequest.current = request;
    const delay = bindingRetryAttempt === 0
      ? 0
      : Math.min(8000, 500 * (2 ** bindingRetryAttempt));
    const timer = window.setTimeout(() => {
      void withTimeout(
        getBinding(appId),
        3500,
        "读取修改器绑定超时",
      )
        .then((savedBinding) => {
          if (
            alive &&
            bindingRequest.current === request &&
            selectedAppIdRef.current === appId
          ) {
            bindingRef.current = savedBinding;
            setBinding(savedBinding);
            setBindingReady(true);
          }
        })
        .catch((error: unknown) => {
          if (
            !alive ||
            bindingRequest.current !== request ||
            selectedAppIdRef.current !== appId
          ) {
            return;
          }
          setBindingReady(false);
          if (bindingRetryAttempt === 0) {
            notify("读取修改器绑定失败", errorText(error));
          } else {
            console.warn("TrainerDeck binding retry failed", error);
          }
          setBindingRetryAttempt((current) =>
            current === bindingRetryAttempt ? current + 1 : current
          );
        });
    }, delay);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [
    backendStatus?.core_ready,
    bindingReady,
    bindingRetryAttempt,
    selectedAppId,
  ]);

  useEffect(() => {
    const wasEnabled = automaticAddWasEnabled.current;
    automaticAddWasEnabled.current = settings.auto_search_and_add;
    if (settings.auto_search_and_add && !wasEnabled) {
      automaticAddGeneration.current += 1;
      automaticAddInFlight.current = null;
      automaticAddManuallySuppressed.current = false;
      lastAutomaticAdd.current = "";
    }
    if (
      settingsStatus === "ready" &&
      settings.auto_search_and_add &&
      target?.running
    ) {
      setAutomaticQuery(target.name);
      setAutomaticQueryReady(target.name.trim().length >= 2);
      return;
    }
    setAutomaticQuery("");
    setAutomaticQueryReady(false);
    if (!settings.auto_search_and_add) {
      automaticAddGeneration.current += 1;
      automaticAddInFlight.current = null;
      automaticAddManuallySuppressed.current = false;
      if (activeSearchMode.current === "automatic") {
        searchAbort.current?.abort();
      }
      lastAutomaticAdd.current = "";
    }
  }, [
    settings.auto_search_and_add,
    settingsStatus,
    target?.appId,
    target?.name,
    target?.running,
  ]);

  useEffect(() => {
    setTarget((current) =>
      current
        ? {
            ...current,
            running: current.appId === runningAppId,
          }
        : current,
    );
  }, [runningAppId]);

  useEffect(() => {
    let alive = true;
    let pollTimer: number | undefined;
    const appId = selectedAppId;
    if (appId <= 0 || !binding) {
      setRuntime(null);
      return () => {
        alive = false;
      };
    }

    const receiveSnapshot = (snapshot: TrainerRuntimeSnapshot) => {
      if (alive && snapshot.app_id === appId) {
        acceptRuntimeSnapshot(snapshot);
      }
    };
    const registeredListener = addEventListener<[TrainerRuntimeSnapshot]>(
      "trainer_runtime_changed",
      receiveSnapshot,
    );

    const refresh = () => {
      void getTrainerRuntime(appId)
        .then(receiveSnapshot)
        .catch((error: unknown) =>
          notify("读取修改器面板失败", errorText(error)),
        );
    };
    refresh();
    pollTimer = window.setInterval(refresh, 3000);
    return () => {
      alive = false;
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
      }
      removeEventListener<[TrainerRuntimeSnapshot]>(
        "trainer_runtime_changed",
        registeredListener,
      );
    };
  }, [acceptRuntimeSnapshot, binding, selectedAppId]);

  const appendWarning = useCallback((message: string) => {
    setWarnings((current) =>
      current.includes(message) ? current : [...current, message]
    );
  }, []);

  const installAndBind = useCallback(async (
    entry: TrainerEntry,
    options: InstallAndBindOptions = {},
  ): Promise<boolean> => {
    const {
      allowExplicitTargetSelection = false,
      automatic = false,
      automaticOperationKey = "",
      shouldContinue = () => true,
    } = options;
    const operationTarget = targetRef.current;
    if (
      !operationTarget ||
      operationTarget.appId !== selectedAppIdRef.current
    ) {
      if (!automatic) {
        notify("无法绑定", "请先启动要绑定的 Steam 游戏或非 Steam 快捷方式");
      }
      return false;
    }
    if (
      !entry.compatible_app_ids?.includes(operationTarget.appId) &&
      !allowExplicitTargetSelection
    ) {
      if (!automatic) {
        notify(
          "无法绑定",
          "这个搜索结果没有与当前目标精确匹配；请从当前非 Steam 快捷方式或手动搜索结果中明确选择后再绑定。",
        );
      }
      return false;
    }
    if (installInFlight.current !== null || sharedInstallLock() !== null) {
      if (!automatic) {
        notify("操作正在进行", "已有修改器正在下载或绑定，请稍候");
      }
      return false;
    }

    const operationAppId = operationTarget.appId;
    const operationTargetType = operationTarget.targetType;
    const operationShortcutExe = operationTarget.shortcutExe?.trim() ?? "";
    const operationRunning = operationTarget.running;
    const operationBinding = bindingRef.current;
    const operationToken = `${operationAppId}:${entry.id}:${Date.now()}`;
    if (!acquireSharedInstallLock(operationToken)) {
      if (!automatic) {
        notify("操作正在进行", "已有修改器正在下载或绑定，请稍候");
      }
      return false;
    }
    installInFlight.current = operationToken;
    setBusy(`install:${entry.id}`);

    const automaticStopped = (message?: string): false => {
      if (message) {
        appendWarning(message);
      }
      return false;
    };
    const sameTargetIdentity = (details: SteamTarget): boolean => {
      if (
        details.appId !== operationAppId ||
        details.targetType !== operationTargetType
      ) {
        return false;
      }
      if (operationTargetType !== "shortcut") {
        return true;
      }
      return (details.shortcutExe?.trim() ?? "") === operationShortcutExe;
    };
    const automaticStillEnabled = async (): Promise<boolean> => {
      if (!shouldContinue()) {
        return false;
      }
      const persisted = await withTimeout(
        getSettings(),
        3000,
        "读取自动添加设置超时",
      );
      return shouldContinue() && persisted.auto_search_and_add === true;
    };

    try {
      let automaticLaunchOptionsField = operationTarget.launchOptionsField;
      if (automatic) {
        if (!await automaticStillEnabled()) {
          return false;
        }
        const preflight = await readAppDetails(operationAppId);
        if (!shouldContinue() || !sameTargetIdentity(preflight)) {
          return automaticStopped(
            "自动添加期间当前游戏发生变化，已停止下载和绑定。",
          );
        }
        automaticLaunchOptionsField = preflight.launchOptionsField;
        if (hasCheatDeckLaunchConfiguration(preflight)) {
          return automaticStopped(
            "检测到当前游戏已有 CheatDeck/修改器启动设置，已跳过自动搜索和添加；仍可手动搜索。",
          );
        }
        const existingBinding = await withTimeout(
          getBinding(operationAppId),
          3500,
          "复查修改器绑定超时",
        );
        if (!shouldContinue()) {
          return false;
        }
        if (existingBinding) {
          bindingRef.current = existingBinding;
          if (selectedAppIdRef.current === operationAppId) {
            setBinding(existingBinding);
            setBindingReady(true);
          }
          return automaticStopped(
            "当前游戏已经绑定修改器，已跳过自动添加。",
          );
        }
      }

      if (automatic && automaticOperationKey) {
        automaticDownloadHandled.current = automaticOperationKey;
        markAutomaticDownloadHandled(automaticOperationKey);
      }
      const installed = await downloadTrainer(entry);
      if (automatic && !await automaticStillEnabled()) {
        return automaticStopped(
          "自动下载已完成，但当前游戏或设置已经变化，因此没有写入绑定和启动项。",
        );
      }
      const bridge = await prepareTrainerBridge(operationAppId, installed.id);
      if (automatic && !shouldContinue()) {
        return automaticStopped(
          "修改器已下载，但当前游戏或设置已经变化，因此没有写入绑定和启动项。",
        );
      }
      const latestDetails = await readAppDetails(operationAppId);
      if (!sameTargetIdentity(latestDetails)) {
        throw new Error(
          operationTargetType === "shortcut"
            ? "非 Steam 快捷方式在下载期间已被替换；修改器已下载，但没有写入启动项"
            : "Steam 目标类型在下载期间发生变化；修改器已下载，但没有写入启动项",
        );
      }
      const latestShortcutExe = latestDetails.shortcutExe?.trim() ?? "";
      if (automatic) {
        if (!await automaticStillEnabled()) {
          return automaticStopped(
            "修改器已下载，但自动添加设置已经关闭，因此没有写入绑定和启动项。",
          );
        }
        if (
          !shouldContinue() ||
          latestDetails.launchOptionsField !== automaticLaunchOptionsField
        ) {
          return automaticStopped(
            "修改器已下载，但当前游戏或启动项字段已经变化，因此没有写入绑定。",
          );
        }
        if (hasCheatDeckLaunchConfiguration(latestDetails)) {
          return automaticStopped(
            "下载期间检测到当前游戏已加入 CheatDeck/修改器启动设置，因此没有覆盖现有配置。",
          );
        }
        const existingBinding = await withTimeout(
          getBinding(operationAppId),
          3500,
          "写入前复查修改器绑定超时",
        );
        if (!shouldContinue()) {
          return false;
        }
        if (existingBinding) {
          bindingRef.current = existingBinding;
          if (selectedAppIdRef.current === operationAppId) {
            setBinding(existingBinding);
            setBindingReady(true);
          }
          return automaticStopped(
            "下载期间当前游戏已经绑定修改器，因此没有重复写入启动项。",
          );
        }
      }

      const managedLaunchExecutable = bridge.supported
        ? bridge.launch_executable
        : installed.executable;
      const originalLaunchOptions = launchOptionsBeforeBinding(
        latestDetails,
        automatic ? null : operationBinding,
      );
      const launchOptions = buildTrainerLaunchOptions(
        originalLaunchOptions,
        managedLaunchExecutable,
        installed.executable,
      );
      // bindTrainer first records the recovery data. Once this transaction
      // starts, finish the guarded Steam write even if the menu closes.
      const saved = await bindTrainer(
        operationAppId,
        installed.id,
        managedLaunchExecutable,
        originalLaunchOptions,
        launchOptions,
        latestDetails.name,
        latestDetails.targetType,
        latestShortcutExe || operationShortcutExe,
        latestDetails.launchOptionsField,
      );
      await writeLaunchOptionsSafely(latestDetails, launchOptions);
      bindingRef.current = saved;
      if (selectedAppIdRef.current === operationAppId) {
        setBinding(saved);
        setBindingReady(true);
        acceptRuntimeSnapshot(await getTrainerRuntime(operationAppId));
        setNeedsRestart(operationRunning);
      }
      notify(
        automatic ? "已自动下载并添加" : "已下载并绑定",
        bridge.supported
          ? operationRunning
            ? "同步组件与启动参数已写入；请退出并重新启动游戏"
            : "同步组件已准备，将随游戏在同一 Proton 前缀启动"
          : `修改器已绑定，但同步组件不可用：${bridge.reason}`,
      );
      return true;
    } catch (error) {
      notify(automatic ? "自动添加失败" : "安装失败", errorText(error));
      return false;
    } finally {
      if (installInFlight.current === operationToken) {
        installInFlight.current = null;
        setBusy((current) =>
          current === `install:${entry.id}` ? null : current
        );
      }
      releaseSharedInstallLock(operationToken);
    }
  }, [acceptRuntimeSnapshot, appendWarning]);

  useEffect(() => {
    const currentTarget = target;
    const decision = decideAutomaticAdd({
      appId: currentTarget?.appId ?? 0,
      backendReady: backendStatus?.core_ready === true,
      bindingReady,
      cheatDeckConfigured: currentTarget
        ? hasCheatDeckLaunchConfiguration(currentTarget)
        : false,
      enabled: settings.auto_search_and_add,
      hasBinding: binding !== null,
      query: automaticQuery,
      queryReady: automaticQueryReady,
      settingsReady: settingsStatus === "ready",
      targetRunning: currentTarget?.running === true,
    });
    if (decision.action === "wait" || !currentTarget) {
      return;
    }

    const shortcutIdentity = currentTarget.shortcutExe?.trim() ?? "";
    const targetIdentity = [
      currentTarget.targetType,
      currentTarget.launchOptionsField,
      shortcutIdentity,
    ].join(":");
    const operationKey = `${decision.key}:${targetIdentity}`;
    if (decision.action === "skip-cheatdeck") {
      if (lastAutomaticAdd.current !== operationKey) {
        lastAutomaticAdd.current = operationKey;
        appendWarning(
          "检测到当前游戏已有 CheatDeck/修改器启动设置，已跳过自动搜索和添加；仍可手动搜索。",
        );
      }
      return;
    }
    if (
      lastAutomaticAdd.current === operationKey ||
      automaticAddInFlight.current !== null ||
      automaticDownloadHandled.current === operationKey ||
      automaticDownloadWasHandled(operationKey) ||
      automaticAddManuallySuppressed.current ||
      installInFlight.current !== null ||
      sharedInstallLock() !== null ||
      busy !== null
    ) {
      return;
    }

    const operationAppId = currentTarget.appId;
    const operationTargetType = currentTarget.targetType;
    const operationLaunchOptionsField = currentTarget.launchOptionsField;
    const generation = automaticAddGeneration.current;
    const automaticToken = `${operationKey}:${generation}:${Date.now()}`;
    lastAutomaticAdd.current = operationKey;
    automaticAddInFlight.current = automaticToken;

    const targetStillMatches = (): boolean => {
      const latest = targetRef.current;
      return Boolean(
        latest &&
          latest.appId === operationAppId &&
          latest.targetType === operationTargetType &&
          latest.launchOptionsField === operationLaunchOptionsField &&
          (latest.shortcutExe?.trim() ?? "") === shortcutIdentity,
      );
    };
    const shouldContinue = (): boolean =>
      automaticAddGeneration.current === generation &&
      settingsRef.current.auto_search_and_add &&
      selectedAppIdRef.current === operationAppId &&
      currentRunningAppId() === operationAppId &&
      bindingRef.current === null &&
      targetStillMatches();

    void (async () => {
      try {
        const preflight = await readAppDetails(operationAppId);
        if (!shouldContinue()) {
          return;
        }
        if (
          preflight.targetType !== operationTargetType ||
          preflight.launchOptionsField !== operationLaunchOptionsField ||
          (preflight.shortcutExe?.trim() ?? "") !== shortcutIdentity
        ) {
          appendWarning(
            "当前游戏信息在自动添加前发生变化，已停止本次操作。",
          );
          return;
        }
        if (hasCheatDeckLaunchConfiguration(preflight)) {
          appendWarning(
            "检测到当前游戏已有 CheatDeck/修改器启动设置，已跳过自动搜索和添加；仍可手动搜索。",
          );
          return;
        }

        const existingBinding = await withTimeout(
          getBinding(operationAppId),
          3500,
          "自动搜索前读取修改器绑定超时",
        );
        if (!shouldContinue()) {
          return;
        }
        if (existingBinding) {
          bindingRef.current = existingBinding;
          if (selectedAppIdRef.current === operationAppId) {
            setBinding(existingBinding);
            setBindingReady(true);
          }
          appendWarning("当前游戏已经绑定修改器，已跳过自动搜索和添加。");
          return;
        }

        const entries = await runSearch(decision.query, "automatic");
        if (!shouldContinue() || entries.length === 0) {
          return;
        }
        if (operationTargetType !== "steam") {
          appendWarning(
            "非 Steam 快捷方式无法用商店 AppID 自动核验；已显示搜索结果，请手动确认后下载并绑定。",
          );
          return;
        }

        const exactEntries = new Map(
          entries
            .filter(
              (entry) =>
                entry.provider === "fling-official" &&
                entry.search_match === "exact-app" &&
                entry.compatible_app_ids?.includes(operationAppId),
            )
            .map((entry) => [entry.id, entry] as const),
        );
        if (exactEntries.size !== 1) {
          appendWarning(
            exactEntries.size === 0
              ? "没有找到能用当前 Steam AppID 唯一核验的修改器，已停止自动下载；请手动搜索确认。"
              : "找到多个能匹配当前 Steam AppID 的修改器，已停止自动下载；请手动选择。",
          );
          return;
        }
        const entry = exactEntries.values().next().value;
        if (entry) {
          await installAndBind(entry, {
            automatic: true,
            automaticOperationKey: operationKey,
            shouldContinue,
          });
        }
      } catch (error) {
        if (shouldContinue()) {
          notify("自动搜索和添加失败", errorText(error));
        }
      } finally {
        if (automaticAddInFlight.current === automaticToken) {
          automaticAddInFlight.current = null;
        }
      }
    })();
  }, [
    appendWarning,
    automaticQuery,
    automaticQueryReady,
    backendStatus?.core_ready,
    binding,
    bindingReady,
    busy,
    installAndBind,
    runSearch,
    settings.auto_search_and_add,
    settingsStatus,
    target,
  ]);

  const downloadOnly = async (entry: TrainerEntry) => {
    if (installInFlight.current !== null || sharedInstallLock() !== null) {
      notify("操作正在进行", "已有修改器正在下载或绑定，请稍候");
      return;
    }
    const operationToken = `download:${entry.id}:${Date.now()}`;
    if (!acquireSharedInstallLock(operationToken)) {
      notify("操作正在进行", "已有修改器正在下载或绑定，请稍候");
      return;
    }
    installInFlight.current = operationToken;
    setBusy(`download:${entry.id}`);
    try {
      const installed = await downloadTrainer(entry);
      notify("修改器已下载", installed.folder || installed.executable);
    } catch (error) {
      notify("下载失败", errorText(error));
    } finally {
      if (installInFlight.current === operationToken) {
        installInFlight.current = null;
        setBusy((current) =>
          current === `download:${entry.id}` ? null : current
        );
      }
      releaseSharedInstallLock(operationToken);
    }
  };

  const prepareCurrentBridge = async () => {
    if (!target || target.appId !== selectedAppId || !binding) {
      return;
    }
    const operationAppId = target.appId;
    setBusy("prepare-bridge");
    try {
      const bridge = await prepareTrainerBridge(operationAppId, binding.id);
      if (!bridge.supported) {
        notify("同步组件不可用", bridge.reason);
        acceptRuntimeSnapshot(await getTrainerRuntime(operationAppId));
        return;
      }
      const latestDetails = await readAppDetails(operationAppId);
      const originalLaunchOptions = launchOptionsBeforeBinding(
        latestDetails,
        binding,
      );
      const launchOptions = buildTrainerLaunchOptions(
        originalLaunchOptions,
        bridge.launch_executable,
        binding.executable,
      );
      if (selectedAppIdRef.current !== operationAppId) {
        throw new Error("目标游戏已经变化，已停止更新启动项");
      }
      const refreshedBinding = await bindTrainer(
        operationAppId,
        binding.id,
        bridge.launch_executable,
        originalLaunchOptions,
        launchOptions,
        latestDetails.name,
        latestDetails.targetType,
        latestDetails.shortcutExe ?? "",
        latestDetails.launchOptionsField,
      );
      await writeLaunchOptionsSafely(
        latestDetails,
        launchOptions,
      );
      if (selectedAppIdRef.current === operationAppId) {
        setBinding(refreshedBinding);
        acceptRuntimeSnapshot(await getTrainerRuntime(operationAppId));
        setNeedsRestart(target.running);
      }
      notify(
        "同步组件已准备",
        target.running
          ? "请退出并重新启动游戏，使 bridge 与修改器一同加载"
          : "下次启动游戏时将自动连接修改器面板",
      );
    } catch (error) {
      notify("准备同步组件失败", errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const changeRuntimeOption = async (
    option: TrainerRuntimeOption,
    desired: boolean,
  ) => {
    if (
      !target ||
      target.appId !== selectedAppId ||
      !runtime ||
      runtime.app_id !== target.appId
    ) {
      return;
    }
    const operationAppId = target.appId;
    const inputRecoveryOperation =
      settingsRef.current.restore_input_on_qam_close
        ? qamInputRecoveryController.beginOperation(operationAppId)
        : null;
    let operationSucceeded = false;
    setRuntimeRequest(option.id);
    try {
      const snapshot = await setTrainerOption(
        operationAppId,
        runtime.session_id,
        option.id,
        desired,
        runtime.revision,
      );
      acceptRuntimeSnapshot(snapshot);
      operationSucceeded = true;
    } catch (error) {
      notify("修改器操作失败", errorText(error));
      try {
        acceptRuntimeSnapshot(await getTrainerRuntime(operationAppId));
      } catch {
        // The event/polling path will retry without inventing a local state.
      }
    } finally {
      const request = qamInputRecoveryController.finishOperation(
        inputRecoveryOperation,
        operationSucceeded,
      );
      if (request) {
        requestInputRecoveryTransition(request);
      }
      setRuntimeRequest(null);
    }
  };

  const changeRuntimeValue = async (
    option: TrainerRuntimeOption,
    value: string,
  ) => {
    if (
      !target ||
      target.appId !== selectedAppId ||
      !runtime ||
      runtime.app_id !== target.appId
    ) {
      return;
    }
    const operationAppId = target.appId;
    const inputRecoveryOperation =
      settingsRef.current.restore_input_on_qam_close
        ? qamInputRecoveryController.beginOperation(operationAppId)
        : null;
    let operationSucceeded = false;
    setRuntimeRequest(option.id);
    try {
      const snapshot = await setTrainerOptionValue(
        operationAppId,
        runtime.session_id,
        option.id,
        value,
        option.value ?? "",
        runtime.revision,
      );
      acceptRuntimeSnapshot(snapshot);
      operationSucceeded = true;
    } catch (error) {
      notify("写入修改器数值失败", errorText(error));
      try {
        acceptRuntimeSnapshot(await getTrainerRuntime(operationAppId));
      } catch {
        // The event/polling path will retry without inventing a local value.
      }
    } finally {
      const request = qamInputRecoveryController.finishOperation(
        inputRecoveryOperation,
        operationSucceeded,
      );
      if (request) {
        requestInputRecoveryTransition(request);
      }
      setRuntimeRequest(null);
    }
  };

  const invokeRuntimeAction = async (option: TrainerRuntimeOption) => {
    if (
      !target ||
      target.appId !== selectedAppId ||
      !runtime ||
      runtime.app_id !== target.appId
    ) {
      return;
    }
    const operationAppId = target.appId;
    const inputRecoveryOperation =
      settingsRef.current.restore_input_on_qam_close
        ? qamInputRecoveryController.beginOperation(operationAppId)
        : null;
    let operationSucceeded = false;
    setRuntimeRequest(option.id);
    try {
      const snapshot = await invokeTrainerOption(
        operationAppId,
        runtime.session_id,
        option.id,
        runtime.revision,
      );
      acceptRuntimeSnapshot(snapshot);
      operationSucceeded = true;
    } catch (error) {
      notify("执行修改器动作失败", errorText(error));
      try {
        acceptRuntimeSnapshot(await getTrainerRuntime(operationAppId));
      } catch {
        // The event/polling path will retry without inventing local success.
      }
    } finally {
      const request = qamInputRecoveryController.finishOperation(
        inputRecoveryOperation,
        operationSucceeded,
      );
      if (request) {
        requestInputRecoveryTransition(request);
      }
      setRuntimeRequest(null);
    }
  };

  const removeBinding = async () => {
    if (!target || target.appId !== selectedAppId) {
      return;
    }
    const operationAppId = target.appId;
    setBusy("unbind");
    try {
      if (selectedAppIdRef.current !== operationAppId) {
        throw new Error("目标游戏已经变化，已停止解除绑定");
      }
      if (!binding) {
        throw new Error("当前游戏没有 TrainerDeck 绑定");
      }
      await restoreTrainerLaunchBinding({
        app_id: operationAppId,
        managed_launch_executable: binding.managed_launch_executable || "",
        candidate_launch_executables:
          binding.candidate_launch_executables || [],
        original_launch_options: binding.original_launch_options ?? null,
        applied_launch_options: binding.applied_launch_options || "",
        target_type: binding.target_type ?? null,
        shortcut_exe: binding.shortcut_exe || "",
      });
      setBinding(null);
      notify(
        "已解除绑定",
        "已恢复目标启动项，修改器文件仍保留在下载目录中",
      );
    } catch (error) {
      notify("解除绑定失败", errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const openSettingsPage = useCallback(() => {
    try {
      cancelInputRecoverySession();
      Navigation.CloseSideMenus?.();
      Navigation.Navigate(SETTINGS_ROUTE);
    } catch (error) {
      notify("打开设置失败", errorText(error));
    }
  }, []);

  const openRecoveryPage = useCallback(() => {
    try {
      cancelInputRecoverySession();
      Navigation.CloseSideMenus?.();
      Navigation.Navigate(RECOVERY_ROUTE);
    } catch (error) {
      notify("打开恢复页面失败", errorText(error));
    }
  }, []);

  const disabled = busy !== null;
  const runtimeUpgradeRequired = Boolean(
    runtime?.connected &&
      !REQUIRED_RUNTIME_CAPABILITIES.every((capability) =>
        (runtime.capabilities ?? []).includes(capability),
      ),
  );
  const nativeTrainerWindowAvailable = Boolean(
    runtime?.connected &&
      (runtime.capabilities ?? []).includes("trainer_window_visible_v1"),
  );

  return (
    <Focusable style={{ display: "flex", flexDirection: "column" }}>
      <PanelSection title="当前目标">
        <PanelSectionRow>
          <div>
            <div style={{ fontWeight: 600 }}>
              {target
                ? target.targetType === "shortcut"
                  ? `${target.name} · 非 Steam 快捷方式`
                  : `${target.name} · Steam 游戏`
                : runningAppId > 0
                  ? "正在读取当前游戏信息"
                  : "当前没有游戏在运行"}
            </div>
            <SmallNote>
              {target?.running
                ? target.targetType === "shortcut"
                  ? "已识别当前运行的非 Steam 快捷方式；绑定会写入该快捷方式自己的启动项。"
                  : "已识别当前运行的 Steam 游戏；可以直接搜索和绑定修改器。"
                : "启动游戏后会自动识别；也可以在下方输入中文或英文游戏名搜索。"}
            </SmallNote>
          </div>
        </PanelSectionRow>
      </PanelSection>

      {!backendChecking &&
        (backendMessage || (backendStatus && !backendStatus.ok)) && (
          <PanelSection title="插件后端">
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                description={
                  backendStatus?.core_ready
                    ? `搜索、下载和设置可用；面板同步暂不可用：${backendMessage}`
                    : `搜索仍可用；下载、绑定和设置保存暂不可用：${backendMessage}`
                }
                onClick={() => void checkBackend()}
              >
                重新检测后端
              </ButtonItem>
            </PanelSectionRow>
          </PanelSection>
        )}

      <PanelSection title="搜索修改器">
        <PanelSectionRow>
          <TextField
            label="游戏名（支持中文/英文部分名称，会列出多个匹配结果）"
            value={query}
            disabled={disabled}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void runSearch(query, "manual");
              }
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy !== null && busy !== "search"}
            onClick={() =>
              busy === "search"
                ? cancelSearch()
                : void runSearch(query, "manual")
            }
          >
            {busy === "search"
              ? `${searchStage || "正在搜索…"}（点此取消）`
              : "搜索"}
          </ButtonItem>
        </PanelSectionRow>
        {warnings.map((warning) => (
          <PanelSectionRow key={warning}>
            <SmallNote>{warning}</SmallNote>
          </PanelSectionRow>
        ))}
        {results.map((entry) => {
          const exactAppMatch = Boolean(
            target && entry.compatible_app_ids?.includes(target.appId),
          );
          const manualTargetBinding = Boolean(
            target && resultMode === "manual" && target.appId === selectedAppId,
          );
          const automaticShortcutBinding = Boolean(
            target &&
              resultMode === "automatic" &&
              target.targetType === "shortcut" &&
              target.appId === selectedAppId,
          );
          const explicitTargetBinding =
            (manualTargetBinding || automaticShortcutBinding) && !exactAppMatch;
          const canBind =
            exactAppMatch || manualTargetBinding || automaticShortcutBinding;
          const matchLabel = exactAppMatch
            ? target?.targetType === "shortcut"
              ? "已确认当前非 Steam 快捷方式"
              : "已确认当前 Steam 游戏"
            : automaticShortcutBinding
              ? `自动搜索结果；选择后将绑定当前非 Steam 快捷方式 ${target?.name}`
            : manualTargetBinding
              ? target?.targetType === "shortcut"
                ? `手动选择后将绑定非 Steam 快捷方式 ${target.name}`
                : `手动选择后将绑定 Steam 游戏 ${target?.name}`
            : entry.search_match === "series"
              ? "系列部分匹配"
              : "未确认对应当前游戏";
          return (
            <PanelSectionRow key={entry.id}>
              <div style={{ marginBottom: "6px" }}>
                <div style={{ fontWeight: 600 }}>{entry.title}</div>
                <SmallNote>
                  {`${entry.provider}${entry.version ? ` · ${entry.version}` : " · 最新版"} · ${matchLabel}`}
                </SmallNote>
              </div>
              <ButtonItem
                layout="below"
                disabled={disabled || backendStatus?.core_ready !== true}
                onClick={() =>
                  canBind
                    ? void installAndBind(entry, {
                        allowExplicitTargetSelection: explicitTargetBinding,
                      })
                    : void downloadOnly(entry)
                }
              >
                {backendChecking
                  ? "正在检测插件后端…"
                  : backendStatus?.core_ready !== true
                    ? "后端不可用，暂不能下载"
                    : busy === `install:${entry.id}` ||
                        busy === `download:${entry.id}`
                      ? "正在下载与解压…"
                      : canBind
                        ? explicitTargetBinding
                          ? target?.targetType === "shortcut"
                            ? "下载并绑定当前非 Steam 快捷方式"
                            : "下载并绑定当前 Steam 游戏"
                          : "下载最新版并绑定当前目标"
                        : "仅下载最新版"}
              </ButtonItem>
            </PanelSectionRow>
          );
        })}
      </PanelSection>

      {binding && (
        <PanelSection title="修改器面板">
          <PanelSectionRow>
            <div>
              <div style={{ fontWeight: 600 }}>{binding.title}</div>
              <SmallNote>
                {needsRestart
                  ? "本次游戏启动时尚未加载修改器，请重启游戏。"
                  : runtimeUpgradeRequired
                    ? `${nativeTrainerWindowAvailable ? "原生修改器窗口保持可用；" : ""}当前仍在运行旧版同步组件${runtime?.bridge_version ? ` ${runtime.bridge_version}` : ""}；升级并重启游戏后，可连续操作多个项目。`
                  : runtime?.connected && runtime.game_available
                    ? nativeTrainerWindowAvailable
                      ? "已连接修改器核心。原生修改器窗口与 TrainerDeck 菜单同时可用；修改后菜单保持打开，可继续操作其他项目。"
                      : "已连接修改器核心。修改后菜单保持打开，可继续操作其他项目；失败时会留在此处显示原因。"
                    : runtime?.status === "disconnected" &&
                        runtime.options.length > 0
                      ? `${runtime.message || "bridge 连接已断开"}；上次识别的 ${runtime.options.length} 个修改项已保留，自动重连前暂不可操作。`
                    : runtime?.message ||
                      (runtime?.status === "waiting"
                        ? "同步组件已准备；启动游戏后将自动连接。"
                        : runtime?.status === "unsupported"
                          ? "当前安装暂不支持直接同步。"
                          : target?.running
                            ? "正在等待修改器 bridge 连接。"
                            : "修改器已绑定；启动游戏后将随同一 Proton 前缀运行。")}
              </SmallNote>
            </div>
          </PanelSectionRow>
          {(!runtime?.connected || runtimeUpgradeRequired) && (
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={disabled}
                onClick={() => void prepareCurrentBridge()}
              >
                {busy === "prepare-bridge"
                  ? "正在准备同步组件…"
                  : runtimeUpgradeRequired
                    ? "升级直接同步组件"
                    : "准备或修复直接同步"}
              </ButtonItem>
            </PanelSectionRow>
          )}
          {runtime &&
            runtime.options.map((option, index) => {
              const group = localizedText(option.group);
              const previousGroup =
                index > 0
                  ? localizedText(runtime.options[index - 1].group)
                  : "";
              return (
                <Fragment key={option.id}>
                  {group && group !== previousGroup && (
                    <PanelSectionRow>
                      <div
                        style={{
                          fontSize: "13px",
                          fontWeight: 700,
                          marginTop: "6px",
                          opacity: 0.85,
                        }}
                      >
                        {group}
                      </div>
                    </PanelSectionRow>
                  )}
                  <PanelSectionRow>
                    <RuntimeOptionRow
                      option={option}
                      connected={runtime.connected === true}
                      disabled={
                        disabled ||
                        needsRestart ||
                        runtimeUpgradeRequired ||
                        runtimeRequest !== null ||
                        runtime.connected !== true ||
                        runtime.game_available !== true
                      }
                      gameAvailable={runtime.game_available === true}
                      onToggle={(desired) =>
                        void changeRuntimeOption(option, desired)
                      }
                      onValue={(value) =>
                        void changeRuntimeValue(option, value)
                      }
                      onAction={() => void invokeRuntimeAction(option)}
                    />
                  </PanelSectionRow>
                </Fragment>
              );
            })}
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={disabled}
              onClick={() => void removeBinding()}
            >
              解除绑定（保留文件）
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      )}

      <PanelSection title="安全提示">
        <PanelSectionRow>
          <SmallNote>
            仅建议用于单机或离线游戏。插件不会绕过反作弊；修改器是第三方 Windows
            程序，下载和运行前请自行确认来源与风险。
          </SmallNote>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="故障恢复">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            description="游戏无法启动时，按目标类型恢复 TrainerDeck 改写前的启动项"
            onClick={openRecoveryPage}
          >
            一键恢复启动项
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="设置">
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={openSettingsPage}>
            打开设置
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </Focusable>
  );
}

export default definePlugin(() => {
  registerInputRecoveryUi();
  routerHook.addRoute(SETTINGS_ROUTE, TrainerDeckSettingsPage, { exact: true });
  routerHook.addRoute(RECOVERY_ROUTE, TrainerDeckRecoveryPage, { exact: true });
  return {
    name: "TrainerDeck",
    titleView: <div className={staticClasses.Title}>TrainerDeck</div>,
    content: <Content />,
    icon: <FaBolt />,
    onDismount() {
      unregisterInputRecoveryUi();
      routerHook.removeRoute(SETTINGS_ROUTE);
      routerHook.removeRoute(RECOVERY_ROUTE);
      console.log("TrainerDeck frontend unloaded");
    },
  };
});
