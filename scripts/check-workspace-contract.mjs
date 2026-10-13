import { readFileSync } from "node:fs";
import { view } from "./lib/source-view.mjs";

/**
 * 本地工作区契约检查。
 *
 * 这套检查存在的理由：密钥曾经放在 macOS 钥匙串里，而钥匙串**每次读取**都弹
 * 授权框要求密码 —— 于是「打开软件先输一次密码」。改成工作区内的 0600 文件
 * 之后，这个方向必须被钉住，否则很容易在后续重构里不知不觉退回钥匙串。
 *
 * 同时钉住几个曾经真实出过问题的点：
 * - 工作区 JSON 通道必须支持**多级** key（assist-history 一直是多级的，
 *   旧校验直接拒绝，历史因此只活在内存里，重启即丢）；
 * - 设置与密钥文件都必须剥掉 API Key，用户能直接打开 settings.json 检查；
 * - 导入的 PDF 必须真的复制进工作区，而不是只记一条原路径。
 */

const commands = view(readFileSync("src-tauri/src/tauri_commands.rs", "utf8"));
const workspace = view(readFileSync("src-tauri/src/workspace.rs", "utf8"));
const mainRs = readFileSync("src-tauri/src/main.rs", "utf8");
const cargoToml = readFileSync("src-tauri/Cargo.toml", "utf8");
const app = view(readFileSync("src/App.tsx", "utf8"));
const settings = view(readFileSync("src/services/userSettings.ts", "utf8"));
const settingsPanel = view(readFileSync("src/components/Settings.tsx", "utf8"));
const secretStore = view(readFileSync("src/services/secretStore.ts", "utf8"));
const assistHistory = view(readFileSync("src/services/assistHistory.ts", "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// 1. 密钥不再走钥匙串
// ---------------------------------------------------------------------------

assert(
  cargoToml.includes('keyring = "2.3"'),
  "keyring must stay available for the one-off user-triggered migration",
);
assert(
  commands.includes("pub async fn migrate_keychain_secret"),
  "the Keychain must remain reachable through an explicit, user-triggered migration command",
);
assert(
  /store_secret[\s\S]{0,400}workspace_layout_or_err/.test(commands),
  "store_secret must resolve inside the workspace, never through the Keychain",
);
assert(
  commands.includes("fn store_secret(app: AppHandle") &&
    commands.includes("fn load_secret(app: AppHandle"),
  "secret commands must take the app handle so they can locate the workspace",
);
assert(
  !/fn store_secret\(account: String/.test(commands) &&
    !/fn load_secret\(account: String/.test(commands),
  "secret commands must not fall back to a Keychain-only signature",
);
// 启动流程绝不能碰钥匙串：只有用户点按钮才会调 migrate。
assert(
  !app.includes("migrateKeychainSecret"),
  "startup must never touch the Keychain; migration is user-triggered only",
);
assert(
  settingsPanel.includes("migrateKeychainSecret"),
  "the Settings panel must expose the explicit Keychain migration",
);
assert(
  !secretStore.includes("keychain"),
  "the secret store front-end must not talk to the Keychain on its own",
);

// ---------------------------------------------------------------------------
// 2. 密钥文件权限
// ---------------------------------------------------------------------------

assert(
  workspace.includes("from_mode(0o600)"),
  "the secrets file must be 0600 on unix",
);
assert(
  workspace.includes("from_mode(0o700)"),
  "the workspace directories must be 0700 on unix",
);
assert(
  commands.includes("write_secrets_file"),
  "secrets must go through a dedicated writer",
);
assert(
  /fn write_secrets_file[\s\S]{0,900}std::fs::rename/.test(commands),
  "secrets must be written via temp file + rename so a crash cannot corrupt the key",
);

// ---------------------------------------------------------------------------
// 3. 设置文件剥密钥
// ---------------------------------------------------------------------------

assert(
  settings.includes('const persisted = { ...next, aiApiKey: "" };'),
  "saveUserSettings must strip API keys before writing local settings",
);
assert(
  /async function saveUserSettingsToWorkspace[\s\S]{0,400}const persisted = \{ \.\.\.next, aiApiKey: "" \};/.test(
    settings,
  ),
  "the workspace settings writer must strip API keys too",
);
assert(
  /loadUserSettingsFromWorkspace[\s\S]{0,1200}return sanitizeUserSettings\(data\)/.test(settings),
  "hydrating from the workspace must scrub any persisted secret",
);
assert(
  !/loadUserSettingsFromWorkspace[\s\S]{0,1200}dropApiKey: false/.test(settings),
  "hydrating from disk must never opt out of dropping the API key",
);

// ---------------------------------------------------------------------------
// 4. 工作区 JSON 通道支持多级 key
// ---------------------------------------------------------------------------

assert(
  !commands.includes("app data key must not contain path separators"),
  "the multi-level key rejection must be gone; assist history depends on nested keys",
);
assert(
  workspace.includes("pub fn resolve_in"),
  "workspace paths must be validated in one shared place",
);
assert(
  !/if trimmed\.contains\('\/'\)/.test(workspace),
  "resolve_in must validate segment by segment instead of rejecting every separator",
);
assert(
  workspace.includes('Component::ParentDir') &&
    workspace.includes("must not traverse upwards"),
  "resolve_in must reject upward traversal",
);
assert(
  assistHistory.includes("assist-history/"),
  "assist history keeps writing a nested key",
);

// ---------------------------------------------------------------------------
// 5. 导入的 PDF 真的复制进工作区
// ---------------------------------------------------------------------------

assert(
  commands.includes("pub async fn import_document_to_workspace"),
  "documents must be copyable into the workspace",
);
assert(
  app.includes("importDocumentIntoWorkspace"),
  "the reader must import documents through the workspace",
);
assert(
  /localizeDocumentPath[\s\S]{0,900}return managed \|\| path/.test(app),
  "a failed copy must fall back to the original path instead of dropping the document",
);
assert(
  workspace.includes("fn managed_document_file_name"),
  "managed copies need deterministic names so re-importing is idempotent",
);

// ---------------------------------------------------------------------------
// 6. 命令注册
// ---------------------------------------------------------------------------

for (const command of [
  "workspace_info",
  "set_workspace_root",
  "clear_workspace_cache",
  "import_document_to_workspace",
  "remove_workspace_document",
  "reveal_workspace",
  "migrate_keychain_secret",
]) {
  assert(mainRs.includes(`r0nix::tauri_commands::${command}`), `${command} must be registered`);
}

console.log("workspace-contract: ok");
