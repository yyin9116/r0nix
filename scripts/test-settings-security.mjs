import { readFileSync } from "node:fs";
import { consumePersistenceWarnings, readVersionedLocalState, writeVersionedLocalState } from "../src/services/localStore.ts";

const source = readFileSync("src/services/userSettings.ts", "utf8");
const appSource = readFileSync("src/App.tsx", "utf8");

// 本模块有 value import（`../constants/startPage`），node 加载不了，所以这里只能做源码断言。
// 断言按「契约」而不是「出现过某行」来写：把 aiApiKey 的赋值整块抠出来，要求两条分支都在。
const apiKeyBlock = source.match(/const aiApiKey =[\s\S]*?;\n/);
if (!apiKeyBlock) {
  throw new Error("sanitizeUserSettings must resolve aiApiKey explicitly");
}
if (!apiKeyBlock[0].includes("DEFAULT_SETTINGS.aiApiKey")) {
  throw new Error("hydrating settings must fall back to the empty default API key");
}
if (!apiKeyBlock[0].includes("parsed.aiApiKey") || !apiKeyBlock[0].includes("dropApiKey")) {
  throw new Error(
    "sanitizeUserSettings must keep the typed API key when the caller opts out, " +
      "otherwise every keystroke is wiped and the input looks read-only"
  );
}

// 真正的根因在这里：运行时保存若沿用 hydrate 的默认（丢弃），输入框就永远打不进字。
// 必须显式 opt-out，且必须带参数才算数。
const persistCall = appSource.match(/sanitizeUserSettings\(next[^)]*\)/);
if (!persistCall || !persistCall[0].includes("dropApiKey")) {
  throw new Error("persistSettings must pass { dropApiKey: false }, otherwise the API key input cannot be typed into");
}

if (!source.includes('const persisted = { ...next, aiApiKey: "" };')) {
  throw new Error("saveUserSettings must strip API keys before writing local settings");
}
if (!source.includes("const hasPersistedApiKey = typeof parsed.aiApiKey === \"string\" && parsed.aiApiKey.length > 0;")) {
  throw new Error("loadUserSettings must scrub legacy persisted API keys");
}

// 设置文件会落到工作区，用户可能直接打开它检查。同一条契约必须在文件通道上再钉一次 ——
// 只保护 localStorage 而文件通道裸奔，等于没保护。
const workspaceWriter = source.match(/async function saveUserSettingsToWorkspace[\s\S]*?\n}/);
if (!workspaceWriter) {
  throw new Error("settings must have a workspace file writer");
}
if (!workspaceWriter[0].includes('aiApiKey: ""')) {
  throw new Error("the workspace settings file must strip API keys before writing");
}
const workspaceReader = source.match(/export async function loadUserSettingsFromWorkspace[\s\S]*?\n}/);
if (!workspaceReader) {
  throw new Error("settings must have a workspace file reader");
}
if (!workspaceReader[0].includes("sanitizeUserSettings(data)")) {
  throw new Error("hydrating settings from the workspace must run sanitizeUserSettings");
}
if (workspaceReader[0].includes("dropApiKey: false")) {
  throw new Error("hydrating settings from disk must never opt out of dropping the API key");
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
