import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * 工作区设置 hydrate 的行为测试。
 *
 * 覆盖的是**真实**的读写路径：这里把 Tauri 的 `invoke` 替换成一个内存工作区，
 * 于是 loadUserSettingsFromWorkspace / saveUserSettingsToWorkspace 走的是
 * 线上同一套代码，而不是被测对象旁边另写一份逻辑。
 *
 * 这些断言对应的都是真实踩过的坑：
 * - hydrate 必须丢密钥（settings.json 用户能直接打开看）；
 * - 文件版本比应用新时必须整体拒绝，否则旧版会把新字段 sanitize 掉再写回去；
 * - 坏 JSON 不能让应用起不来。
 */

// userSettings 会 import 一整条依赖链（startPage / localStore / workspace），
// 这些相对 import 都不带扩展名。Vite 解析得了，Node 不行 —— 挂一个只补扩展名的
// resolve hook，而不是把被测源码改成 Node 友好的写法。
register(pathToFileURL(new URL("./lib/ts-resolve-hook.mjs", import.meta.url).pathname));


const workspaceFiles = new Map();

// workspace.ts 通过 @tauri-apps/api/core 的 invoke 落盘，这里换成内存实现。
// 必须挂在 `window` 上：真实的 @tauri-apps/api 读的就是 window.__TAURI_INTERNALS__，
// 挂到 globalThis 上会让 isTauriRuntime() 判真、但 invoke 走空，测试就成了假绿。
const invokeCalls = [];
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke(command, args) {
      invokeCalls.push({ command, args });
      if (command === "write_app_data_json") {
        workspaceFiles.set(args.key, args.content);
        return Promise.resolve(undefined);
      }
      if (command === "read_app_data_json") {
        const value = workspaceFiles.get(args.key);
        return Promise.resolve(typeof value === "string" ? value : null);
      }
      return Promise.resolve(null);
    },
  },
  dispatchEvent() {
    return true;
  },
  localStorage: {
    getItem() {
      return null;
    },
    setItem() {
      return true;
    },
    removeItem() {
      return true;
    },
  },
};

const { loadUserSettingsFromWorkspace, saveUserSettingsToWorkspace } = await import(
  "../src/services/userSettings.ts"
);

const baseSettings = {
  aiModelPath: "http://127.0.0.1:4000/v1",
  aiModelName: "gpt-4o-mini",
  aiApiKey: "sk-should-never-hit-disk",
  aiTemperature: 0.4,
};

// ---------------------------------------------------------------------------
// 写：API Key 必须被剥掉
// ---------------------------------------------------------------------------

const writeOk = await saveUserSettingsToWorkspace(baseSettings);
assert.equal(writeOk, true, "writing settings should succeed");
const written = workspaceFiles.get("config/settings.json");
assert.ok(typeof written === "string" && written.length > 0, "settings.json should exist");
assert.ok(
  !written.includes("sk-should-never-hit-disk"),
  `settings.json must never contain the API key, got: ${written}`
);
assert.ok(written.includes('"aiModelName": "gpt-4o-mini"'), "non-secret settings must be written");
assert.ok(written.includes('"aiTemperature": 0.4'), "numeric settings must be written");

// ---------------------------------------------------------------------------
// 读：正常往返，且密钥不回填
// ---------------------------------------------------------------------------

const hydrated = await loadUserSettingsFromWorkspace();
assert.ok(hydrated, "settings.json should hydrate");
assert.equal(hydrated.aiModelName, "gpt-4o-mini");
assert.equal(hydrated.aiTemperature, 0.4);
assert.equal(hydrated.aiApiKey, "", "hydrating must not put the API key back into memory");

// ---------------------------------------------------------------------------
// 读：文件不存在（首次启动）返回 null，交给调用方用默认值
// ---------------------------------------------------------------------------

workspaceFiles.clear();
assert.equal(await loadUserSettingsFromWorkspace(), null, "a missing file must yield null");

// ---------------------------------------------------------------------------
// 读：坏 JSON 不能让应用起不来
// ---------------------------------------------------------------------------

workspaceFiles.set("config/settings.json", "{ this is not json");
assert.equal(
  await loadUserSettingsFromWorkspace(),
  null,
  "a corrupt settings file must degrade to null instead of throwing",
);

// ---------------------------------------------------------------------------
// 读：版本比当前应用新 → 整体拒绝
// ---------------------------------------------------------------------------

workspaceFiles.set(
  "config/settings.json",
  JSON.stringify({ version: 9999, updatedAt: "2099-01-01T00:00:00.000Z", data: { aiModelName: "from-the-future" } })
);
assert.equal(
  await loadUserSettingsFromWorkspace(),
  null,
  "settings written by a newer build must not be hydrated by an older one",
);

// ---------------------------------------------------------------------------
// 读：顶层裸对象（无信封）也要能读，兼容早期格式
// ---------------------------------------------------------------------------

workspaceFiles.set("config/settings.json", JSON.stringify({ aiModelName: "bare", aiTemperature: 0.9 }));
const bare = await loadUserSettingsFromWorkspace();
assert.ok(bare, "a bare object must still hydrate");
assert.equal(bare.aiModelName, "bare");
assert.equal(bare.aiTemperature, 0.9);
assert.equal(bare.aiApiKey, "");

// ---------------------------------------------------------------------------
// 读：残留密钥的历史文件也要被清掉（即使某次写入漏剥了）
// ---------------------------------------------------------------------------

workspaceFiles.set(
  "config/settings.json",
  JSON.stringify({
    version: 4,
    updatedAt: "2026-01-01T00:00:00.000Z",
    data: { aiModelName: "leaky", aiApiKey: "sk-leaked" },
  })
);
const leaky = await loadUserSettingsFromWorkspace();
assert.ok(leaky, "a legacy leaky file must still hydrate");
assert.equal(leaky.aiApiKey, "", "a leaked key on disk must never rehydrate into memory");

// 写入路径必须真的走工作区通道，而不是悄悄退回 localStorage。
assert.ok(
  invokeCalls.some((call) => call.command === "write_app_data_json"),
  "settings must be written through the workspace command",
);

console.log("workspace-settings: ok");
