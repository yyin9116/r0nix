export const PERSISTENCE_WARNING_EVENT = "r0nix:persistence-warning";

export interface PersistenceWarning {
  key: string;
  kind: "read" | "write";
  message: string;
  backupKey?: string;
}

const pendingWarnings: PersistenceWarning[] = [];
const forwardIncompatibleKeys = new Set<string>();

function emitWarning(warning: PersistenceWarning) {
  pendingWarnings.push(warning);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PERSISTENCE_WARNING_EVENT, { detail: warning }));
  }
}

export function consumePersistenceWarnings(): PersistenceWarning[] {
  return pendingWarnings.splice(0, pendingWarnings.length);
}

export function readVersionedLocalState<T>(
  key: string,
  version: number,
  fallback: T,
  sanitize: (raw: unknown) => T
): T {
  if (typeof window === "undefined") return fallback;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emitWarning({
      key,
      kind: "read",
      message: `Local data for ${key} could not be accessed. The fallback value was preserved. ${reason}`,
    });
    return fallback;
  }
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as unknown;
    const hasEnvelope =
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      "data" in parsed &&
      typeof (parsed as { version?: unknown }).version === "number";
    if (hasEnvelope) {
      const storedVersion = (parsed as { version: number }).version;
      if (storedVersion > version) {
        forwardIncompatibleKeys.add(key);
        emitWarning({
          key,
          kind: "read",
          message: `Local data for ${key} was saved by a newer schema version (${storedVersion}).`,
        });
        return fallback;
      }
    }
    const data = hasEnvelope ? (parsed as { data: unknown }).data : parsed;
    return sanitize(data);
  } catch (error) {
    const backupKey = `${key}.corrupt.${Date.now()}`;
    try {
      window.localStorage.setItem(backupKey, raw);
      window.localStorage.removeItem(key);
    } catch {
      // The original value remains if backup fails.
    }
    const reason = error instanceof Error ? error.message : String(error);
    emitWarning({
      key,
      kind: "read",
      backupKey,
      message: `Local data for ${key} could not be read and was isolated. ${reason}`,
    });
    return fallback;
  }
}

export function writeVersionedLocalState<T>(key: string, version: number, data: T): void {
  if (typeof window === "undefined") return;
  if (forwardIncompatibleKeys.has(key)) return;
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        version,
        updatedAt: new Date().toISOString(),
        data,
      })
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emitWarning({
      key,
      kind: "write",
      message: `Local data for ${key} could not be written. The previous value was preserved. ${reason}`,
    });
  }
}
