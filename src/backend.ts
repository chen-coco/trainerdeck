import { callable } from "@decky/api";

import type {
  BackendStatus,
  InstalledTrainer,
  TrainerBindingRecord,
  TrainerBridgePreparation,
  TrainerDeckSettings,
  TrainerEntry,
  TrainerRuntimeSnapshot,
} from "./types";

export const getBackendStatus = callable<[], BackendStatus>("backend_status");

export const getSettings = callable<[], TrainerDeckSettings>("get_settings");

export const saveSettings = callable<
  [settings: TrainerDeckSettings],
  TrainerDeckSettings
>("save_settings");

export const downloadTrainer = callable<
  [entry: TrainerEntry],
  InstalledTrainer
>("download_trainer");

export const listInstalled = callable<[], InstalledTrainer[]>("list_installed");

export const getBinding = callable<
  [appId: number],
  InstalledTrainer | null
>("get_binding");

export const listBindings = callable<[], TrainerBindingRecord[]>("list_bindings");

export const bindTrainer = callable<
  [
    appId: number,
    installationId: string,
    managedLaunchExecutable: string,
    originalLaunchOptions: string | null,
    appliedLaunchOptions: string,
    displayName: string,
    targetType: "steam" | "shortcut",
    shortcutExe: string,
    launchOptionsField?: "app" | "shortcut",
  ],
  InstalledTrainer
>("bind_trainer");

export const unbindTrainer = callable<
  [appId: number, launchOptionsRestored: boolean],
  boolean
>(
  "unbind_trainer",
);

export const prepareTrainerBridge = callable<
  [appId: number, installationId: string],
  TrainerBridgePreparation
>("prepare_trainer_bridge");

export const getTrainerRuntime = callable<
  [appId: number],
  TrainerRuntimeSnapshot
>("get_trainer_runtime");

export const setTrainerOption = callable<
  [
    appId: number,
    sessionId: string,
    optionId: string,
    desired: boolean,
    expectedRevision: number,
  ],
  TrainerRuntimeSnapshot
>("set_trainer_option");

export const setTrainerOptionValue = callable<
  [
    appId: number,
    sessionId: string,
    optionId: string,
    value: string,
    expectedValue: string,
    expectedRevision: number,
  ],
  TrainerRuntimeSnapshot
>("set_trainer_option_value");

export const invokeTrainerOption = callable<
  [
    appId: number,
    sessionId: string,
    optionId: string,
    expectedRevision: number,
  ],
  TrainerRuntimeSnapshot
>("invoke_trainer_option");
