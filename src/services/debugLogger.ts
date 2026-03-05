import { invoke } from "@tauri-apps/api/core";

const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);

function toJson(payload: unknown): string | null {
  if (payload === undefined) return null;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

export function debugLog(scope: string, message: string, payload?: unknown): void {
  const timestamp = new Date().toISOString();
  if (payload === undefined) {
    console.log(`[${timestamp}][${scope}] ${message}`);
  } else {
    console.log(`[${timestamp}][${scope}] ${message}`, payload);
  }

  if (!isTauri) return;
  void invoke("frontend_log", {
    level: "info",
    scope,
    message,
    payload: toJson(payload),
  }).catch(() => {
    // keep silent in UI path; terminal log is best-effort only
  });
}

export function debugError(scope: string, message: string, payload?: unknown): void {
  const timestamp = new Date().toISOString();
  if (payload === undefined) {
    console.error(`[${timestamp}][${scope}] ${message}`);
  } else {
    console.error(`[${timestamp}][${scope}] ${message}`, payload);
  }

  if (!isTauri) return;
  void invoke("frontend_log", {
    level: "error",
    scope,
    message,
    payload: toJson(payload),
  }).catch(() => {
    // keep silent in UI path; terminal log is best-effort only
  });
}
