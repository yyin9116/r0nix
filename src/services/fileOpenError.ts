/**
 * 打开文件失败时，给用户看什么。
 *
 * ★ 为什么需要这一层：`openFile` 抛出的原始信息是准确的，但对读者**不可行动**。
 * macOS TCC 拦下 `~/Downloads/*` 时，用户看到的是
 *   "PDF.js failed to load the document: failed to open pdf bytes:
 *    Operation not permitted (os error 1)"
 * 它说清了「哪一层失败了」，却没说「你该怎么办」。而这一幕是有解法的：
 * 通过「打开文件」对话框选择的文件会被系统授予访问权（powerbox），
 * 直接恢复上次的路径不会。把这句告诉用户，失败就从死路变成一步操作。
 *
 * ★ 分类只在**字符串**上做，不看 error 的具体类型：
 * 这条错误跨了三层（Rust io::Error → Tauri invoke 序列化 → pdfApi 再包一层前缀），
 * 到 UI 手上早就是一个 `Error` 的 message。这里匹配的是稳定的 errno 文案，
 * 而不是某一层的包装结构 —— 后者每次有人加一层包装就会静默失效。
 *
 * 纯函数、零 import：可被 `node --experimental-strip-types` 直接加载做行为断言。
 */

export type FileOpenErrorKind =
  | "permission"
  | "missing"
  | "encrypted"
  | "timeout"
  | "unknown";

/** errno 文案。一条错误可能以三种形态到达，所以每条都要匹配到：
 *  ① io::Error 的 Display —— "Permission denied (os error 13)"
 *  ② 只剩裸 errno —— "os error 1"（包装层裁掉了人工可读部分）
 *  ③ io::Error 的 Debug —— `Os { code: 13, kind: PermissionDenied, .. }`
 * 只认 ① 的话，换了序列化方式（Tauri 的 error 序列化到前端是字符串）就会静默退化成
 * unknown —— 而 unknown 给不出动作，等于这一层白做。 */
const PERMISSION_PATTERN =
  /permission denied|operation not permitted|eperm|eacces|permissiondenied|os error (1|13)\b/i;
const MISSING_PATTERN = /no such file|not found|notfound|os error 2\b/i;
const ENCRYPTED_PATTERN = /encrypted|password|passwords are required/i;
const TIMEOUT_PATTERN = /timed? ?out|timeout/i;

export function classifyFileOpenError(message: string): FileOpenErrorKind {
  if (!message) return "unknown";
  if (PERMISSION_PATTERN.test(message)) return "permission";
  if (MISSING_PATTERN.test(message)) return "missing";
  if (ENCRYPTED_PATTERN.test(message)) return "encrypted";
  if (TIMEOUT_PATTERN.test(message)) return "timeout";
  return "unknown";
}

/**
 * 分类后的提示。**每一条都必须给出一个动作**，否则它和原始报错没有区别 ——
 * 「打不开」是用户已经知道的事实，告诉他下一步才是这一层存在的理由。
 *
 * unknown 保留原始信息：那一类没法给出动作，而原始串是报 bug 时唯一的证据。
 */
const HINTS: Record<FileOpenErrorKind, { "zh-CN": string; en: string }> = {
  permission: {
    "zh-CN":
      "没有读取这个文件的权限。macOS 会拦截对「下载」等受保护目录的直接访问 —— 请改用「打开文件」重新选一次，通过对话框选择的文件会被系统授权。",
    en: "Permission denied. macOS blocks direct access to protected folders such as Downloads — use Open File and pick it again; files chosen through the dialog are granted access.",
  },
  missing: {
    "zh-CN": "找不到这个文件，它可能已被移动、重命名或删除。请重新定位后再打开。",
    en: "The file could not be found. It may have been moved, renamed, or deleted — locate it again and reopen.",
  },
  encrypted: {
    "zh-CN":
      "这个 PDF 需要密码才能打开，当前版本还不支持加密文档。请先用其他工具解密，或改开一份未加密的副本。",
    en: "This PDF is password-protected; encrypted documents are not supported yet. Decrypt it with another tool, or reopen an unencrypted copy.",
  },
  timeout: {
    "zh-CN": "读取超时，文件可能过大或所在磁盘响应缓慢。请稍后再试一次。",
    en: "Reading timed out. The file may be very large or on a slow disk — try again.",
  },
  unknown: {
    "zh-CN": "打开失败：",
    en: "Failed to open: ",
  },
};

export function describeFileOpenError(error: unknown, language: string): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const kind = classifyFileOpenError(message);
  const hint = HINTS[kind][language === "zh-CN" ? "zh-CN" : "en"];
  return kind === "unknown" ? `${hint}${message || "unknown error"}` : hint;
}
