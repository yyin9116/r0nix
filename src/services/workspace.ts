import { invoke } from "@tauri-apps/api/core";

/**
 * 本地工作区 —— 前端唯一的持久化通道封装。
 *
 * 为什么有这一层：以前设置散在 localStorage、伴读历史散在 app_data_dir 顶层、
 * 密钥在系统钥匙串，三套生命周期、三个失败模式。现在全部收口到工作区目录，
 * 用户能在设置里看到路径、自己备份、整个搬走。
 *
 * ⚠️ 密钥不再走 macOS 钥匙串。钥匙串每次读取都弹授权框要密码，而 API Key
 * 每次启动都要读 —— 结果就是「开软件先输一次密码」。改成本地 0600 文件后
 * 这个循环彻底消失，代价是密钥的防护从系统钥匙串降到目录权限，这正是用户
 * 明确要求的方向。
 *
 * 所有调用在非 Tauri 环境（单测 / 纯浏览器）下降级，不抛错。
 */

export interface WorkspaceInfo {
  root: string;
  configDir: string;
  documentsDir: string;
  libraryDir: string;
  historyDir: string;
  cacheDir: string;
  isCustom: boolean;
  usage: {
    fileCount: number;
    totalBytes: number;
    /** 扫描触顶：面板要如实说「数字偏小」，不能假装精确。 */
    truncated: boolean;
  };
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function fetchWorkspaceInfo(): Promise<WorkspaceInfo | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<WorkspaceInfo>("workspace_info");
  } catch {
    return null;
  }
}

export async function changeWorkspaceRoot(path: string): Promise<WorkspaceInfo | null> {
  if (!isTauriRuntime()) return null;
  return await invoke<WorkspaceInfo>("set_workspace_root", { path });
}

export async function clearWorkspaceCache(): Promise<number> {
  if (!isTauriRuntime()) return 0;
  return await invoke<number>("clear_workspace_cache");
}

export async function revealWorkspace(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return await invoke<string>("reveal_workspace");
}

/**
 * 把 PDF / Markdown 复制一份进工作区，返回工作区内的稳定路径。
 *
 * 资料库导入必须走这里：原件被移动、改名或删除之后，副本仍然能打开。
 * 这就是「本地资料库」和「最近打开列表」的区别 —— 后者只存路径。
 */
export async function importDocumentIntoWorkspace(sourcePath: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<string>("import_document_to_workspace", { sourcePath });
  } catch {
    return null;
  }
}

export async function removeWorkspaceDocument(path: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("remove_workspace_document", { path });
}

/** 工作区 JSON 读写。key 是相对路径（如 `config/settings.json`），越界校验在 Rust 侧。 */
export async function readWorkspaceJson(key: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return await invoke<string | null>("read_app_data_json", { key });
}

export async function writeWorkspaceJson(key: string, content: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("write_app_data_json", { key, content });
}

/**
 * 密钥文件迁移：仅在用户**主动点击**时调用。
 * 启动流程绝不触发 —— 否则又会回到每次启动都要授权。
 */
export async function migrateKeychainSecret(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return await invoke<string | null>("migrate_keychain_secret");
}
