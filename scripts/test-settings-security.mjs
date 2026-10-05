import { readFileSync } from "node:fs";
import { consumePersistenceWarnings, readVersionedLocalState, writeVersionedLocalState } from "../src/services/localStore.ts";

const source = readFileSync("src/services/userSettings.ts", "utf8");

if (!source.includes("const aiApiKey = DEFAULT_SETTINGS.aiApiKey;")) {
  throw new Error("sanitizeUserSettings must discard API keys loaded from persisted state");
}
if (!source.includes('const persisted = { ...next, aiApiKey: "" };')) {
  throw new Error("saveUserSettings must strip API keys before writing local settings");
}
if (!source.includes("const hasPersistedApiKey = typeof parsed.aiApiKey === \"string\" && parsed.aiApiKey.length > 0;")) {
  throw new Error("loadUserSettings must scrub legacy persisted API keys");
}

globalThis.window = {
  dispatchEvent() {
    return true;
  },
  localStorage: {
    setItem() {
      throw new Error("quota exceeded");
    },
  },
};
writeVersionedLocalState("settings-test", 1, { value: true });
const warning = consumePersistenceWarnings().find((item) => item.key === "settings-test");
if (!warning || warning.kind !== "write" || !warning.message.includes("previous value was preserved")) {
  throw new Error("local persistence failures must preserve prior data and emit a warning");
}

let futureValue = JSON.stringify({ version: 99, updatedAt: "2099-01-01T00:00:00.000Z", data: { keep: "future" } });
let writeAttempts = 0;
globalThis.window = {
  dispatchEvent() {
    return true;
  },
  localStorage: {
    getItem() {
      return futureValue;
    },
    setItem(_key, value) {
      writeAttempts += 1;
      futureValue = value;
    },
  },
};
const recovered = readVersionedLocalState("future-schema", 1, { keep: "fallback" }, (raw) => raw);
if (recovered.keep !== "fallback") {
  throw new Error("future schema data must not be hydrated by an older application");
}
writeVersionedLocalState("future-schema", 1, { keep: "current" });
if (writeAttempts !== 0 || !futureValue.includes('"keep":"future"')) {
  throw new Error("future schema data must not be overwritten by an older application");
}
const futureWarning = consumePersistenceWarnings().find((item) => item.key === "future-schema");
if (!futureWarning || futureWarning.kind !== "read") {
  throw new Error("future schema warnings must be classified as read issues");
}

globalThis.window = {
  dispatchEvent() {
    return true;
  },
  localStorage: {
    getItem() {
      throw new Error("storage access denied");
    },
  },
};
const unavailable = readVersionedLocalState("unavailable-storage", 1, { keep: "fallback" }, (raw) => raw);
if (unavailable.keep !== "fallback") {
  throw new Error("storage access failures must return the fallback value");
}
const unavailableWarning = consumePersistenceWarnings().find((item) => item.key === "unavailable-storage");
if (!unavailableWarning || unavailableWarning.kind !== "read" || !unavailableWarning.message.includes("fallback value")) {
  throw new Error("storage access failures must emit a read warning");
}

console.log("settings-security: ok");
