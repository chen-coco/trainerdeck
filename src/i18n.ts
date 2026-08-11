import type { LocalizedTrainerText } from "./types";

export type UiLanguage = "zh" | "en";

function normalizeLocale(locale: string | null | undefined): string {
  return String(locale ?? "").trim().toLowerCase().replace(/_/g, "-");
}

export function systemLocale(): string {
  if (typeof navigator === "undefined") {
    return "en";
  }
  return navigator.languages?.[0] || navigator.language || "en";
}

export function resolveUiLanguage(
  locale: string | null | undefined = systemLocale(),
): UiLanguage {
  const normalized = normalizeLocale(locale);
  return normalized === "zh" || normalized.startsWith("zh-") ? "zh" : "en";
}

export function t(
  chinese: string,
  english: string,
  locale: string | null | undefined = systemLocale(),
): string {
  return resolveUiLanguage(locale) === "zh" ? chinese : english;
}

export function localizedTrainerText(
  value: LocalizedTrainerText,
  locale: string | null | undefined = systemLocale(),
): string {
  const normalized = normalizeLocale(locale);
  if (
    normalized.startsWith("zh-tw") ||
    normalized.startsWith("zh-hk") ||
    normalized.startsWith("zh-mo")
  ) {
    return value.zh_tw || value.zh_cn || value.en || "";
  }
  if (resolveUiLanguage(normalized) === "zh") {
    return value.zh_cn || value.zh_tw || value.en || "";
  }
  return value.en || value.zh_cn || value.zh_tw || "";
}
