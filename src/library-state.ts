import type { InstalledTrainer, SteamTarget, TrainerBindingRecord } from "./types";

export function installationKey(installation: InstalledTrainer): string {
  return JSON.stringify([installation.id, installation.folder]);
}

export function installationBindings(
  installation: InstalledTrainer,
  records: TrainerBindingRecord[],
): TrainerBindingRecord[] {
  // An unrestored launch entry can still refer to these files after an older
  // version marked the record inactive. Keep it protected until recovery.
  return records.filter((record) =>
    record.installation_id === installation.id &&
    (record.active || !record.launch_options_restored)
  );
}

export function installationReferences(
  installation: InstalledTrainer,
  records: TrainerBindingRecord[],
): TrainerBindingRecord[] {
  // Switching versions retains old launch paths for recovery. Those paths
  // protect the old files even when the binding now has a different ID.
  // The backend supplies canonical paths and remains the deletion authority.
  const folder = installation.folder.replace(/\\/g, "/").replace(/\/+$/, "");
  const refersToFolder = (path: string | undefined): boolean => {
    if (!folder || !path) return false;
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized === folder || normalized.startsWith(`${folder}/`);
  };
  return records.filter((record) =>
    (record.active || !record.launch_options_restored) &&
    (record.installation_id === installation.id || [
      record.installation_folder,
      record.managed_launch_executable,
      ...(record.candidate_launch_executables ?? []),
    ].some(refersToFolder))
  );
}

export function installationBindingState(
  installation: InstalledTrainer,
  records: TrainerBindingRecord[],
  target: SteamTarget | null,
): "available" | "no-target" | "bound-here" | "bound-elsewhere" {
  const bindings = installationBindings(installation, records);
  if (bindings.some((record) =>
    !target || record.app_id !== target.appId ||
    (record.target_type && record.target_type !== target.targetType) ||
    (record.target_type === "shortcut" && record.shortcut_exe &&
      record.shortcut_exe.trim() !== target.shortcutExe?.trim())
  )) {
    return "bound-elsewhere";
  }
  if (bindings.length > 0) {
    return "bound-here";
  }
  return target ? "available" : "no-target";
}

export function installationMatchesQuery(
  installation: InstalledTrainer,
  records: TrainerBindingRecord[],
  query: string,
): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const searchable = [
    installation.title,
    installation.game_name,
    installation.version,
    installation.provider,
    ...(installation.aliases ?? []),
    ...installationReferences(installation, records).flatMap((record) => [
      record.display_name,
      record.title,
      String(record.app_id),
    ]),
  ].join(" ").toLocaleLowerCase();
  return words.every((word) => searchable.includes(word));
}
