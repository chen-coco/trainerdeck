export interface TrainerDeckSettings {
  schema_version: number;
  trainer_root: string;
  auto_search_and_add: boolean;
  restore_input_on_qam_close: boolean;
}

export interface BackendStatus {
  ok: boolean;
  version: string;
  python_version: string;
  core_ready: boolean;
  core_error: string;
  runtime_ready: boolean;
  runtime_error: string;
  settings_dir: string;
  runtime_dir: string;
}

export interface TrainerEntry {
  id: string;
  provider: string;
  game_name: string;
  title: string;
  version: string;
  page_url: string;
  download_url: string;
  sha256?: string;
  aliases?: string[];
  matched_queries?: string[];
  compatible_app_ids?: number[];
  search_match?: "exact-app" | "series" | "unverified";
}

export interface SteamStoreCandidate {
  appId: number;
  name: string;
  localizedName?: string;
  sourceQuery: string;
}

export interface TrainerSearchQuery {
  query: string;
  source:
    | "current-game"
    | "manual-english"
    | "steam-localized"
    | "steam-shortcut"
    | "steam-franchise"
    | "online-translation"
    | "steam-cluster"
    | "wikimedia";
  score: number;
  steamCandidates: SteamStoreCandidate[];
}

export interface TrainerSearchPlan {
  originalQuery: string;
  queries: TrainerSearchQuery[];
  fallbackQueries: TrainerSearchQuery[];
  warnings: string[];
}

export interface InstalledTrainer extends TrainerEntry {
  folder: string;
  executable: string;
  sha256: string;
  installed_at: string;
  download_name?: string;
  managed_launch_executable?: string;
  candidate_launch_executables?: string[];
  app_id?: number;
  original_launch_options?: string | null;
  applied_launch_options?: string;
  display_name?: string;
  target_type?: "steam" | "shortcut" | null;
  launch_options_field?: "app" | "shortcut" | null;
  shortcut_exe?: string;
  bound_at?: string;
}

export interface TrainerBindingRecord {
  app_id: number;
  installation_id: string;
  title: string;
  display_name: string;
  target_type?: "steam" | "shortcut" | null;
  launch_options_field?: "app" | "shortcut" | null;
  shortcut_exe?: string;
  managed_launch_executable: string;
  candidate_launch_executables: string[];
  original_launch_options: string | null;
  applied_launch_options: string;
  bound_at: string;
  active: boolean;
  launch_options_restored: boolean;
  unbound_at: string;
}

export interface SearchResponse {
  items: TrainerEntry[];
  warnings: string[];
}

export interface LocalizedTrainerText {
  zh_cn?: string;
  zh_tw?: string;
  en?: string;
}

export type TrainerRuntimeStatus =
  | "not_prepared"
  | "unsupported"
  | "waiting"
  | "connected"
  | "disconnected"
  | "error";

export type TrainerRuntimeOptionKind =
  | "toggle"
  | "toggle_with_input"
  | "toggle_with_input_adjustment"
  | "action"
  | "input"
  | "unknown";

export interface TrainerRuntimeOption {
  id: string;
  kind: TrainerRuntimeOptionKind;
  labels: LocalizedTrainerText;
  tooltips: LocalizedTrainerText;
  group: LocalizedTrainerText;
  tooltip_style: "normal" | "important";
  active: boolean | null;
  controllable: boolean;
  pending: boolean;
  desired: boolean | null;
  error: string;
  value_controllable: boolean;
  value_pending: boolean;
  desired_value: string | null;
  value_error: string;
  value_type: "integer" | "number" | "text" | "none";
  value_apply_mode: "stage_then_toggle" | "invoke" | "none";
  action_controllable: boolean;
  action_pending: boolean;
  action_error: string;
  value?: string;
  minimum?: number;
  maximum?: number;
  step?: number;
}

export interface TrainerRuntimeSnapshot {
  app_id: number;
  epoch: number;
  status: TrainerRuntimeStatus;
  connected: boolean;
  session_id: string;
  revision: number;
  bridge_revision: number;
  game_available: boolean | null;
  trainer_sha256: string;
  bridge_version: string;
  capabilities: string[];
  ui_fingerprint: string;
  options: TrainerRuntimeOption[];
  message: string;
}

export interface TrainerBridgePreparation {
  app_id: number;
  supported: boolean;
  status: TrainerRuntimeStatus;
  reason: string;
  launch_executable: string;
  trainer_sha256: string;
  manifest?: string;
  assets?: string[];
}

export interface SteamTarget {
  appId: number;
  name: string;
  targetType: "steam" | "shortcut";
  launchOptionsField: "app" | "shortcut";
  launchOptions: string;
  appLaunchOptions: string;
  shortcutLaunchOptions?: string;
  running: boolean;
  shortcutExe?: string;
  shortcutStartDir?: string;
}
