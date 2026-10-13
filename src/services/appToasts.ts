import type { AppLanguage } from "./userSettings.ts";

/**
 * 应用级 toast / 状态提示文案 —— 「右下角那个小黑条」的唯一来源。
 *
 * ## 为什么单独成文件
 *
 * 这些文案原先全部硬编码在 `App.tsx` 的各个 `updateBusyMessage(...)` 调用点里，
 * 英文为主、中文界面下直接漏出 "Opening PDF..."（2026-10-08 实测）。
 * 补i18n 时如果就地加 `settings.language === "zh-CN" ? ... : ...` 三元，
 * 就有 40+ 处这样的分支散在 1500 行组件里 —— 那不是 i18n，只是把硬编码换成更长的硬编码。
 *
 * 所以规则是：**新增的用户可见提示一律先来这里加一条**，不许在调用点写字面量。
 * `scripts/check-app-toast-contract.mjs` 把这条规则钉住。
 *
 * ## 参数化文案为什么用函数而不是模板串
 *
 * 用 `${count} documents` 这种模板串拼一遍再塞进字典，就得在调用点做
 * `dict.x.replace(...)`，可读性反而更差。直接给函数，调用点自解释：
 * `toast.importedDocuments({ count, copied })`。
 */

export interface ToastParams {
  [key: string]: string | number;
}

export type ToastTemplate<P extends ToastParams = ToastParams> = (params: P) => string;

/** 占位符替换：`{name}`。找不到参数时保留原样，便于一眼看出漏传。 */
function interpolate(template: string, params: ToastParams): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match
  );
}

/** 把 {a} 占位符式文案升级成函数式，省掉调用点的 replace。 */
function message(template: string): ToastTemplate {
  return (params) => interpolate(template, params);
}

export interface AppToasts {
  /** 本地数据读取异常（localStore 的版本护栏触发）。 */
  localDataReadIssue: ToastTemplate<{ key: string }>;
  localDataWriteIssue: ToastTemplate<{ key: string }>;
  collectionExists: string;

  openingPdf: string;
  openingMarkdown: string;
  openFileFailed: ToastTemplate<{ message: string }>;

  dropUnsupportedFile: string;

  noDownloadUrl: string;
  downloadingPdf: string;
  downloadingResource: string;
  downloaded: ToastTemplate<{ fileName: string }>;
  downloadCancelled: string;
  saved: ToastTemplate<{ fileName: string }>;
  downloadFailed: ToastTemplate<{ message: string }>;
  downloadingPdfFromUrl: string;

  scanningFolder: string;
  noDocumentsInFolder: string;
  importedDocuments: ToastTemplate<{ count: number; copied: string }>;
  importFailed: ToastTemplate<{ message: string }>;

  externalLinkHttpOnly: string;
  externalLinkFailed: ToastTemplate<{ message: string }>;

  movedToTrash: string;
  permanentlyDeleted: ToastTemplate<{ count: number }>;
  restoredFromTrash: ToastTemplate<{ count: number }>;

  nothingToExport: string;
  exportCancelled: string;
  exported: ToastTemplate<{ count: number }>;
  exportFailed: ToastTemplate<{ message: string }>;

  markdownSaved: string;
  markdownSaveFailed: ToastTemplate<{ message: string }>;

  /** 标签页内容懒加载时的占位（Suspense fallback）。 */
  loadingView: string;
}

const ZH_CN: AppToasts = {
  localDataReadIssue: message("本地数据读取异常：{key}，已保留原始数据。"),
  localDataWriteIssue: message("本地数据写入失败：{key}，已保留旧数据。"),
  collectionExists: "集合已存在",

  openingPdf: "正在打开 PDF…",
  openingMarkdown: "正在打开 Markdown…",
  openFileFailed: message("打开失败：{message}"),

  dropUnsupportedFile: "只支持拖入 PDF 或 Markdown 文件。",

  noDownloadUrl: "没有可下载的地址",
  downloadingPdf: "正在下载 PDF…",
  downloadingResource: "正在下载资源…",
  downloaded: message("已下载 {fileName}"),
  downloadCancelled: "已取消下载",
  saved: message("已保存 {fileName}"),
  downloadFailed: message("下载失败：{message}"),
  downloadingPdfFromUrl: "正在下载 PDF…",

  scanningFolder: "正在扫描文件夹…",
  noDocumentsInFolder: "该文件夹里没有可导入的文档",
  importedDocuments: message("已导入 {count} 份文档{copyied}"),
  importFailed: message("导入失败：{message}"),

  externalLinkHttpOnly: "只能用浏览器打开 HTTP(S) 链接",
  externalLinkFailed: message("打开外部链接失败：{message}"),

  movedToTrash: "已移到废纸篓",
  permanentlyDeleted: message("已永久删除 {count} 份文档"),
  restoredFromTrash: message("已从废纸篓恢复 {count} 份文档"),

  nothingToExport: "没有可导出的内容",
  exportCancelled: "已取消导出",
  exported: message("已导出 {count} 项"),
  exportFailed: message("导出失败：{message}"),

  markdownSaved: "Markdown 已保存",
  markdownSaveFailed: message("Markdown 保存失败：{message}"),

  loadingView: "正在加载视图…",
};

const EN_US: AppToasts = {
  localDataReadIssue: message("Local data read issue: {key}; the original data was preserved."),
  localDataWriteIssue: message("Local data write failed: {key}; the previous value was preserved."),
  collectionExists: "Collection already exists",

  openingPdf: "Opening PDF…",
  openingMarkdown: "Opening Markdown…",
  openFileFailed: message("Could not open the file: {message}"),

  dropUnsupportedFile: "Only PDF and Markdown files can be dropped here.",

  noDownloadUrl: "No resource URL to download",
  downloadingPdf: "Downloading PDF…",
  downloadingResource: "Downloading resource…",
  downloaded: message("Downloaded {fileName}"),
  downloadCancelled: "Download cancelled",
  saved: message("Saved {fileName}"),
  downloadFailed: message("Download failed: {message}"),
  downloadingPdfFromUrl: "Downloading PDF…",

  scanningFolder: "Scanning folder…",
  noDocumentsInFolder: "No documents found in folder",
  importedDocuments: message("Imported {count} document(s){copied}"),
  importFailed: message("Import failed: {message}"),

  externalLinkHttpOnly: "Only HTTP(S) links can be opened externally",
  externalLinkFailed: message("Failed to open external link: {message}"),

  movedToTrash: "Moved to Trash",
  permanentlyDeleted: message("Permanently deleted {count} document(s)"),
  restoredFromTrash: message("Restored {count} document(s) from Trash"),

  nothingToExport: "Nothing to export",
  exportCancelled: "Export cancelled",
  exported: message("Exported {count} item(s)"),
  exportFailed: message("Export failed: {message}"),

  markdownSaved: "Markdown saved",
  markdownSaveFailed: message("Markdown save failed: {message}"),

  loadingView: "Loading view…",
};

const TOASTS: Record<AppLanguage, AppToasts> = {
  "zh-CN": ZH_CN,
  "en-US": EN_US,
};

/**
 * 取当前语言的 toast 文案集。
 *
 * 未知语言按 `en-US` 处理（而不是 zh-CN）：设置里的语言只有两个取值，
 * 走到这里说明是旧数据或被手改过，而英文是这条路径上唯一能保证可读的。
 */
export function getAppToasts(language: AppLanguage): AppToasts {
  return TOASTS[language] || TOASTS["en-US"];
}
