import { t } from "./i18n";

/** Return a short user-facing reason, including Decky errors with no message. */
export function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const details = error as { message?: unknown; pythonTraceback?: unknown };
    if (typeof details.message === "string" && details.message.trim()) {
      return details.message.trim();
    }
    const traceback = typeof details.pythonTraceback === "string"
      ? details.pythonTraceback
      : Array.isArray(details.pythonTraceback)
        ? details.pythonTraceback.filter((line) => typeof line === "string").join("\n")
        : "";
    const lines = traceback.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const summary = lines[lines.length - 1];
    if (summary) {
      // Decky's PyError can lose the backend message while retaining its Python
      // traceback. Show only the final exception reason, never the full stack.
      return summary.replace(/^[A-Za-z_][\w.]*:\s*/, "").trim() || summary;
    }
  }
  if (error !== null && error !== undefined) {
    try {
      const rendered = String(error).trim();
      if (rendered && rendered !== "[object Object]") return rendered;
    } catch {
      // An opaque thrown object still needs a non-empty user-facing message.
    }
  }
  return t("发生未知错误，请重试。", "An unknown error occurred. Please retry.");
}
