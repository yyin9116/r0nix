import { invoke } from "@tauri-apps/api/core";

/**
 * 本地密钥文件 —— AI API Key 的唯一持久化位置。
 *
 * 安全契约（见 userSettings.ts / scripts/test-settings-security.mjs）：
 * - localStorage 永不写入密钥，`saveUserSettings` 落盘前置空；
 * - 本服务是密钥「离开会话」的唯一通道，载体是工作区内的 `config/secrets.json`，
 *   目录 0700、文件 0600，仅当前系统账号可读。
 *
 * ⚠️ 为什么不再用系统钥匙串：macOS Keychain 对**每次读取**都弹授权框要求密码。
 * API Key 每次启动都要读一次，于是「打开软件先输密码」。这条体验不可接受，
 * 用户明确要求改为本地文件存储。若老版本已在钥匙串里存过密钥，可以在设置页
 * 点「从钥匙串导入」搬一次（`migrateKeychainSecret`），启动时不会自动触发。
 *
 * 所有调用在非 Tauri 环境（单测 / 纯浏览器）下降级为 no-op / null，
 * 不抛错 —— 调用方不应为「没有工作区」写分支。
 */

const SECRET_ACCOUNT_API_KEY = "ai-api-key";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 读取本地密钥文件中的 API Key。没存过返回 `null`；任何失败也返回 `null`（静默降级）。 */
export async function loadStoredApiKey(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    const value = await invoke<string | null>("load_secret", { account: SECRET_ACCOUNT_API_KEY });
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    // 文件通道不可用（权限异常等）不应阻塞启动；密钥退化为会话作用域。
    return null;
  }
}

/** 写入本地密钥文件。传空串等价于删除。失败静默（返回 false），不阻塞设置保存流程。 */
export async function storeApiKey(key: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    await invoke("store_secret", { account: SECRET_ACCOUNT_API_KEY, secret: key });
    return true;
  } catch {
    return false;
  }
}
