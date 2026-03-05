import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type WheelEvent } from "react";
import { ArrowUpToLine, Bug, ChevronLeft, ChevronRight, FileCode2, FileImage, FileText, Files, FolderOpen, Globe2, Palette, PanelLeft, ScanSearch, Search, Star, StarOff, ZoomIn, ZoomOut } from "lucide-react";
import { OPS, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import * as api from "../services/pdfApi";
import { debugError } from "../services/debugLogger";
import { loadUserSettings, withDefaultDir } from "../services/userSettings";
import type { FavoriteItem } from "../App";
import r0nixIcon from "../assets/r0nix-icon.svg";
import "./PDFViewer.css";

interface PDFViewerProps {
  fileId?: string;
  fallbackFileName: string;
  fallbackPages: number;
  initialViewSnapshot?: {
    lastPage: number;
    totalPages: number;
    zoom: number;
    capturedAt: string;
    autoFit?: boolean;
    scrollTopRatio?: number;
  };
  recentFiles: Array<{
    name: string;
    path: string;
    lastOpenedAt?: string;
    totalReadSeconds?: number;
    sessions?: Array<{
      openedAt: string;
      closedAt: string;
      durationSec: number;
      endPage?: number;
      endZoom?: number;
      endAutoFit?: boolean;
      endScrollTopRatio?: number;
    }>;
    missing?: boolean;
    snapshot?: {
      lastPage: number;
      totalPages: number;
      zoom: number;
      capturedAt: string;
      autoFit?: boolean;
      scrollTopRatio?: number;
    };
  }>;
  favorites: FavoriteItem[];
  language: "zh" | "en";
  onLanguageChange: (lang: "zh" | "en") => void;
  onOpenFile: () => void;
  onOpenRecentFile: (path: string) => void;
  onContinueRecentSession?: (
    path: string,
    session: {
      endPage: number;
      endZoom?: number;
      endAutoFit?: boolean;
      endScrollTopRatio?: number;
    }
  ) => void;
  onRelocateRecentFile?: (path: string) => void;
  onOpenLink: (url: string, options?: { forceExternal?: boolean }) => void;
  onOpenFavorite: (favorite: FavoriteItem) => void;
  onAddWebFavorite: (url: string, title: string) => void;
  onAddPdfFavorite: (path: string, name: string) => void;
  onPreviewExportedImage?: (payload: {
    title: string;
    mimeType: "image/svg+xml" | "image/png" | "image/jpeg";
    dataUrl: string;
    sourceType: string;
    vectorRatio?: number;
    vectorGrade?: "A" | "B" | "C" | "D";
    imageCount?: number;
    vectorCount?: number;
  }) => void;
  onRemoveFavorite: (favoriteId: string) => void;
  onReorderFavorites: (sourceId: string, targetId: string) => void;
  onViewSnapshot?: (snapshot: {
    lastPage: number;
    totalPages: number;
    zoom: number;
    autoFit?: boolean;
    scrollTopRatio?: number;
  }) => void;
}

type HomeRecentItem = PDFViewerProps["recentFiles"][number];
type PdfReadState = "done" | "reading" | "unread" | "missing";
type RecentFilter = "all" | "reading" | "done";
type RecentSort = "recent" | "progress";

interface PageSize {
  width: number;
  height: number;
}

interface TileReq {
  pageNo: number;
  key: string;
  viewport: api.TileViewport;
}

interface MenuState {
  x: number;
  y: number;
  kind: "viewer" | "image";
  pageNo: number;
  imageBase64?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageType?: string;
}

interface SnapshotDraft {
  pageNo: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  dragging: boolean;
}

interface SnapshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type SnapshotHandle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface SnapshotEditState {
  pageNo: number;
  handle: SnapshotHandle;
  startX: number;
  startY: number;
  boundsWidth: number;
  boundsHeight: number;
  origin: SnapshotRect;
}

interface LinkRegion {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  url?: string;
  pageNo?: number;
}

interface DebugImageRegion {
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
}

interface TextSelectionMarker {
  pageNo: number;
  top: number;
  height: number;
}

const BASE_W = 595;
const BASE_H = 842;
const OVERSCAN = 900;
const NEIGHBOR_PAGES = 1;
const DRAG_TH = 6;
const VIEW_BG_KEY = "pdf_reader_view_bg";
const VIEW_BG_COLORS = ["#f4f4f5", "#eceff3", "#f3efe7", "#dce7f6"];
const THUMB_SIDEBAR_KEY = "pdf_reader_thumb_sidebar_open";
const IDENTITY_MATRIX: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

function getInitialViewerBgIndex() {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem(VIEW_BG_KEY);
  const n = Number.parseInt(raw || "0", 10);
  if (Number.isNaN(n) || n < 0 || n >= VIEW_BG_COLORS.length) return 0;
  return n;
}

function getInitialThumbSidebarOpen() {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(THUMB_SIDEBAR_KEY) !== "0";
}

const TXT = {
  zh: {
    open: "打开",
    jump: "跳页",
    fit: "适应宽度",
    prev: "上一页",
    next: "下一页",
    lang: "语言",
    zhName: "中文",
    enName: "English",
    rightZoom: "按住右键 + 滚轮，以焦点缩放",
    homeTitle: "r0nix",
    homeDesc: "r0nix: 打开 PDF 后可预览、缩放并导出 PNG/SVG。",
    recent: "最近文件",
    noRecent: "暂无最近文件",
    recentMissing: "路径失效",
    recentSnapshot: (page: number, total: number, zoom: number) => `快照: 第 ${page}/${total} 页 · ${zoom}%`,
    recentLastRead: (timeText: string) => `上次阅读: ${timeText}`,
    recentReadDuration: (timeText: string) => `累计阅读: ${timeText}`,
    recentSessions: (text: string) => `最近记录: ${text}`,
    stateDone: "已读完",
    stateReading: "阅读中",
    stateUnread: "未读",
    stateMissing: "路径失效",
    recentFilterAll: "全部",
    recentFilterReading: "阅读中",
    recentFilterDone: "已读完",
    recentSortRecent: "按最近阅读",
    recentSortProgress: "按阅读进度",
    noRecentMatch: "当前筛选条件下暂无文件",
    locateFile: "重新定位",
    continueReading: "继续阅读",
    needOpen: "请先打开 PDF 文件",
    snapTip: "拖动框选区域并可调整，点击“导出截图”保存",
    snapReady: "框选完成，可继续调整后导出",
    snapSmall: "框选区域太小，请重新框选",
    snapBusy: "正在导出截图...",
    snapExport: "导出截图",
    snapReset: "重新框选",
    expPngFail: "导出 PNG 失败",
    expSvgFail: "导出 SVG 失败",
    formatInvalid: "格式无效",
    exportDone: "导出完成",
    previewOpened: "已在新标签页打开预览",
    vectorWarn: "当前页包含位图元素，截图 SVG 可能混合矢量与位图",
    mPrev: "上一页",
    mNext: "下一页",
    mTop: "回到顶部",
    mIn: "放大",
    mOut: "缩小",
    mPng: "导出当前页 PNG",
    mSvg: "导出当前页 SVG",
    mSnap: "导出 SVG 截图",
    grpNav: "导航",
    grpZoom: "缩放",
    grpExport: "导出",
    viewerMenu: "页面操作",
    imgTitle: "图片导出",
    imgExport: "选择格式并导出...",
    imgPng: "快速导出 PNG",
    imgJpg: "快速导出 JPG",
    imgSvg: "快速导出 SVG",
    imgPreview: "新标签页预览导出",
    imgSource: (tp: string) => `源格式: ${tp}`,
    debugType: "图片类型标记",
    statusReady: "请打开 PDF 开始浏览",
    statusIdle: "滚轮滚动页面，按住右键+滚轮缩放，右键打开菜单",
    statusHint: "操作提示",
    jumpTitle: "跳转到页码",
    jumpConfirm: "确定",
    cancel: "取消",
    pageLabel: (cur: number, max: number) => `第 ${cur} / ${max} 页`,
    goPage: (max: number, cur: number) => `跳转页码 (1-${max})，当前 ${cur}`,
    browserModePngUnavailable: "网页调试模式下暂不支持当前页导出 PNG",
    browserModePngFailed: "导出 PNG 失败",
    browserModePageSvgUnavailable: "网页调试模式暂不支持当前页矢量 SVG 导出",
    browserModeSnapshotSvgUnavailable: "网页调试模式暂不支持截图矢量 SVG 导出",
    svgQuality: (grade: string, ratioText: string, imageCount: number) =>
      `SVG 质量 ${grade} · 矢量占比 ${ratioText} · 位图 ${imageCount}`,
    homeTips: [
      "滚轮滚动页面，右键拖动可平移视图",
      "按住右键 + 滚轮可围绕鼠标焦点缩放",
      "右键菜单可直接导出页面 PNG / SVG",
      "框选截图支持二次调整后导出",
      "按住 Ctrl 点击 PDF 链接可在系统浏览器打开",
    ],
    imageSvgHintDirect: "位图可直接导出 SVG，截图用于无法直接矢量导出",
    imageSvgHintUnknown: "无法识别源格式，建议使用截图",
    thumbSidebar: "缩略图侧栏",
    snapshotExit: "退出框选模式",
    homeAddressPlaceholder: "输入网址，例如 https://example.com",
    homeAddressOpen: "打开网站",
    homeAddressHint: "支持直接输入网址，未包含协议时会自动补全 https://",
    homeFavoriteTitle: "快捷标签与收藏",
    homeNoFavorite: "还没有收藏项，可从网址栏或最近文件中添加。",
    homeAddressTitle: "网址导航",
    homeAddFavorite: "收藏",
    homeSaved: "已收藏",
    toggleBackground: "切换背景色",
    pagesTitle: "页面",
    jumpPageChip: (page: number) => `回到第${page}页`,
  },
  en: {
    open: "Open",
    jump: "Jump",
    fit: "Fit Width",
    prev: "Prev",
    next: "Next",
    lang: "Language",
    zhName: "Chinese",
    enName: "English",
    rightZoom: "Hold right button + wheel to zoom at pointer",
    homeTitle: "r0nix",
    homeDesc: "r0nix: open a PDF to preview, zoom and export PNG/SVG.",
    recent: "Recent",
    noRecent: "No recent files",
    recentMissing: "Path unavailable",
    recentSnapshot: (page: number, total: number, zoom: number) => `Snapshot: page ${page}/${total} · ${zoom}%`,
    recentLastRead: (timeText: string) => `Last read: ${timeText}`,
    recentReadDuration: (timeText: string) => `Read time: ${timeText}`,
    recentSessions: (text: string) => `Recent sessions: ${text}`,
    stateDone: "Completed",
    stateReading: "Reading",
    stateUnread: "Unread",
    stateMissing: "Missing",
    recentFilterAll: "All",
    recentFilterReading: "Reading",
    recentFilterDone: "Completed",
    recentSortRecent: "Sort: last read",
    recentSortProgress: "Sort: progress",
    noRecentMatch: "No files match this filter",
    locateFile: "Locate",
    continueReading: "Resume",
    needOpen: "Open a PDF first",
    snapTip: "Drag to select area, adjust if needed, then click Export Snapshot",
    snapReady: "Selection ready, adjust if needed then export",
    snapSmall: "Selection is too small",
    snapBusy: "Exporting snapshot...",
    snapExport: "Export Snapshot",
    snapReset: "Reselect",
    expPngFail: "Export PNG failed",
    expSvgFail: "Export SVG failed",
    formatInvalid: "Invalid format",
    exportDone: "Export done",
    previewOpened: "Preview opened in a new tab",
    vectorWarn: "This page includes raster elements, snapshot SVG may mix vector and bitmap",
    mPrev: "Previous",
    mNext: "Next",
    mTop: "Back to top",
    mIn: "Zoom In",
    mOut: "Zoom Out",
    mPng: "Export page PNG",
    mSvg: "Export page SVG",
    mSnap: "Export SVG snapshot",
    grpNav: "Navigation",
    grpZoom: "Zoom",
    grpExport: "Export",
    viewerMenu: "Page Actions",
    imgTitle: "Image Export",
    imgExport: "Choose format and export...",
    imgPng: "Quick export PNG",
    imgJpg: "Quick export JPG",
    imgSvg: "Quick export SVG",
    imgPreview: "Preview export in new tab",
    imgSource: (tp: string) => `Source: ${tp}`,
    debugType: "Image Type Tags",
    statusReady: "Open a PDF to start",
    statusIdle: "Wheel to scroll, hold right mouse + wheel to zoom, right click for menu",
    statusHint: "Tips",
    jumpTitle: "Go to page",
    jumpConfirm: "Confirm",
    cancel: "Cancel",
    pageLabel: (cur: number, max: number) => `Page ${cur} / ${max}`,
    goPage: (max: number, cur: number) => `Go to page (1-${max}), current ${cur}`,
    browserModePngUnavailable: "Page PNG export is unavailable in browser mode",
    browserModePngFailed: "PNG export failed",
    browserModePageSvgUnavailable: "Vector SVG export is only available in desktop mode",
    browserModeSnapshotSvgUnavailable: "Snapshot SVG export is only available in desktop mode",
    svgQuality: (grade: string, ratioText: string, imageCount: number) =>
      `SVG quality ${grade} · vector ${ratioText} · images ${imageCount}`,
    homeTips: [
      "Scroll with wheel, drag with right mouse button to pan.",
      "Hold right mouse + wheel to zoom around pointer.",
      "Right click for page-level PNG/SVG exports.",
      "Snapshot area can be adjusted before exporting.",
      "Hold Ctrl and click a PDF link to open it in your browser.",
    ],
    imageSvgHintDirect: "Bitmap can export SVG directly; use snapshot only when direct vector export is unavailable",
    imageSvgHintUnknown: "Source unknown, snapshot is recommended",
    thumbSidebar: "Thumbnail sidebar",
    snapshotExit: "Exit snapshot mode",
    homeAddressPlaceholder: "Enter a URL, e.g. https://example.com",
    homeAddressOpen: "Open",
    homeAddressHint: "Type a URL directly. https:// is auto-added when omitted.",
    homeFavoriteTitle: "Quick tabs & favorites",
    homeNoFavorite: "No favorites yet. Add from URL bar or recent files.",
    homeAddressTitle: "Web Address",
    homeAddFavorite: "Save",
    homeSaved: "Saved",
    toggleBackground: "Toggle background",
    pagesTitle: "Pages",
    jumpPageChip: (page: number) => `Jump p${page}`,
  },
} as const;

function fileBase(name: string) {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

function normalizeUrl(raw: string) {
  const value = raw.trim();
  if (!value) return "";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) return value;
  return `https://${value}`;
}

function errText(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function b64ToBytes(b64: string) {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function analyzeSvgQuality(svg: string) {
  const textCount = (svg.match(/<text[\s>]/gi) || []).length;
  const pathCount = (svg.match(/<path[\s>]/gi) || []).length;
  const imageCount = (svg.match(/<image[\s>]/gi) || []).length;
  const shapeCount =
    (svg.match(/<(rect|circle|ellipse|polygon|polyline|line)[\s>]/gi) || []).length;
  const vectorCount = textCount + pathCount + shapeCount;
  const total = vectorCount + imageCount;
  const vectorRatio = total > 0 ? vectorCount / total : 1;
  const grade: "A" | "B" | "C" | "D" =
    vectorRatio >= 0.95 ? "A" : vectorRatio >= 0.75 ? "B" : vectorRatio >= 0.45 ? "C" : "D";
  return { textCount, pathCount, imageCount, shapeCount, vectorCount, vectorRatio, grade };
}

type AffineMatrix = [number, number, number, number, number, number];

function multiplyMatrix(left: AffineMatrix, right: AffineMatrix): AffineMatrix {
  const [a1, b1, c1, d1, e1, f1] = left;
  const [a2, b2, c2, d2, e2, f2] = right;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function parseTransformMatrix(raw: string): AffineMatrix {
  const identity: AffineMatrix = [1, 0, 0, 1, 0, 0];
  if (!raw.trim()) return identity;
  let out = identity;
  const transformRegex = /([a-zA-Z]+)\(([^)]*)\)/g;
  let match: RegExpExecArray | null = transformRegex.exec(raw);
  while (match) {
    const [, kind, valuesRaw] = match;
    const values = valuesRaw
      .trim()
      .split(/[\s,]+/)
      .map((value) => Number.parseFloat(value))
      .filter((value) => Number.isFinite(value));
    let next: AffineMatrix = identity;
    if (kind === "matrix" && values.length >= 6) {
      next = [values[0], values[1], values[2], values[3], values[4], values[5]];
    } else if (kind === "translate" && values.length >= 1) {
      next = [1, 0, 0, 1, values[0], values[1] ?? 0];
    } else if (kind === "scale" && values.length >= 1) {
      const sx = values[0];
      const sy = values[1] ?? sx;
      next = [sx, 0, 0, sy, 0, 0];
    } else if (kind === "rotate" && values.length >= 1) {
      const rad = (values[0] * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      if (values.length >= 3) {
        const cx = values[1];
        const cy = values[2];
        next = multiplyMatrix(
          multiplyMatrix([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]),
          [1, 0, 0, 1, -cx, -cy]
        );
      } else {
        next = [cos, sin, -sin, cos, 0, 0];
      }
    } else if (kind === "skewX" && values.length >= 1) {
      next = [1, 0, Math.tan((values[0] * Math.PI) / 180), 1, 0, 0];
    } else if (kind === "skewY" && values.length >= 1) {
      next = [1, Math.tan((values[0] * Math.PI) / 180), 0, 1, 0, 0];
    }
    out = multiplyMatrix(out, next);
    match = transformRegex.exec(raw);
  }
  return out;
}

function applyMatrixToPoint(matrix: AffineMatrix, x: number, y: number) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

function formatSvgNum(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(3)).toString() : "0";
}

function extractImageAreaSvg(svg: string): string | null {
  if (!svg.trim()) return null;
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return null;
  const images = Array.from(root.querySelectorAll("image"));
  if (images.length === 0) return null;

  const keep = new Set<Element>();
  keep.add(root);
  for (const image of images) {
    let node: Element | null = image;
    while (node) {
      keep.add(node);
      if (node === root) break;
      node = node.parentElement;
    }
  }
  for (const node of Array.from(root.querySelectorAll("*"))) {
    if (!keep.has(node)) node.remove();
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const image of images) {
    let matrix: AffineMatrix = [1, 0, 0, 1, 0, 0];
    const chain: Element[] = [];
    let node: Element | null = image;
    while (node && node !== root) {
      chain.push(node);
      node = node.parentElement;
    }
    chain.reverse();
    for (const element of chain) {
      const transform = element.getAttribute("transform");
      if (transform) {
        matrix = multiplyMatrix(matrix, parseTransformMatrix(transform));
      }
    }

    const x = Number.parseFloat(image.getAttribute("x") || "0");
    const y = Number.parseFloat(image.getAttribute("y") || "0");
    const w = Number.parseFloat(image.getAttribute("width") || "0");
    const h = Number.parseFloat(image.getAttribute("height") || "0");
    if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0) continue;
    const points = [
      applyMatrixToPoint(matrix, x, y),
      applyMatrixToPoint(matrix, x + w, y),
      applyMatrixToPoint(matrix, x, y + h),
      applyMatrixToPoint(matrix, x + w, y + h),
    ];
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    root.setAttribute(
      "viewBox",
      `${formatSvgNum(minX)} ${formatSvgNum(minY)} ${formatSvgNum(width)} ${formatSvgNum(height)}`
    );
    root.setAttribute("width", formatSvgNum(width));
    root.setAttribute("height", formatSvgNum(height));
  }

  return new XMLSerializer().serializeToString(doc);
}

function detectImageTypeFromBase64(b64: string): string {
  try {
    const bytes = b64ToBytes(b64.slice(0, 96));
    if (bytes.length >= 8) {
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "PNG";
      if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "JPG";
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "GIF";
      if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "BMP";
      if (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      ) {
        return "WEBP";
      }
    }
  } catch {
    // ignore decode errors
  }
  return "UNKNOWN";
}

function normalizeImageType(raw: string): string {
  const value = raw.trim().toUpperCase();
  if (!value) return "UNKNOWN";
  if (value === "JPEG" || value === "JPE" || value === "PJPEG") return "JPG";
  if (value === "SVG+XML") return "SVG";
  return value;
}

function detectImageTypeFromHref(rawHref: string): string {
  const href = rawHref.trim();
  if (!href) return "UNKNOWN";
  const dataMatch = href.match(/^data:image\/([a-zA-Z0-9.+-]+)[;,]/i);
  if (dataMatch?.[1]) return normalizeImageType(dataMatch[1]);
  const cleaned = href.split(/[?#]/)[0].toLowerCase();
  const extMatch = cleaned.match(/\.([a-z0-9]+)$/);
  if (!extMatch?.[1]) return "UNKNOWN";
  return normalizeImageType(extMatch[1]);
}

function readSvgHref(node: Element): string {
  return (
    node.getAttribute("href")
    || node.getAttributeNS("http://www.w3.org/1999/xlink", "href")
    || node.getAttribute("xlink:href")
    || ""
  );
}

function findSvgElementById(root: Element, id: string): Element | null {
  if (!id) return null;
  const all = root.querySelectorAll("[id]");
  for (const node of all) {
    if (node.getAttribute("id") === id) return node;
  }
  return null;
}

function resolveSvgImageType(node: Element, root: Element, visited = new Set<string>()): string {
  const href = readSvgHref(node);
  const direct = detectImageTypeFromHref(href);
  if (direct !== "UNKNOWN") return direct;

  if (href.startsWith("#")) {
    const refId = href.slice(1).trim();
    if (refId && !visited.has(refId)) {
      visited.add(refId);
      const refNode = findSvgElementById(root, refId);
      if (refNode) {
        const refType = resolveSvgImageType(refNode, root, visited);
        if (refType !== "UNKNOWN") return refType;
      }
    }
  }

  const childImage = node.querySelector("image");
  if (childImage && childImage !== node) {
    const childType = resolveSvgImageType(childImage, root, visited);
    if (childType !== "UNKNOWN") return childType;
  }

  const html = node.outerHTML || "";
  const dataMatch = html.match(/data:image\/([a-zA-Z0-9.+-]+)[;,]/i);
  if (dataMatch?.[1]) return normalizeImageType(dataMatch[1]);
  return "UNKNOWN";
}

function collectSvgImageTypeHints(root: Element): string[] {
  const set = new Set<string>();
  for (const image of Array.from(root.querySelectorAll("image"))) {
    const tp = resolveSvgImageType(image, root);
    if (tp !== "UNKNOWN") set.add(tp);
  }
  if (set.size > 0) return Array.from(set);
  const html = root.outerHTML || "";
  const matches = html.matchAll(/data:image\/([a-zA-Z0-9.+-]+)[;,]/gi);
  for (const match of matches) {
    const raw = match[1];
    if (!raw) continue;
    const tp = normalizeImageType(raw);
    if (tp !== "UNKNOWN") set.add(tp);
  }
  return Array.from(set);
}

function dedupeDebugRegions(regions: DebugImageRegion[]): DebugImageRegion[] {
  const seen = new Set<string>();
  const out: DebugImageRegion[] = [];
  for (const region of regions) {
    const key = [
      region.label,
      Math.round(region.left),
      Math.round(region.top),
      Math.round(region.width),
      Math.round(region.height),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(region);
  }
  return out;
}

function collectSvgImageRegions(
  svg: string,
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] }
): DebugImageRegion[] {
  if (!svg.trim()) return [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return [];
  const images = Array.from(root.querySelectorAll("image"));
  if (images.length === 0) return [];
  const typeHints = collectSvgImageTypeHints(root);

  const regions: DebugImageRegion[] = [];
  for (const image of images) {
    let matrix: AffineMatrix = [1, 0, 0, 1, 0, 0];
    const chain: Element[] = [];
    let node: Element | null = image;
    while (node && node !== root) {
      chain.push(node);
      node = node.parentElement;
    }
    chain.reverse();
    for (const element of chain) {
      const transform = element.getAttribute("transform");
      if (transform) {
        matrix = multiplyMatrix(matrix, parseTransformMatrix(transform));
      }
    }

    const x = Number.parseFloat(image.getAttribute("x") || "0");
    const y = Number.parseFloat(image.getAttribute("y") || "0");
    const width = Number.parseFloat(image.getAttribute("width") || "0");
    const height = Number.parseFloat(image.getAttribute("height") || "0");
    if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) continue;

    const points = [
      applyMatrixToPoint(matrix, x, y),
      applyMatrixToPoint(matrix, x + width, y),
      applyMatrixToPoint(matrix, x, y + height),
      applyMatrixToPoint(matrix, x + width, y + height),
    ];
    const viewPoints = points.map((point) => viewport.convertToViewportPoint(point.x, point.y));
    const minX = Math.min(...viewPoints.map((point) => Number(point[0]) || 0));
    const maxX = Math.max(...viewPoints.map((point) => Number(point[0]) || 0));
    const minY = Math.min(...viewPoints.map((point) => Number(point[1]) || 0));
    const maxY = Math.max(...viewPoints.map((point) => Number(point[1]) || 0));
    const boxWidth = maxX - minX;
    const boxHeight = maxY - minY;
    if (!Number.isFinite(boxWidth) || !Number.isFinite(boxHeight)) continue;
    if (boxWidth < 6 || boxHeight < 6) continue;

    const directFormat = resolveSvgImageType(image, root);
    const format = directFormat !== "UNKNOWN"
      ? directFormat
      : (typeHints.length === 1 ? typeHints[0] : "UNKNOWN");
    regions.push({
      left: minX,
      top: minY,
      width: boxWidth,
      height: boxHeight,
      label: format,
    });
  }

  return dedupeDebugRegions(regions);
}

function mulMatrix(
  m1: [number, number, number, number, number, number],
  m2: [number, number, number, number, number, number]
): [number, number, number, number, number, number] {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function mapPoint(matrix: [number, number, number, number, number, number], x: number, y: number) {
  const [a, b, c, d, e, f] = matrix;
  return {
    x: a * x + c * y + e,
    y: b * x + d * y + f,
  };
}

function imageOpLabel(op: number): string | null {
  if (op === OPS.paintInlineImageXObject || op === OPS.paintInlineImageXObjectGroup) return "INLINE";
  if (op === OPS.paintImageXObject || op === OPS.paintImageXObjectRepeat) return "IMAGE";
  if (
    op === OPS.paintImageMaskXObject ||
    op === OPS.paintImageMaskXObjectGroup ||
    op === OPS.paintImageMaskXObjectRepeat ||
    op === OPS.paintSolidColorImageMask
  ) {
    return "MASK";
  }
  if (op === OPS.paintXObject) return "XOBJ";
  return null;
}

async function saveBytes(bytes: Uint8Array, defaultName: string, filter: string, exts: string[], defaultDir = "") {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const path = await save({ defaultPath: withDefaultDir(defaultName, defaultDir), filters: [{ name: filter, extensions: exts }] });
  if (path) await writeFile(path, bytes);
}

function pickTiles(tiles: api.TileReadyPayload[], scale: number) {
  if (tiles.length === 0) return tiles;
  const bigger = tiles.filter((t) => t.zoom >= scale - 0.001);
  const z = bigger.length > 0 ? Math.min(...bigger.map((t) => t.zoom)) : Math.max(...tiles.map((t) => t.zoom));
  return tiles.filter((t) => Math.abs(t.zoom - z) < 0.001);
}

function clampMenuPos(x: number, y: number, width = 232, height = 320) {
  const maxX = Math.max(12, window.innerWidth - width);
  const maxY = Math.max(12, window.innerHeight - height);
  return { x: Math.max(12, Math.min(x, maxX)), y: Math.max(12, Math.min(y, maxY)) };
}

function toSnapshotRect(draft: SnapshotDraft): SnapshotRect {
  const x = Math.min(draft.startX, draft.endX);
  const y = Math.min(draft.startY, draft.endY);
  const width = Math.abs(draft.endX - draft.startX);
  const height = Math.abs(draft.endY - draft.startY);
  return { x, y, width, height };
}

function isPointInRect(x: number, y: number, rect: SnapshotRect) {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function formatRecentTime(value: string | undefined, language: "zh" | "en") {
  if (!value) return language === "zh" ? "未知" : "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return language === "zh" ? "未知" : "Unknown";
  const now = Date.now();
  const diffMs = now - date.getTime();
  if (diffMs < 60_000) return language === "zh" ? "刚刚" : "just now";
  if (diffMs < 3_600_000) {
    const mins = Math.max(1, Math.round(diffMs / 60_000));
    return language === "zh" ? `${mins} 分钟前` : `${mins} min ago`;
  }
  if (diffMs < 86_400_000) {
    const hours = Math.max(1, Math.round(diffMs / 3_600_000));
    return language === "zh" ? `${hours} 小时前` : `${hours}h ago`;
  }
  return date.toLocaleString(language === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatReadDuration(totalSec: number | undefined, language: "zh" | "en") {
  const sec = Math.max(0, Math.round(totalSec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (language === "zh") {
    if (h > 0) return `${h}小时 ${m}分`;
    if (m > 0) return `${m}分 ${s}秒`;
    return `${s}秒`;
  }
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatRecentSessions(
  sessions: Array<{ closedAt: string; durationSec: number; endPage?: number }> | undefined,
  language: "zh" | "en"
) {
  if (!sessions || sessions.length === 0) return "";
  return sessions.slice(0, 3).map((session) => {
    const time = formatRecentTime(session.closedAt, language);
    const duration = formatReadDuration(session.durationSec, language);
    const pageText =
      typeof session.endPage === "number"
        ? language === "zh"
          ? `第${Math.max(1, Math.round(session.endPage))}页`
          : `p${Math.max(1, Math.round(session.endPage))}`
        : "";
    return [time, pageText, duration].filter(Boolean).join(" · ");
  }).join("  /  ");
}

function getPdfReadState(item: HomeRecentItem): PdfReadState {
  if (item.missing) return "missing";
  const totalPages = Math.max(1, item.snapshot?.totalPages || 0);
  const lastPageFromSnapshot = Math.max(0, item.snapshot?.lastPage || 0);
  const lastPageFromSession = Math.max(
    0,
    ...(item.sessions || [])
      .map((session) => (typeof session.endPage === "number" && Number.isFinite(session.endPage) ? session.endPage : 0))
  );
  const lastPage = Math.max(lastPageFromSnapshot, lastPageFromSession);
  const progress = totalPages > 0 ? lastPage / totalPages : 0;
  if (progress >= 0.98 || (totalPages > 0 && lastPage >= totalPages)) return "done";
  if (progress >= 0.05) return "reading";
  if ((item.totalReadSeconds || 0) >= 90) return "reading";
  return "unread";
}

function getPdfReadProgress(item: HomeRecentItem) {
  if (item.missing) return -1;
  const totalPages = Math.max(1, item.snapshot?.totalPages || 0);
  const lastPageFromSnapshot = Math.max(0, item.snapshot?.lastPage || 0);
  const lastPageFromSession = Math.max(
    0,
    ...(item.sessions || [])
      .map((session) => (typeof session.endPage === "number" && Number.isFinite(session.endPage) ? session.endPage : 0))
  );
  const lastPage = Math.max(lastPageFromSnapshot, lastPageFromSession);
  if (totalPages <= 0) return 0;
  return clamp(lastPage / totalPages, 0, 1);
}

function getPdfRecentReadTimestamp(item: HomeRecentItem) {
  const candidates = [
    item.snapshot?.capturedAt,
    item.lastOpenedAt,
    ...(item.sessions || []).flatMap((session) => [session.closedAt, session.openedAt]),
  ];
  let latest = 0;
  for (const text of candidates) {
    if (!text) continue;
    const value = Date.parse(text);
    if (Number.isFinite(value) && value > latest) latest = value;
  }
  return latest;
}

function downloadBlob(blob: Blob, fileName: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(href);
}

function CanvasLayer({ doc, pageNo, scale, width, height, active }: { doc: PDFDocumentProxy | null; pageNo: number; scale: number; width: number; height: number; active: boolean; }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);

  useEffect(() => {
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }
    if (!active || !doc) return;
    let canceled = false;
    const run = async () => {
      const canvas = ref.current;
      if (!canvas) return;
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(viewport.width * dpr));
      canvas.height = Math.max(1, Math.round(viewport.height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewport.width, viewport.height);
      const task = page.render({ canvas, canvasContext: ctx, viewport });
      renderTaskRef.current = task as unknown as { cancel: () => void };
      await task.promise;
      if (!canceled && renderTaskRef.current === (task as unknown as { cancel: () => void })) {
        renderTaskRef.current = null;
      }
    };
    void run().catch((e: unknown) => {
      const name = e && typeof e === "object" && "name" in e ? String((e as { name?: string }).name) : "";
      if (name === "RenderingCancelledException") return;
      if (!canceled) debugError("viewer.canvas", "render fail", { pageNo, e });
    });
    return () => {
      canceled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [active, doc, pageNo, scale, width, height]);
  return <canvas ref={ref} className="page-canvas-layer" />;
}

function TextLayerView({ doc, pageNo, scale, width, height, active }: { doc: PDFDocumentProxy | null; pageNo: number; scale: number; width: number; height: number; active: boolean; }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !doc) return;
    let canceled = false;
    const run = async () => {
      const layer = ref.current;
      if (!layer) return;
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale });
      const text = await page.getTextContent();
      if (canceled) return;
      layer.innerHTML = "";
      const tl = new TextLayer({ textContentSource: text, container: layer, viewport });
      await tl.render();
    };
    void run().catch((e) => !canceled && debugError("viewer.text", "render fail", { pageNo, e }));
    return () => {
      canceled = true;
      if (ref.current) ref.current.innerHTML = "";
    };
  }, [active, doc, pageNo, scale, width, height]);
  return <div className="page-text-overlay" style={{ width, height }}><div ref={ref} className="textLayer" /></div>;
}

function LinkLayer({
  doc,
  pageNo,
  scale,
  width,
  height,
  active,
  onOpenLink,
  onGoPage,
}: {
  doc: PDFDocumentProxy | null;
  pageNo: number;
  scale: number;
  width: number;
  height: number;
  active: boolean;
  onOpenLink: (url: string, options?: { forceExternal?: boolean }) => void;
  onGoPage: (pageNo: number, options?: { behavior?: ScrollBehavior }) => void;
}) {
  const [links, setLinks] = useState<LinkRegion[]>([]);

  useEffect(() => {
    if (!active || !doc) {
      setLinks([]);
      return;
    }
    let canceled = false;
    const run = async () => {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale });
      const annotations = await page.getAnnotations({ intent: "display" });
      if (canceled) return;
      const items: LinkRegion[] = [];

      for (const ann of annotations as Array<Record<string, unknown>>) {
        if (ann.subtype !== "Link" || !Array.isArray(ann.rect) || ann.rect.length < 4) continue;
        const rect = ann.rect as number[];
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const w = Math.abs(x2 - x1);
        const h = Math.abs(y2 - y1);
        if (w < 2 || h < 2) continue;

        let url: string | undefined;
        if (typeof ann.url === "string") {
          url = ann.url;
        } else if (typeof ann.unsafeUrl === "string") {
          url = ann.unsafeUrl;
        }

        let targetPage: number | undefined;
        if (url && url.startsWith("#")) {
          const hash = url.slice(1);
          const pageMatch = /(?:^|&)page=(\d+)/i.exec(hash);
          if (pageMatch) {
            const pageNum = Number.parseInt(pageMatch[1], 10);
            if (Number.isFinite(pageNum)) {
              targetPage = Math.max(1, pageNum);
              url = undefined;
            }
          } else {
            try {
              const named = decodeURIComponent(hash.replace(/^nameddest=/i, ""));
              const namedDest = await doc.getDestination(named);
              if (Array.isArray(namedDest) && namedDest.length > 0) {
                const pageRef = namedDest[0] as unknown;
                if (typeof pageRef === "number") {
                  targetPage = Math.max(1, pageRef + 1);
                } else {
                  const idx = await doc.getPageIndex(pageRef as { num: number; gen: number });
                  targetPage = idx + 1;
                }
                url = undefined;
              }
            } catch {
              // keep url fallback
            }
          }
        }
        if (!targetPage && ann.dest) {
          try {
            let dest: unknown = ann.dest;
            if (typeof dest === "string") {
              dest = await doc.getDestination(dest);
            }
            if (Array.isArray(dest) && dest.length > 0) {
              const pageRef = dest[0] as unknown;
              if (typeof pageRef === "number") {
                targetPage = pageRef + 1;
              } else {
                const idx = await doc.getPageIndex(pageRef as { num: number; gen: number });
                targetPage = idx + 1;
              }
            }
          } catch (e) {
            debugError("viewer.link", "dest resolve failed", { pageNo, e });
          }
        }

        if (!url && !targetPage) continue;
        items.push({
          id: `${pageNo}-${items.length}`,
          left,
          top,
          width: w,
          height: h,
          url,
          pageNo: targetPage,
        });
      }
      setLinks(items);
    };

    void run().catch((e) => {
      if (!canceled) debugError("viewer.link", "render fail", { pageNo, e });
      setLinks([]);
    });
    return () => {
      canceled = true;
    };
  }, [active, doc, pageNo, scale]);

  return (
    <div className="page-link-overlay" style={{ width, height }}>
      {links.map((link) => (
        <a
          key={link.id}
          className="page-link-hit"
          href={link.url || `#page=${link.pageNo || pageNo}`}
          style={{ left: link.left, top: link.top, width: link.width, height: link.height }}
          title={link.url || `Page ${link.pageNo || ""}`}
          draggable={false}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (link.url) {
              const forceExternal = e.ctrlKey || e.metaKey;
              onOpenLink(link.url, forceExternal ? { forceExternal: true } : undefined);
            }
            else if (link.pageNo) onGoPage(link.pageNo, { behavior: "auto" });
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      ))}
    </div>
  );
}

function ImageDebugLayer({
  doc,
  fileId,
  isTauri,
  pageNo,
  scale,
  width,
  height,
  active,
  enabled,
}: {
  doc: PDFDocumentProxy | null;
  fileId?: string;
  isTauri: boolean;
  pageNo: number;
  scale: number;
  width: number;
  height: number;
  active: boolean;
  enabled: boolean;
}) {
  const [regions, setRegions] = useState<DebugImageRegion[]>([]);

  useEffect(() => {
    if (!enabled || !active || !doc) {
      setRegions([]);
      return;
    }
    let canceled = false;
    const run = async () => {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale });
      if (isTauri && fileId) {
        try {
          const rawSvg = await api.exportPageSVG(fileId, pageNo);
          if (canceled) return;
          const svgRegions = collectSvgImageRegions(rawSvg, viewport);
          if (svgRegions.length > 0) {
            setRegions(svgRegions);
            return;
          }
        } catch (e) {
          if (!canceled) {
            debugError("viewer.image-debug", "collect image regions from svg failed", { pageNo, e });
          }
        }
      }
      const operatorList = await page.getOperatorList();
      if (canceled) return;

      const fnArray = operatorList.fnArray as number[];
      const argsArray = operatorList.argsArray as unknown[];
      const next: DebugImageRegion[] = [];
      const matrixStack: Array<[number, number, number, number, number, number]> = [];
      let ctm: [number, number, number, number, number, number] = [...IDENTITY_MATRIX];

      for (let i = 0; i < fnArray.length; i += 1) {
        const fn = fnArray[i];
        if (fn === OPS.save) {
          matrixStack.push([...ctm]);
          continue;
        }
        if (fn === OPS.restore) {
          ctm = matrixStack.pop() ?? [...IDENTITY_MATRIX];
          continue;
        }
        if (fn === OPS.transform) {
          const args = argsArray[i];
          if (Array.isArray(args) && args.length >= 6) {
            const m: [number, number, number, number, number, number] = [
              Number(args[0]) || 0,
              Number(args[1]) || 0,
              Number(args[2]) || 0,
              Number(args[3]) || 0,
              Number(args[4]) || 0,
              Number(args[5]) || 0,
            ];
            ctm = mulMatrix(ctm, m);
          }
          continue;
        }

        const label = imageOpLabel(fn);
        if (!label) continue;
        const p1 = mapPoint(ctm, 0, 0);
        const p2 = mapPoint(ctm, 1, 0);
        const p3 = mapPoint(ctm, 0, 1);
        const p4 = mapPoint(ctm, 1, 1);
        const v1 = viewport.convertToViewportPoint(p1.x, p1.y);
        const v2 = viewport.convertToViewportPoint(p2.x, p2.y);
        const v3 = viewport.convertToViewportPoint(p3.x, p3.y);
        const v4 = viewport.convertToViewportPoint(p4.x, p4.y);
        const minX = Math.min(v1[0], v2[0], v3[0], v4[0]);
        const maxX = Math.max(v1[0], v2[0], v3[0], v4[0]);
        const minY = Math.min(v1[1], v2[1], v3[1], v4[1]);
        const maxY = Math.max(v1[1], v2[1], v3[1], v4[1]);
        const boxWidth = maxX - minX;
        const boxHeight = maxY - minY;
        if (!Number.isFinite(boxWidth) || !Number.isFinite(boxHeight)) continue;
        if (boxWidth < 6 || boxHeight < 6) continue;
        const fallbackFormat =
          label === "IMAGE" || label === "INLINE"
            ? "PNG"
            : label === "MASK"
              ? "MASK"
              : "UNKNOWN";
        next.push({
          left: minX,
          top: minY,
          width: boxWidth,
          height: boxHeight,
          label: fallbackFormat,
        });
      }
      setRegions(next);
    };

    void run().catch((e) => {
      if (!canceled) {
        debugError("viewer.image-debug", "collect image ops failed", { pageNo, e });
      }
      setRegions([]);
    });
    return () => {
      canceled = true;
    };
  }, [active, doc, enabled, fileId, isTauri, pageNo, scale]);

  if (!enabled || !active || regions.length === 0) return null;

  return (
    <div className="page-image-debug-overlay" style={{ width, height }}>
      {regions.map((region, index) => (
        <div
          key={`${pageNo}-${index}-${region.left}-${region.top}`}
          className="page-image-debug-box"
          style={{
            left: region.left,
            top: region.top,
            width: region.width,
            height: region.height,
          }}
        >
          <span className="page-image-debug-badge">{region.label}</span>
        </div>
      ))}
    </div>
  );
}

function PageThumbnail({
  doc,
  fileId,
  pageNo,
  active,
  onClick,
  itemRef,
}: {
  doc: PDFDocumentProxy | null;
  fileId?: string;
  pageNo: number;
  active: boolean;
  onClick: (pageNo: number, options?: { behavior?: ScrollBehavior }) => void;
  itemRef?: (node: HTMLButtonElement | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!doc && !fileId) return;
    let canceled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    let imageObjectUrl = "";

    const run = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      if (doc) {
        const page = await doc.getPage(pageNo);
        const viewport = page.getViewport({ scale: 1 });
        const targetWidth = 104;
        const thumbScale = targetWidth / Math.max(viewport.width, 1);
        const thumbViewport = page.getViewport({ scale: thumbScale });
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

        canvas.width = Math.max(1, Math.round(thumbViewport.width * dpr));
        canvas.height = Math.max(1, Math.round(thumbViewport.height * dpr));
        canvas.style.width = `${Math.round(thumbViewport.width)}px`;
        canvas.style.height = `${Math.round(thumbViewport.height)}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, thumbViewport.width, thumbViewport.height);
        task = page.render({ canvas, canvasContext: ctx, viewport: thumbViewport }) as unknown as { cancel: () => void; promise: Promise<void> };
        await task.promise;
        return;
      }

      if (!fileId) return;
      const pngBase64 = await api.exportPagePNG(fileId, pageNo, 0.38);
      if (canceled) return;
      imageObjectUrl = URL.createObjectURL(new Blob([b64ToBytes(pngBase64)], { type: "image/png" }));
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("thumbnail image decode failed"));
        image.src = imageObjectUrl;
      });
      if (canceled) return;
      const targetWidth = 104;
      const ratio = targetWidth / Math.max(img.width, 1);
      const drawWidth = Math.max(1, Math.round(img.width * ratio));
      const drawHeight = Math.max(1, Math.round(img.height * ratio));
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(drawWidth * dpr));
      canvas.height = Math.max(1, Math.round(drawHeight * dpr));
      canvas.style.width = `${drawWidth}px`;
      canvas.style.height = `${drawHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, drawWidth, drawHeight);
      ctx.drawImage(img, 0, 0, drawWidth, drawHeight);
    };

    void run().catch((e: unknown) => {
      if (canceled) return;
      const name = e && typeof e === "object" && "name" in e ? String((e as { name?: string }).name) : "";
      if (name === "RenderingCancelledException") return;
      debugError("viewer.thumb", "thumb render fail", { pageNo, e });
    });

    return () => {
      canceled = true;
      if (task) task.cancel();
      if (imageObjectUrl) URL.revokeObjectURL(imageObjectUrl);
    };
  }, [doc, fileId, pageNo]);

  return (
    <button
      ref={itemRef}
      type="button"
      className={`pdf-thumb-item ${active ? "active" : ""}`}
      onClick={() => onClick(pageNo, { behavior: "auto" })}
    >
      <div className="pdf-thumb-canvas-wrap">
        <canvas ref={canvasRef} className="pdf-thumb-canvas" />
      </div>
      <span className="pdf-thumb-label">{pageNo}</span>
    </button>
  );
}

function PDFViewer({
  fileId,
  fallbackFileName,
  fallbackPages,
  initialViewSnapshot,
  recentFiles,
  favorites,
  language,
  onLanguageChange,
  onOpenFile,
  onOpenRecentFile,
  onContinueRecentSession,
  onRelocateRecentFile,
  onOpenLink,
  onOpenFavorite,
  onAddWebFavorite,
  onAddPdfFavorite,
  onPreviewExportedImage,
  onRemoveFavorite,
  onReorderFavorites,
  onViewSnapshot,
}: PDFViewerProps) {
  const t = TXT[language];
  const isTauri = typeof window !== "undefined" && ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);
  const hasDoc = Boolean(fileId);
  const initialDebugMode =
    typeof window !== "undefined" && window.localStorage.getItem("pdf_reader_debug_img_type") === "1";

  const [scale, setScale] = useState(1);
  const [numPages, setNumPages] = useState(Math.max(1, fallbackPages));
  const [currentPage, setCurrentPage] = useState(1);
  const [sizes, setSizes] = useState<Record<number, PageSize>>({});
  const [tilesByPage, setTilesByPage] = useState<Record<number, api.TileReadyPayload[]>>({});
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set([1]));
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [langMenu, setLangMenu] = useState(false);
  const [rightDown, setRightDown] = useState(false);
  const [rightDrag, setRightDrag] = useState(false);
  const [snapshotDraft, setSnapshotDraft] = useState<SnapshotDraft | null>(null);
  const [snapshotPageNo, setSnapshotPageNo] = useState<number | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [debugImageType, setDebugImageType] = useState(initialDebugMode);
  const [autoFit, setAutoFit] = useState(true);
  const [viewerBgIndex, setViewerBgIndex] = useState(getInitialViewerBgIndex);
  const [thumbSidebarOpen, setThumbSidebarOpen] = useState(getInitialThumbSidebarOpen);
  const [selectionMarker, setSelectionMarker] = useState<TextSelectionMarker | null>(null);
  const [noticeText, setNoticeText] = useState("");
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpInput, setJumpInput] = useState("1");
  const [homeUrl, setHomeUrl] = useState("");
  const [idleTipIndex, setIdleTipIndex] = useState(0);
  const [dragFavoriteId, setDragFavoriteId] = useState("");
  const [dragOverFavoriteId, setDragOverFavoriteId] = useState("");
  const [recentFilter, setRecentFilter] = useState<RecentFilter>("all");
  const [recentSort, setRecentSort] = useState<RecentSort>("recent");

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const langMenuRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const activeReq = useRef<Map<number, string>>(new Map());
  const lastReqKey = useRef<Map<number, string>>(new Map());
  const pendingReq = useRef<Map<number, TileReq>>(new Map());
  const rafRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const fileRef = useRef<string | undefined>(fileId);
  const rightWheelAtRef = useRef(0);
  const snapshotDraftRef = useRef<SnapshotDraft | null>(null);
  const snapshotEditRef = useRef<SnapshotEditState | null>(null);
  const selectionRafRef = useRef<number | null>(null);
  const dragRef = useRef({ active: false, moved: false, sx: 0, sy: 0, sl: 0, st: 0 });
  const thumbItemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const thumbListRef = useRef<HTMLDivElement | null>(null);
  const thumbFollowTimerRef = useRef<number | null>(null);
  const pendingRestorePageRef = useRef<number | null>(null);
  const pendingRestoreScrollRatioRef = useRef<number | null>(null);

  useEffect(() => { fileRef.current = fileId; }, [fileId]);
  useEffect(() => { snapshotDraftRef.current = snapshotDraft; }, [snapshotDraft]);
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THUMB_SIDEBAR_KEY, thumbSidebarOpen ? "1" : "0");
    }
  }, [thumbSidebarOpen]);

  useEffect(() => {
    if (!hasDoc || snapshotPageNo !== null || snapshotBusy) return;
    const timer = window.setInterval(() => {
      setIdleTipIndex((prev) => prev + 1);
    }, 4200);
    return () => window.clearInterval(timer);
  }, [hasDoc, snapshotBusy, snapshotPageNo]);

  useEffect(() => {
    if (!hasDoc || !onViewSnapshot) return;
    const timer = window.setTimeout(() => {
      const root = scrollRef.current;
      const maxScrollTop = root ? Math.max(1, root.scrollHeight - root.clientHeight) : 1;
      const scrollTopRatio = root
        ? clamp(root.scrollTop / maxScrollTop, 0, 1)
        : undefined;
      onViewSnapshot({
        lastPage: currentPage,
        totalPages: numPages,
        zoom: Math.round(scale * 100),
        autoFit,
        scrollTopRatio,
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [autoFit, currentPage, hasDoc, numPages, onViewSnapshot, scale]);

  const getSize = useCallback((pageNo: number) => sizes[pageNo] ?? { width: BASE_W, height: BASE_H }, [sizes]);
  const getScaled = useCallback((pageNo: number) => {
    const s = getSize(pageNo);
    return { width: Math.round(s.width * scale), height: Math.round(s.height * scale) };
  }, [getSize, scale]);
  const computeFitScale = useCallback((pageNo: number) => {
    const root = scrollRef.current;
    if (!root) return null;
    const s = getSize(pageNo);
    if (!s.width) return null;
    const style = window.getComputedStyle(root);
    const padLeft = Number.parseFloat(style.paddingLeft || "0") || 0;
    const padRight = Number.parseFloat(style.paddingRight || "0") || 0;
    const available = Math.max(220, root.clientWidth - padLeft - padRight - 8);
    return Math.min(4, Math.max(0.5, Number((available / s.width).toFixed(3))));
  }, [getSize]);
  const showNotice = useCallback((text: string, ms = 2400) => {
    setNoticeText(text);
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setNoticeText("");
      noticeTimerRef.current = null;
    }, ms);
  }, []);

  const cancelAll = useCallback(() => {
    const ids = Array.from(activeReq.current.values());
    activeReq.current.clear();
    lastReqKey.current.clear();
    pendingReq.current.clear();
    for (const id of ids) void api.cancelTileRequest(id);
  }, []);

  const issueReq = useCallback(async (fid: string, req: TileReq) => {
    lastReqKey.current.set(req.pageNo, req.key);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const renderScale = Math.min(4.2, Math.max(scale * dpr * 1.35, scale + 0.85, 1.8));
    try {
      const ack = await api.requestTiles(fid, req.pageNo, scale, req.viewport, 512, renderScale);
      activeReq.current.set(req.pageNo, ack.request_id);
    } catch (e) {
      debugError("viewer.tiles", "request fail", { req, e });
    }
  }, [scale]);

  const syncVisible = useCallback(() => {
    const root = scrollRef.current;
    if (!root || !hasDoc) return;
    const rootRect = root.getBoundingClientRect();
    const top = root.scrollTop;
    const bottom = top + root.clientHeight;
    const cy = top + root.clientHeight / 2;

    let near = 1;
    let nearDist = Number.POSITIVE_INFINITY;
    const vis = new Set<number>();
    const inRangePages: number[] = [];
    const pageNodes = new Map<number, HTMLDivElement>();
    const reqs: TileReq[] = [];

    for (let pageNo = 1; pageNo <= numPages; pageNo += 1) {
      const node = pageRefs.current.get(pageNo);
      if (!node) continue;
      pageNodes.set(pageNo, node);
      const nodeRect = node.getBoundingClientRect();
      const nt = top + (nodeRect.top - rootRect.top);
      const nb = nt + node.clientHeight;
      const dist = Math.abs((nt + nb) / 2 - cy);
      if (dist < nearDist) { nearDist = dist; near = pageNo; }
      if (nb < top - OVERSCAN || nt > bottom + OVERSCAN) continue;
      inRangePages.push(pageNo);
    }

    for (const pageNo of inRangePages) {
      vis.add(pageNo);
    }
    for (let delta = 1; delta <= NEIGHBOR_PAGES; delta += 1) {
      const p1 = near - delta;
      const p2 = near + delta;
      if (pageNodes.has(p1)) vis.add(p1);
      if (pageNodes.has(p2)) vis.add(p2);
    }

    for (const pageNo of vis) {
      const node = pageNodes.get(pageNo);
      if (!node) continue;
      const key = `${pageNo}|${scale.toFixed(3)}|${node.clientWidth}|${node.clientHeight}`;
      reqs.push({ pageNo, key, viewport: { x: 0, y: 0, width: node.clientWidth, height: node.clientHeight } });
    }

    if (near !== currentPage) {
      const currentNode = pageNodes.get(currentPage);
      if (currentNode) {
        const nodeRect = currentNode.getBoundingClientRect();
        const nt = top + (nodeRect.top - rootRect.top);
        const nb = nt + currentNode.clientHeight;
        const currentDist = Math.abs((nt + nb) / 2 - cy);
        const hysteresis = Math.max(24, root.clientHeight * 0.06);
        if (nearDist + hysteresis < currentDist) {
          setCurrentPage(near);
        }
      } else {
        setCurrentPage(near);
      }
    }
    setVisiblePages(vis);

    if (!isTauri || !fileId) return;

    for (const req of reqs) {
      const active = activeReq.current.get(req.pageNo);
      const last = lastReqKey.current.get(req.pageNo);
      if (active) {
        if (last !== req.key) pendingReq.current.set(req.pageNo, req);
        continue;
      }
      if (last === req.key) continue;
      void issueReq(fileId, req);
    }
  }, [currentPage, fileId, hasDoc, isTauri, issueReq, numPages, scale]);

  const scheduleSync = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      syncVisible();
    });
  }, [syncVisible]);

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const root = scrollRef.current;
    if (!root) return;
    setAutoFit(false);
    const rect = root.getBoundingClientRect();
    const ax = clientX - rect.left;
    const ay = clientY - rect.top;
    setScale((prev) => {
      const next = Math.min(4, Math.max(0.5, Number((prev * factor).toFixed(3))));
      if (Math.abs(next - prev) < 0.0001) return prev;
      const ratio = next / prev;
      const nextLeft = (root.scrollLeft + ax) * ratio - ax;
      const nextTop = (root.scrollTop + ay) * ratio - ay;
      requestAnimationFrame(() => {
        root.scrollLeft = Math.max(0, nextLeft);
        root.scrollTop = Math.max(0, nextTop);
        scheduleSync();
      });
      return next;
    });
  }, [scheduleSync]);

  const zoomCentered = useCallback((factor: number) => {
    const root = scrollRef.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }, [zoomAt]);

  const zoomIn = useCallback(() => zoomCentered(1.15), [zoomCentered]);
  const zoomOut = useCallback(() => zoomCentered(1 / 1.15), [zoomCentered]);

  const fitWidth = useCallback(() => {
    const target = computeFitScale(currentPage);
    if (target === null) return;
    setAutoFit(true);
    setScale(target);
  }, [computeFitScale, currentPage]);
  const viewerBg = VIEW_BG_COLORS[viewerBgIndex] ?? VIEW_BG_COLORS[0];
  const cycleViewerBg = useCallback(() => {
    setViewerBgIndex((prev) => {
      const next = (prev + 1) % VIEW_BG_COLORS.length;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(VIEW_BG_KEY, String(next));
      }
      return next;
    });
  }, []);

  const goPage = useCallback((pageNo: number, options?: { behavior?: ScrollBehavior }) => {
    if (!Number.isFinite(pageNo)) return;
    const p = Math.max(1, Math.min(pageNo, numPages));
    const root = scrollRef.current;
    const node = pageRefs.current.get(p);
    if (!root || !node) return;
    const rootRect = root.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const targetTop = root.scrollTop + (nodeRect.top - rootRect.top) - 12;
    root.scrollTo({ top: Math.max(targetTop, 0), behavior: options?.behavior ?? "smooth" });
    setCurrentPage(p);
  }, [numPages]);

  const onJump = useCallback(() => {
    if (!hasDoc) return;
    setJumpInput(String(currentPage));
    setJumpOpen(true);
  }, [currentPage, hasDoc]);

  const confirmJump = useCallback(() => {
    const p = Number.parseInt(jumpInput, 10);
    if (!Number.isNaN(p)) goPage(p);
    setJumpOpen(false);
  }, [goPage, jumpInput]);

  const exportPagePng = useCallback(async () => {
    if (!fileId) return showNotice(t.needOpen);
    if (!isTauri) {
      const node = pageRefs.current.get(currentPage);
      const canvas = node?.querySelector(".page-canvas-layer") as HTMLCanvasElement | null;
      if (!canvas) {
        showNotice(t.browserModePngUnavailable);
        return;
      }
      canvas.toBlob((blob) => {
        if (!blob) {
          showNotice(t.browserModePngFailed);
          return;
        }
        downloadBlob(blob, `${fileBase(fallbackFileName)}-p${currentPage}.png`);
        showNotice(t.exportDone);
      }, "image/png");
      return;
    }
    try {
      const b64 = await api.exportPagePNG(fileId, currentPage, Math.max(scale, 2));
      const settings = loadUserSettings();
      await api.savePNGToFile(
        b64,
        withDefaultDir(`${fileBase(fallbackFileName)}-p${currentPage}.png`, settings.defaultSaveDir)
      );
      showNotice(t.exportDone);
    } catch (e) {
      debugError("viewer.export", "page png fail", e);
      showNotice(`${t.expPngFail}: ${errText(e)}`, 3600);
    }
  }, [currentPage, fallbackFileName, fileId, isTauri, scale, showNotice, t]);

  const exportPageSvg = useCallback(async () => {
    if (!fileId) return showNotice(t.needOpen);
    if (!isTauri) {
      showNotice(t.browserModePageSvgUnavailable);
      return;
    }
    try {
      const rawSvg = await api.exportPageSVG(fileId, currentPage);
      const svg = extractImageAreaSvg(rawSvg);
      if (!svg) {
        showNotice("No image region found on this page", 3200);
        return;
      }
      const report = analyzeSvgQuality(svg);
      const settings = loadUserSettings();
      await api.saveSVGToFile(
        svg,
        withDefaultDir(`${fileBase(fallbackFileName)}-p${currentPage}.svg`, settings.defaultSaveDir)
      );
      const ratioText = `${Math.round(report.vectorRatio * 100)}%`;
      const qualityText = t.svgQuality(report.grade, ratioText, report.imageCount);
      showNotice(`${t.exportDone} · ${qualityText}`, 3600);
    } catch (e) {
      debugError("viewer.export", "page svg fail", e);
      showNotice(`${t.expSvgFail}: ${errText(e)}`, 3600);
    }
  }, [currentPage, fallbackFileName, fileId, isTauri, showNotice, t]);

  const exportAllPageSvg = useCallback(async () => {
    if (!fileId) return showNotice(t.needOpen);
    if (!isTauri) {
      showNotice(t.browserModePageSvgUnavailable);
      return;
    }
    const exportAllFailText = language === "zh" ? "批量导出 SVG 失败" : "Batch SVG export failed";
    const exportAllNoImageText = language === "zh" ? "所有页面均未检测到图片区域" : "No image region found across pages";
    try {
      const settings = loadUserSettings();
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: settings.defaultSaveDir || undefined,
      });
      if (!selected || Array.isArray(selected)) return;
      const { mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
      const { join } = await import("@tauri-apps/api/path");

      const safeBase = (fileBase(fallbackFileName) || "pdf")
        .replace(/[<>:"/\\|?*]+/g, "_")
        .trim();
      const targetDir = await join(selected, `${safeBase}-svg`);
      await mkdir(targetDir, { recursive: true });

      let exported = 0;
      for (let pageNo = 1; pageNo <= numPages; pageNo += 1) {
        const rawSvg = await api.exportPageSVG(fileId, pageNo);
        const svg = extractImageAreaSvg(rawSvg);
        if (!svg) continue;
        const filePath = await join(targetDir, `${safeBase}-p${pageNo}.svg`);
        await writeTextFile(filePath, svg);
        exported += 1;
      }

      if (exported === 0) {
        showNotice(exportAllNoImageText, 3600);
        return;
      }
      const doneText = language === "zh"
        ? `已导出 SVG ${exported}/${numPages} 页`
        : `Exported SVG ${exported}/${numPages} pages`;
      showNotice(doneText, 4200);
    } catch (e) {
      debugError("viewer.export", "all svg fail", e);
      showNotice(`${exportAllFailText}: ${errText(e)}`, 4200);
    }
  }, [fallbackFileName, fileId, isTauri, language, numPages, showNotice, t.browserModePageSvgUnavailable, t.needOpen]);

  const exportSnapshotSvg = useCallback(async (pageNo: number, cropInView?: SnapshotRect): Promise<boolean> => {
    if (!fileId) {
      showNotice(t.needOpen);
      return false;
    }
    if (!isTauri) {
      showNotice(t.browserModeSnapshotSvgUnavailable);
      return false;
    }
    try {
      const rawSvg = await api.exportPageSVG(fileId, pageNo);
      const parser = new DOMParser();
      const docSvg = parser.parseFromString(rawSvg, "image/svg+xml");
      const root = docSvg.documentElement;
      if (!root || root.tagName.toLowerCase() !== "svg") {
        throw new Error("Invalid SVG content");
      }
      let vx = 0;
      let vy = 0;
      let vw = 0;
      let vh = 0;
      const vb = root.getAttribute("viewBox");
      if (vb) {
        const nums = vb.trim().split(/[\s,]+/).map((n) => Number.parseFloat(n));
        if (nums.length >= 4 && nums.every((n) => Number.isFinite(n))) {
          [vx, vy, vw, vh] = nums;
        }
      }
      if (vw <= 0 || vh <= 0) {
        const width = Number.parseFloat(root.getAttribute("width") || "0");
        const height = Number.parseFloat(root.getAttribute("height") || "0");
        vw = Number.isFinite(width) && width > 0 ? width : BASE_W;
        vh = Number.isFinite(height) && height > 0 ? height : BASE_H;
      }

      if (cropInView) {
        const display = getScaled(pageNo);
        const rx = vw / Math.max(display.width, 1);
        const ry = vh / Math.max(display.height, 1);
        const cx = Math.max(0, cropInView.x * rx);
        const cy = Math.max(0, cropInView.y * ry);
        const cw = Math.max(1, cropInView.width * rx);
        const ch = Math.max(1, cropInView.height * ry);
        root.setAttribute("viewBox", `${vx + cx} ${vy + cy} ${Math.min(cw, vw)} ${Math.min(ch, vh)}`);
        root.setAttribute("width", `${Math.min(cw, vw)}`);
        root.setAttribute("height", `${Math.min(ch, vh)}`);
      } else {
        root.setAttribute("viewBox", `${vx} ${vy} ${vw} ${vh}`);
        root.setAttribute("width", `${vw}`);
        root.setAttribute("height", `${vh}`);
      }

      const svg = new XMLSerializer().serializeToString(docSvg);
      const report = analyzeSvgQuality(svg);
      if (/<image[\s>]/i.test(svg)) {
        showNotice(t.vectorWarn, 3600);
      }

      const settings = loadUserSettings();
      await api.saveSVGToFile(
        svg,
        withDefaultDir(`${fileBase(fallbackFileName)}-p${pageNo}-snapshot.svg`, settings.defaultSaveDir)
      );
      const ratioText = `${Math.round(report.vectorRatio * 100)}%`;
      const qualityText = t.svgQuality(report.grade, ratioText, report.imageCount);
      showNotice(`${t.exportDone} · ${qualityText}`, 3600);
      return true;
    } catch (e) {
      debugError("viewer.export", "snapshot fail", e);
      showNotice(`${t.expSvgFail}: ${errText(e)}`, 3600);
      return false;
    }
  }, [fallbackFileName, fileId, getScaled, isTauri, showNotice, t]);

  const exportImagePng = useCallback(async (b64: string, pageNo: number) => {
    if (isTauri) {
      const settings = loadUserSettings();
      await api.savePNGToFile(b64, withDefaultDir(`image-p${pageNo}.png`, settings.defaultSaveDir));
    } else {
      const bytes = b64ToBytes(b64);
      downloadBlob(new Blob([bytes], { type: "image/png" }), `image-p${pageNo}.png`);
    }
    showNotice(t.exportDone);
  }, [isTauri, showNotice, t.exportDone]);

  const exportImageJpg = useCallback(async (b64: string, pageNo: number) => {
    const img = new Image();
    const ready = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("decode fail"));
    });
    img.src = `data:image/png;base64,${b64}`;
    await ready;
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    if (isTauri) {
      const jpg = canvas.toDataURL("image/jpeg", 0.93).split(",")[1];
      const settings = loadUserSettings();
      await saveBytes(b64ToBytes(jpg), `image-p${pageNo}.jpg`, "JPEG Image", ["jpg", "jpeg"], settings.defaultSaveDir);
    } else {
      const jpgBlob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("failed to create jpeg blob"));
            return;
          }
          resolve(blob);
        }, "image/jpeg", 0.93);
      });
      downloadBlob(jpgBlob, `image-p${pageNo}.jpg`);
    }
    showNotice(t.exportDone);
  }, [isTauri, showNotice, t.exportDone]);

  const buildWrappedSvg = useCallback((b64: string, w: number, h: number) => {
    const safeW = Math.max(1, Math.round(w));
    const safeH = Math.max(1, Math.round(h));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${safeW}" height="${safeH}" viewBox="0 0 ${safeW} ${safeH}"><image href="data:image/png;base64,${b64}" width="${safeW}" height="${safeH}" /></svg>`;
  }, []);

  const exportImageSvg = useCallback(async (b64: string, pageNo: number, w: number, h: number) => {
    const svg = buildWrappedSvg(b64, w, h);
    if (isTauri) {
      const settings = loadUserSettings();
      await api.saveSVGToFile(svg, withDefaultDir(`image-p${pageNo}.svg`, settings.defaultSaveDir));
    } else {
      downloadBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), `image-p${pageNo}.svg`);
    }
    showNotice(t.exportDone);
  }, [buildWrappedSvg, isTauri, showNotice, t.exportDone]);

  const previewExportedImage = useCallback((
    b64: string,
    pageNo: number,
    w: number,
    h: number,
    sourceType: string
  ) => {
    if (!onPreviewExportedImage) return;
    const normalizedSource = sourceType.toUpperCase();
    if (normalizedSource === "JPG") {
      onPreviewExportedImage({
        title: `image-p${pageNo}.jpg`,
        mimeType: "image/jpeg",
        dataUrl: `data:image/jpeg;base64,${b64}`,
        sourceType: normalizedSource,
      });
      showNotice(t.previewOpened);
      return;
    }
    if (normalizedSource === "SVG") {
      const report = analyzeSvgQuality(b64);
      onPreviewExportedImage({
        title: `image-p${pageNo}.svg`,
        mimeType: "image/svg+xml",
        dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(b64)}`,
        sourceType: normalizedSource,
        vectorRatio: report.vectorRatio,
        vectorGrade: report.grade,
        imageCount: report.imageCount,
        vectorCount: report.vectorCount,
      });
      showNotice(t.previewOpened);
      return;
    }
    if (normalizedSource === "PNG") {
      onPreviewExportedImage({
        title: `image-p${pageNo}.png`,
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${b64}`,
        sourceType: normalizedSource,
      });
      showNotice(t.previewOpened);
      return;
    }
    const svg = buildWrappedSvg(b64, w, h);
    const report = analyzeSvgQuality(svg);
    onPreviewExportedImage({
      title: `image-p${pageNo}.svg`,
      mimeType: "image/svg+xml",
      dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      sourceType: "SVG_WRAPPED",
      vectorRatio: report.vectorRatio,
      vectorGrade: report.grade,
      imageCount: report.imageCount,
      vectorCount: report.vectorCount,
    });
    showNotice(t.previewOpened);
  }, [buildWrappedSvg, onPreviewExportedImage, showNotice, t.previewOpened]);

  const exportImageByFormat = useCallback(async (b64: string, pageNo: number, w: number, h: number) => {
    const settings = loadUserSettings();
    const value = settings.defaultExportFormat;
    if (value === "png") {
      await exportImagePng(b64, pageNo);
      return;
    }
    if (value === "jpg") {
      await exportImageJpg(b64, pageNo);
      return;
    }
    if (value === "svg") {
      await exportImageSvg(b64, pageNo, w, h);
      return;
    }
    showNotice(t.formatInvalid);
  }, [exportImageJpg, exportImagePng, exportImageSvg, showNotice, t.formatInvalid]);

  const toggleDebugImageType = useCallback(() => {
    setDebugImageType((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem("pdf_reader_debug_img_type", next ? "1" : "0");
      }
      return next;
    });
  }, []);

  const cancelSnapshotSelection = useCallback(() => {
    setSnapshotDraft(null);
    snapshotDraftRef.current = null;
    snapshotEditRef.current = null;
    setSnapshotPageNo(null);
    setSnapshotBusy(false);
  }, []);

  const startSnapshotSelection = useCallback((pageNo: number) => {
    if (!hasDoc) return;
    if (!Number.isFinite(pageNo)) return;
    const safePage = Math.max(1, Math.min(Math.round(pageNo), numPages));
    setMenu(null);
    setSnapshotBusy(false);
    setSnapshotDraft(null);
    snapshotDraftRef.current = null;
    snapshotEditRef.current = null;
    setSnapshotPageNo(safePage);
    if (safePage !== currentPage) {
      goPage(safePage, { behavior: "auto" });
    }
  }, [currentPage, goPage, hasDoc, numPages]);

  const onSnapshotMouseDown = useCallback((pageNo: number, e: MouseEvent<HTMLDivElement>) => {
    if (snapshotBusy || snapshotPageNo !== pageNo || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    const handleName = (e.target as HTMLElement).dataset.handle as SnapshotHandle | undefined;
    const prev = snapshotDraftRef.current;
    const prevRect = prev && prev.pageNo === pageNo ? toSnapshotRect(prev) : null;
    if (prevRect && !prev?.dragging) {
      if (handleName) {
        snapshotEditRef.current = {
          pageNo,
          handle: handleName,
          startX: x,
          startY: y,
          boundsWidth: rect.width,
          boundsHeight: rect.height,
          origin: prevRect,
        };
        return;
      }
      if (isPointInRect(x, y, prevRect)) {
        snapshotEditRef.current = {
          pageNo,
          handle: "move",
          startX: x,
          startY: y,
          boundsWidth: rect.width,
          boundsHeight: rect.height,
          origin: prevRect,
        };
        return;
      }
    }
    const next: SnapshotDraft = {
      pageNo,
      startX: x,
      startY: y,
      endX: x,
      endY: y,
      dragging: true,
    };
    snapshotDraftRef.current = next;
    setSnapshotDraft(next);
  }, [snapshotBusy, snapshotPageNo]);

  const onSnapshotMouseMove = useCallback((pageNo: number, e: MouseEvent<HTMLDivElement>) => {
    if (snapshotBusy) return;
    const edit = snapshotEditRef.current;
    if (edit && edit.pageNo === pageNo) {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
      const dx = x - edit.startX;
      const dy = y - edit.startY;
      const minSize = 10;
      let left = edit.origin.x;
      let top = edit.origin.y;
      let right = edit.origin.x + edit.origin.width;
      let bottom = edit.origin.y + edit.origin.height;
      if (edit.handle === "move") {
        const w = edit.origin.width;
        const h = edit.origin.height;
        left = clamp(edit.origin.x + dx, 0, edit.boundsWidth - w);
        top = clamp(edit.origin.y + dy, 0, edit.boundsHeight - h);
        right = left + w;
        bottom = top + h;
      } else {
        if (edit.handle.includes("w")) left = clamp(edit.origin.x + dx, 0, right - minSize);
        if (edit.handle.includes("e")) right = clamp(edit.origin.x + edit.origin.width + dx, left + minSize, edit.boundsWidth);
        if (edit.handle.includes("n")) top = clamp(edit.origin.y + dy, 0, bottom - minSize);
        if (edit.handle.includes("s")) bottom = clamp(edit.origin.y + edit.origin.height + dy, top + minSize, edit.boundsHeight);
      }
      const next: SnapshotDraft = {
        pageNo,
        startX: left,
        startY: top,
        endX: right,
        endY: bottom,
        dragging: false,
      };
      snapshotDraftRef.current = next;
      setSnapshotDraft(next);
      return;
    }
    const prev = snapshotDraftRef.current;
    if (!prev || !prev.dragging || prev.pageNo !== pageNo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    const next = { ...prev, endX: x, endY: y };
    snapshotDraftRef.current = next;
    setSnapshotDraft(next);
  }, [snapshotBusy]);

  const onSnapshotMouseUp = useCallback((pageNo: number, e: MouseEvent<HTMLDivElement>) => {
    if (snapshotBusy || snapshotPageNo !== pageNo) return;
    e.preventDefault();
    e.stopPropagation();
    if (snapshotEditRef.current) {
      snapshotEditRef.current = null;
      const kept = snapshotDraftRef.current;
      if (!kept || kept.pageNo !== pageNo) return;
      const finalDraft: SnapshotDraft = { ...kept, dragging: false };
      snapshotDraftRef.current = finalDraft;
      setSnapshotDraft(finalDraft);
      showNotice(t.snapReady);
      return;
    }
    const prev = snapshotDraftRef.current;
    if (!prev || prev.pageNo !== pageNo) {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    const finalDraft: SnapshotDraft = { ...prev, endX: x, endY: y, dragging: false };
    const crop = toSnapshotRect(finalDraft);
    if (crop.width < 10 || crop.height < 10) {
      showNotice(t.snapSmall);
      setSnapshotDraft(null);
      snapshotDraftRef.current = null;
      return;
    }
    snapshotDraftRef.current = finalDraft;
    setSnapshotDraft(finalDraft);
    showNotice(t.snapReady);
  }, [showNotice, snapshotBusy, snapshotPageNo, t.snapReady, t.snapSmall]);

  const confirmSnapshotExport = useCallback(() => {
    const draft = snapshotDraftRef.current;
    if (!draft) return;
    const crop = toSnapshotRect(draft);
    if (crop.width < 10 || crop.height < 10) {
      showNotice(t.snapSmall);
      return;
    }
    setSnapshotBusy(true);
    void exportSnapshotSvg(draft.pageNo, crop).then((ok) => {
      if (ok) {
        cancelSnapshotSelection();
        return;
      }
      setSnapshotBusy(false);
    });
  }, [cancelSnapshotSelection, exportSnapshotSvg, showNotice, t.snapSmall]);

  useEffect(() => {
    let mounted = true;
    const run = async () => {
      if (!fileId) {
        cancelAll();
        cancelSnapshotSelection();
        pendingRestorePageRef.current = null;
        pendingRestoreScrollRatioRef.current = null;
        setAutoFit(true);
        setDoc(null);
        setNumPages(1);
        setCurrentPage(1);
        setSizes({});
        setTilesByPage({});
        setVisiblePages(new Set([1]));
        return;
      }
      try {
        const info = await api.getPDFInfo(fileId);
        if (!mounted) return;
        const pages = Math.max(1, info.pages || fallbackPages);
        const hasSnapshot = Boolean(initialViewSnapshot);
        const snapshotPage = hasSnapshot
          ? Math.min(pages, Math.max(1, initialViewSnapshot?.lastPage || 1))
          : 1;
        const snapshotScale = hasSnapshot
          ? Math.min(4, Math.max(0.5, Number(((initialViewSnapshot?.zoom || 100) / 100).toFixed(3))))
          : 1;
        const snapshotAutoFit = hasSnapshot ? Boolean(initialViewSnapshot?.autoFit) : true;
        pendingRestorePageRef.current = hasSnapshot ? snapshotPage : null;
        pendingRestoreScrollRatioRef.current =
          hasSnapshot && typeof initialViewSnapshot?.scrollTopRatio === "number"
            ? clamp(initialViewSnapshot.scrollTopRatio, 0, 1)
            : null;
        setAutoFit(snapshotAutoFit);
        setNumPages(pages);
        setCurrentPage(snapshotPage);
        setScale(snapshotScale);
        setTilesByPage({});
        setVisiblePages(new Set([snapshotPage]));
        cancelAll();
        cancelSnapshotSelection();

        const d = api.getPdfDocument(fileId) ?? null;
        setDoc(d);
        if (d) {
          const map: Record<number, PageSize> = {};
          for (let i = 1; i <= pages; i += 1) {
            const page = await d.getPage(i);
            const v = page.getViewport({ scale: 1 });
            if (!mounted) return;
            map[i] = { width: v.width, height: v.height };
          }
          setSizes(map);
        } else {
          const map: Record<number, PageSize> = {};
          for (let i = 1; i <= pages; i += 1) map[i] = { width: BASE_W, height: BASE_H };
          setSizes(map);
        }
      } catch (e) {
        debugError("viewer", "load fail", e);
      }
    };
    void run();
    return () => { mounted = false; };
  }, [cancelAll, cancelSnapshotSelection, fallbackPages, fileId]);

  useEffect(() => {
    if (!hasDoc) return;
    scheduleSync();
  }, [hasDoc, numPages, scale, sizes, scheduleSync]);

  useEffect(() => {
    if (!hasDoc) return;
    const restorePage = pendingRestorePageRef.current;
    if (!restorePage) return;
    const root = scrollRef.current;
    const node = pageRefs.current.get(restorePage);
    if (!root || !node) return;
    const rootRect = root.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const targetTop = root.scrollTop + (nodeRect.top - rootRect.top) - 12;
    root.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
    const ratio = pendingRestoreScrollRatioRef.current;
    if (typeof ratio === "number" && Number.isFinite(ratio)) {
      const maxTop = Math.max(0, root.scrollHeight - root.clientHeight);
      if (maxTop > 0) {
        root.scrollTop = maxTop * clamp(ratio, 0, 1);
      }
    }
    pendingRestorePageRef.current = null;
    pendingRestoreScrollRatioRef.current = null;
    scheduleSync();
  }, [hasDoc, numPages, scale, sizes, scheduleSync]);

  useEffect(() => {
    if (!hasDoc || !autoFit) return;
    const root = scrollRef.current;
    if (!root) return;
    const applyFit = () => {
      const target = computeFitScale(currentPage);
      if (target === null) return;
      setScale((prev) => (Math.abs(prev - target) < 0.001 ? prev : target));
    };
    applyFit();
    const observer = new ResizeObserver(() => applyFit());
    observer.observe(root);
    return () => observer.disconnect();
  }, [autoFit, computeFitScale, currentPage, hasDoc]);

  useEffect(() => {
    if (!isTauri) return;
    let u1: (() => void) | undefined;
    let u2: (() => void) | undefined;
    let disposed = false;
    const bind = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      u1 = await listen<api.TileReadyPayload>("pdf://tile_ready", (ev) => {
        if (disposed) return;
        const active = activeReq.current.get(ev.payload.page_no);
        if (active !== ev.payload.request_id) return;
        setTilesByPage((prev) => {
          const arr = [...(prev[ev.payload.page_no] ?? [])];
          const idx = arr.findIndex((t) => t.x === ev.payload.x && t.y === ev.payload.y && t.width === ev.payload.width && t.height === ev.payload.height && Math.abs(t.zoom - ev.payload.zoom) < 0.001);
          if (idx >= 0) arr[idx] = ev.payload; else arr.push(ev.payload);
          return { ...prev, [ev.payload.page_no]: arr };
        });
      });
      u2 = await listen<string>("pdf://request_done", (ev) => {
        if (disposed) return;
        let pageNo: number | undefined;
        for (const [p, id] of activeReq.current) {
          if (id === ev.payload) { pageNo = p; break; }
        }
        if (pageNo === undefined) return;
        activeReq.current.delete(pageNo);
        const pending = pendingReq.current.get(pageNo);
        if (!pending) return;
        pendingReq.current.delete(pageNo);
        const fid = fileRef.current;
        if (!fid) return;
        void issueReq(fid, pending);
      });
    };
    void bind();
    return () => {
      disposed = true;
      if (u1) u1();
      if (u2) u2();
    };
  }, [isTauri, issueReq]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (noticeTimerRef.current !== null) {
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
      cancelAll();
    };
  }, [cancelAll]);

  useEffect(() => {
    const closeEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(null);
      setJumpOpen(false);
      if (snapshotPageNo !== null) cancelSnapshotSelection();
    };
    window.addEventListener("keydown", closeEsc, true);
    return () => window.removeEventListener("keydown", closeEsc, true);
  }, [cancelSnapshotSelection, snapshotPageNo]);

  useEffect(() => {
    if (!langMenu) return;
    const closeMenu = (e: globalThis.MouseEvent) => {
      const target = e.target as Node | null;
      if (target && langMenuRef.current?.contains(target)) return;
      setLangMenu(false);
    };
    window.addEventListener("mousedown", closeMenu, true);
    return () => window.removeEventListener("mousedown", closeMenu, true);
  }, [langMenu]);

  useEffect(() => {
    if (!menu) return;
    const closeMenu = (event: Event) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      setMenu(null);
    };
    const closeNow = () => setMenu(null);
    window.addEventListener("pointerdown", closeMenu, true);
    window.addEventListener("wheel", closeNow, { passive: true, capture: true });
    window.addEventListener("resize", closeNow, true);
    window.addEventListener("blur", closeNow);
    return () => {
      window.removeEventListener("pointerdown", closeMenu, true);
      window.removeEventListener("wheel", closeNow, true);
      window.removeEventListener("resize", closeNow, true);
      window.removeEventListener("blur", closeNow);
    };
  }, [menu]);

  useEffect(() => {
    const clearMarker = () => {
      setSelectionMarker((prev) => (prev ? null : prev));
    };

    const refreshMarker = () => {
      if (!hasDoc) {
        clearMarker();
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        clearMarker();
        return;
      }

      const range = selection.getRangeAt(selection.rangeCount - 1);
      const focusNode =
        (selection.focusNode instanceof Element
          ? selection.focusNode
          : selection.focusNode?.parentElement) ||
        (selection.anchorNode instanceof Element
          ? selection.anchorNode
          : selection.anchorNode?.parentElement) ||
        (range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement);
      const textLayer = focusNode?.closest(".textLayer");
      const pageStack = textLayer?.closest(".page-stack[data-page-no]") as HTMLElement | null;
      if (!pageStack) {
        clearMarker();
        return;
      }
      const pageNo = Number.parseInt(pageStack.dataset.pageNo || "0", 10);
      if (!Number.isFinite(pageNo) || pageNo < 1) {
        clearMarker();
        return;
      }

      const pageRect = pageStack.getBoundingClientRect();
      const rects = Array.from(range.getClientRects()).filter((rect) => {
        if (rect.height <= 1 || rect.width <= 1) return false;
        if (rect.bottom < pageRect.top || rect.top > pageRect.bottom) return false;
        return true;
      });
      if (rects.length === 0) {
        clearMarker();
        return;
      }

      const sorted = rects
        .slice()
        .sort((a, b) => (a.top === b.top ? a.left - b.left : a.top - b.top));
      const first = sorted[0];
      const firstLineRects = sorted.filter((rect) => Math.abs(rect.top - first.top) <= 2.5);
      const topPx = Math.min(...firstLineRects.map((rect) => rect.top));
      const bottomPx = Math.max(...firstLineRects.map((rect) => rect.bottom));
      const rawTop = topPx - pageRect.top;
      const rawHeight = bottomPx - topPx;
      const top = Math.max(0, Math.min(rawTop, pageRect.height - 2));
      const maxHeight = Math.max(2, pageRect.height - top);
      const height = Math.max(2, Math.min(rawHeight, maxHeight));
      setSelectionMarker({ pageNo, top, height });
    };

    const schedule = () => {
      if (selectionRafRef.current !== null) cancelAnimationFrame(selectionRafRef.current);
      selectionRafRef.current = requestAnimationFrame(() => {
        selectionRafRef.current = null;
        refreshMarker();
      });
    };

    const clearWhenOutsideText = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".textLayer")) return;
      clearMarker();
    };

    document.addEventListener("selectionchange", schedule, true);
    document.addEventListener("pointerdown", clearWhenOutsideText, true);
    document.addEventListener("mouseup", schedule, true);
    document.addEventListener("keyup", schedule, true);
    window.addEventListener("blur", clearMarker);
    window.addEventListener("resize", schedule);
    return () => {
      document.removeEventListener("selectionchange", schedule, true);
      document.removeEventListener("pointerdown", clearWhenOutsideText, true);
      document.removeEventListener("mouseup", schedule, true);
      document.removeEventListener("keyup", schedule, true);
      window.removeEventListener("blur", clearMarker);
      window.removeEventListener("resize", schedule);
      if (selectionRafRef.current !== null) {
        cancelAnimationFrame(selectionRafRef.current);
        selectionRafRef.current = null;
      }
    };
  }, [hasDoc]);

  useEffect(() => {
    if (!thumbSidebarOpen) return;
    const node = thumbItemRefs.current.get(currentPage);
    const list = thumbListRef.current;
    if (!node || !list) return;
    const targetTop = node.offsetTop - list.clientHeight / 2 + node.clientHeight / 2;
    const boundedTop = Math.max(0, Math.min(targetTop, list.scrollHeight - list.clientHeight));
    if (Math.abs(list.scrollTop - boundedTop) < 2) return;
    if (thumbFollowTimerRef.current !== null) {
      window.clearTimeout(thumbFollowTimerRef.current);
      thumbFollowTimerRef.current = null;
    }
    thumbFollowTimerRef.current = window.setTimeout(() => {
      list.scrollTo({ top: boundedTop, behavior: "smooth" });
      thumbFollowTimerRef.current = null;
    }, 42);
    return () => {
      if (thumbFollowTimerRef.current !== null) {
        window.clearTimeout(thumbFollowTimerRef.current);
        thumbFollowTimerRef.current = null;
      }
    };
  }, [currentPage, thumbSidebarOpen]);

  const clearRight = useCallback(() => {
    dragRef.current.active = false;
    dragRef.current.moved = false;
    setRightDown(false);
    setRightDrag(false);
  }, []);

  useEffect(() => {
    const clear = () => clearRight();
    window.addEventListener("mouseup", clear, true);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("mouseup", clear, true);
      window.removeEventListener("blur", clear);
    };
  }, [clearRight]);

  const onMouseDown = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (snapshotPageNo !== null) return;
    if (!hasDoc || e.button !== 2) return;
    const root = scrollRef.current;
    if (!root) return;
    setMenu(null);
    setRightDown(true);
    dragRef.current = { active: true, moved: false, sx: e.clientX, sy: e.clientY, sl: root.scrollLeft, st: root.scrollTop };
    setRightDrag(true);
  }, [hasDoc, snapshotPageNo]);

  const onMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (!hasDoc) return;
    const d = dragRef.current;
    if (!d.active) return;
    const root = scrollRef.current;
    if (!root) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) > DRAG_TH || Math.abs(dy) > DRAG_TH) d.moved = true;
    root.scrollLeft = d.sl - dx;
    root.scrollTop = d.st - dy;
    e.preventDefault();
  }, [hasDoc]);

  const onWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    if (snapshotPageNo !== null) return;
    if (!hasDoc || !rightDown) return;
    e.preventDefault();
    rightWheelAtRef.current = Date.now();
    if (e.deltaY < 0) zoomAt(e.clientX, e.clientY, 1.08);
    else zoomAt(e.clientX, e.clientY, 1 / 1.08);
  }, [hasDoc, rightDown, snapshotPageNo, zoomAt]);

  const resolvePageFromPoint = useCallback((clientX: number, clientY: number) => {
    let nearestPage = currentPage;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let pageNo = 1; pageNo <= numPages; pageNo += 1) {
      const node = pageRefs.current.get(pageNo);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        return pageNo;
      }
      const centerY = (rect.top + rect.bottom) / 2;
      const distance = Math.abs(centerY - clientY);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPage = pageNo;
      }
    }
    return nearestPage;
  }, [currentPage, numPages]);

  const onContextMenu = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (!hasDoc) return;
    e.preventDefault();
    if (snapshotPageNo !== null) return;
    if (Date.now() - rightWheelAtRef.current < 320) {
      return;
    }
    if (dragRef.current.moved) {
      dragRef.current.moved = false;
      return;
    }
    const target = e.target as HTMLElement;
    const img = target.closest(".tile-image") as HTMLImageElement | null;
    const targetPage = resolvePageFromPoint(e.clientX, e.clientY);
    const pos = clampMenuPos(e.clientX, e.clientY, img ? 270 : 236, img ? 360 : 320);
    if (img && img.src.startsWith("data:image/png;base64,")) {
      const box = img.closest(".tile-box") as HTMLDivElement | null;
      const imageBase64 = img.src.split(",")[1];
      const parsedPage = Number.parseInt(box?.dataset.pageNo || "", 10);
      setMenu({
        x: pos.x,
        y: pos.y,
        kind: "image",
        pageNo: Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : targetPage,
        imageBase64,
        imageType: detectImageTypeFromBase64(imageBase64),
        imageWidth: Number(box?.dataset.width ?? 200),
        imageHeight: Number(box?.dataset.height ?? 200),
      });
    } else {
      setMenu({ x: pos.x, y: pos.y, kind: "viewer", pageNo: targetPage });
    }
  }, [hasDoc, resolvePageFromPoint, snapshotPageNo]);

  const onViewerScroll = useCallback(() => {
    scheduleSync();
    setMenu(null);
  }, [scheduleSync]);

  const fileName = hasDoc ? fallbackFileName : t.homeTitle;
  const pageText = useMemo(() => t.pageLabel(currentPage, numPages), [currentPage, numPages, t]);
  const snapshotRect = useMemo(() => (snapshotDraft ? toSnapshotRect(snapshotDraft) : null), [snapshotDraft]);
  const homeTipCandidates = t.homeTips;
  const idleStatusText = homeTipCandidates[idleTipIndex % homeTipCandidates.length];
  const statusText = noticeText || (hasDoc
    ? (snapshotBusy
      ? t.snapBusy
      : snapshotPageNo !== null
        ? t.snapTip
        : idleStatusText)
    : t.statusReady);
  const menuPageNo = menu?.pageNo ?? currentPage;
  const toolbarCanPrev = hasDoc && currentPage > 1;
  const toolbarCanNext = hasDoc && currentPage < numPages;
  const canPrev = hasDoc && menuPageNo > 1;
  const canNext = hasDoc && menuPageNo < numPages;
  const imageSourceType = menu?.kind === "image" ? (menu.imageType || "UNKNOWN").toUpperCase() : "UNKNOWN";
  const canDirectImageSvg = imageSourceType !== "UNKNOWN";
  const imageSvgHint = canDirectImageSvg ? t.imageSvgHintDirect : t.imageSvgHintUnknown;
  const exportAllSvgText = language === "zh" ? "导出全部页 SVG" : "Export all page SVG";
  const thumbSidebarTip = t.thumbSidebar;
  const snapshotModeActive = snapshotPageNo !== null;
  const snapshotButtonTip = snapshotModeActive
    ? t.snapshotExit
    : t.mSnap;
  const toggleThumbSidebar = () => {
    setThumbSidebarOpen((prev) => !prev);
  };
  const scrollToTop = () => {
    const root = scrollRef.current;
    if (!root) return;
    root.scrollTo({ top: 0, behavior: "smooth" });
    setCurrentPage(1);
    scheduleSync();
  };
  const homeAddressPlaceholder = t.homeAddressPlaceholder;
  const homeAddressActionText = t.homeAddressOpen;
  const homeAddressHint = t.homeAddressHint;
  const homeRecentFiltered = useMemo(() => {
    const filtered = recentFiles.filter((item) => {
      if (recentFilter === "all") return true;
      const state = getPdfReadState(item);
      if (recentFilter === "reading") return state === "reading";
      if (recentFilter === "done") return state === "done";
      return true;
    });
    const sorted = [...filtered].sort((a, b) => {
      if (recentSort === "progress") {
        const progressDiff = getPdfReadProgress(b) - getPdfReadProgress(a);
        if (Math.abs(progressDiff) > 0.0001) return progressDiff;
      }
      const recentDiff = getPdfRecentReadTimestamp(b) - getPdfRecentReadTimestamp(a);
      if (recentDiff !== 0) return recentDiff;
      return getPdfReadProgress(b) - getPdfReadProgress(a);
    });
    return sorted;
  }, [recentFiles, recentFilter, recentSort]);
  const homeRecentItems = homeRecentFiltered.slice(0, 12);
  const favoriteItems = favorites.slice(0, 12);
  const homeFavoriteTitle = t.homeFavoriteTitle;
  const homeNoFavorite = t.homeNoFavorite;
  const homeAddressTitle = t.homeAddressTitle;
  const homeAddFavoriteText = t.homeAddFavorite;
  const homeSavedText = t.homeSaved;
  const isWebFavorite = (url: string) => favorites.some((item) => item.type === "web" && item.target === url);
  const isPdfFavorite = (path: string) => favorites.some((item) => item.type === "pdf" && item.target === path);
  const normalizedHomeUrl = normalizeUrl(homeUrl);
  const homeUrlSaved = normalizedHomeUrl ? isWebFavorite(normalizedHomeUrl) : false;
  const reorderFavorite = (targetId: string) => {
    if (!dragFavoriteId || !targetId || dragFavoriteId === targetId) return;
    onReorderFavorites(dragFavoriteId, targetId);
  };
  const openHomeUrl = () => {
    const normalized = normalizeUrl(homeUrl);
    if (!normalized) return;
    setHomeUrl("");
    onOpenLink(normalized);
  };

  return (
    <section className="pdf-viewer">
      {hasDoc && (
        <div className="pdf-toolbar-shell">
          <header className="pdf-toolbar">
            <div className="toolbar-left">
              <FileText size={18} />
              <span className="toolbar-file">{fileName}</span>
            </div>

            <div className="toolbar-center">
              <div className="toolbar-group">
                <button type="button" className="toolbar-icon-btn flat has-tip" data-tip={t.prev} onClick={() => goPage(currentPage - 1)} disabled={!toolbarCanPrev} aria-label={t.prev}><ChevronLeft size={16} /></button>
                <button type="button" className="toolbar-icon-btn flat has-tip" data-tip={t.next} onClick={() => goPage(currentPage + 1)} disabled={!toolbarCanNext} aria-label={t.next}><ChevronRight size={16} /></button>
              </div>
              <div className="toolbar-group">
                <button type="button" className="toolbar-icon-btn flat has-tip" data-tip={t.mOut} onClick={zoomOut} disabled={!hasDoc} aria-label={t.mOut}><ZoomOut size={16} /></button>
                <span className="toolbar-label">{Math.round(scale * 100)}%</span>
                <button type="button" className="toolbar-icon-btn flat has-tip" data-tip={t.mIn} onClick={zoomIn} disabled={!hasDoc} aria-label={t.mIn}><ZoomIn size={16} /></button>
                <button type="button" className="toolbar-text-btn has-tip" data-tip={t.fit} onClick={fitWidth} disabled={!hasDoc}>{t.fit}</button>
              </div>
            </div>

            <div className="toolbar-right">
              <div className="toolbar-pill">
                <button className="toolbar-action-btn icon-only has-tip" type="button" data-tip={t.jump} onClick={onJump} disabled={!hasDoc} aria-label={t.jump}><Search size={15} /></button>
                <button className="toolbar-action-btn icon-only has-tip" type="button" data-tip={t.mTop} onClick={scrollToTop} disabled={!hasDoc} aria-label={t.mTop}><ArrowUpToLine size={15} /></button>
              </div>
              <div className="toolbar-pill">
                <button className="toolbar-action-btn icon-only has-tip" type="button" data-tip={t.mPng} onClick={() => void exportPagePng()} disabled={!hasDoc} aria-label={t.mPng}><FileImage size={15} /></button>
                <button className="toolbar-action-btn icon-only has-tip" type="button" data-tip={t.mSvg} onClick={() => void exportPageSvg()} disabled={!hasDoc} aria-label={t.mSvg}><FileCode2 size={15} /></button>
                <button className="toolbar-action-btn icon-only has-tip" type="button" data-tip={exportAllSvgText} onClick={() => void exportAllPageSvg()} disabled={!hasDoc} aria-label={exportAllSvgText}><Files size={15} /></button>
                <button
                  className={`toolbar-action-btn icon-only has-tip ${snapshotModeActive ? "active" : ""}`}
                  type="button"
                  data-tip={snapshotButtonTip}
                  onClick={() => {
                    if (snapshotModeActive) cancelSnapshotSelection();
                    else startSnapshotSelection(currentPage);
                  }}
                  disabled={!hasDoc}
                >
                  <ScanSearch size={14} />
                </button>
              </div>
              <div className="toolbar-pill">
                <button className="toolbar-action-btn icon-only has-tip" type="button" data-tip={t.toggleBackground} onClick={cycleViewerBg} aria-label={t.toggleBackground}><Palette size={15} /></button>
                <button className={`toolbar-action-btn icon-only has-tip ${debugImageType ? "active" : ""}`} type="button" data-tip={t.debugType} onClick={toggleDebugImageType} disabled={!hasDoc} aria-label={t.debugType}><Bug size={15} /></button>
                <div ref={langMenuRef} className="toolbar-lang">
                  <button className="toolbar-action-btn icon-only has-tip" type="button" data-tip={t.lang} onClick={() => setLangMenu((v) => !v)} aria-label={t.lang}><Globe2 size={15} /></button>
                  {langMenu && (
                    <div className="toolbar-lang-menu">
                      <button type="button" onClick={() => { onLanguageChange("zh"); setLangMenu(false); }}>{t.zhName}</button>
                      <button type="button" onClick={() => { onLanguageChange("en"); setLangMenu(false); }}>{t.enName}</button>
                    </div>
                  )}
                </div>
                <button
                  className={`toolbar-action-btn icon-only has-tip ${thumbSidebarOpen ? "active" : ""}`}
                  type="button"
                  data-tip={thumbSidebarTip}
                  onClick={toggleThumbSidebar}
                  aria-label={thumbSidebarTip}
                >
                  <PanelLeft size={15} />
                </button>
              </div>
            </div>
          </header>
        </div>
      )}

      {hasDoc ? (
        <div className="pdf-workspace">
          <div ref={scrollRef} style={{ background: viewerBg }} className={`pdf-scroll-container ${rightDrag ? "right-dragging" : ""}`} onScroll={onViewerScroll} onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={clearRight} onMouseLeave={clearRight} onContextMenu={onContextMenu}>
            <div className="pdf-pages-container">
              <div className="pdf-pages-column">
                {Array.from({ length: numPages }, (_, idx) => {
                  const pageNo = idx + 1;
                  const { width, height } = getScaled(pageNo);
                  const pageStyle = {
                    width,
                    height,
                    "--scale-factor": "1",
                    "--user-unit": "1",
                  } as CSSProperties;
                  const pageTiles = pickTiles(tilesByPage[pageNo] ?? [], scale);
                  const activeText = visiblePages.has(pageNo) || true;
                  return (
                    <div className="pdf-page-block" key={pageNo}>
                      <div className="page-number-label">{pageNo}</div>
                      <div ref={(node) => { if (!node) pageRefs.current.delete(pageNo); else pageRefs.current.set(pageNo, node); }} className="page-stack" data-page-no={pageNo} style={pageStyle}>
                        <div className="page-base" style={{ width, height }} />
                        {selectionMarker?.pageNo === pageNo ? (
                          <div
                            className="page-selection-marker"
                            style={{ top: selectionMarker.top, height: selectionMarker.height }}
                          />
                        ) : null}
                        <CanvasLayer doc={doc} pageNo={pageNo} scale={scale} width={width} height={height} active={activeText} />
                        <div className="tile-overlay">
                          {pageTiles.map((tile) => {
                            const ratio = scale / Math.max(tile.zoom, 0.001);
                            return (
                              <div key={tile.tile_id} className={`tile-box ${tile.png_base64 ? "ready" : "placeholder"}`} data-page-no={pageNo} data-width={tile.width} data-height={tile.height} style={{ left: tile.x * ratio, top: tile.y * ratio, width: tile.width * ratio, height: tile.height * ratio }}>
                                {tile.png_base64 ? (
                                  <>
                                    <img className="tile-image" src={`data:image/png;base64,${tile.png_base64}`} alt="" draggable={false} />
                                  </>
                                ) : <span>{tile.x},{tile.y}</span>}
                              </div>
                            );
                          })}
                        </div>
                        <TextLayerView doc={doc} pageNo={pageNo} scale={scale} width={width} height={height} active={activeText} />
                        <LinkLayer doc={doc} pageNo={pageNo} scale={scale} width={width} height={height} active={activeText} onOpenLink={onOpenLink} onGoPage={goPage} />
                        <ImageDebugLayer doc={doc} fileId={fileId} isTauri={isTauri} pageNo={pageNo} scale={scale} width={width} height={height} active={activeText} enabled={debugImageType} />
                        {snapshotPageNo === pageNo && (
                          <div
                            className={`snapshot-select-overlay ${snapshotBusy ? "busy" : ""}`}
                            onMouseDown={(e) => onSnapshotMouseDown(pageNo, e)}
                            onMouseMove={(e) => onSnapshotMouseMove(pageNo, e)}
                            onMouseUp={(e) => onSnapshotMouseUp(pageNo, e)}
                          >
                            {snapshotRect && snapshotDraft?.pageNo === pageNo && (
                              <div
                                className="snapshot-select-rect"
                                style={{
                                  left: snapshotRect.x,
                                  top: snapshotRect.y,
                                  width: snapshotRect.width,
                                  height: snapshotRect.height,
                                }}
                              >
                                {!snapshotBusy && !snapshotDraft.dragging && (
                                  <>
                                    <span className="snapshot-handle nw" data-handle="nw" />
                                    <span className="snapshot-handle ne" data-handle="ne" />
                                    <span className="snapshot-handle sw" data-handle="sw" />
                                    <span className="snapshot-handle se" data-handle="se" />
                                    <span className="snapshot-handle n" data-handle="n" />
                                    <span className="snapshot-handle s" data-handle="s" />
                                    <span className="snapshot-handle w" data-handle="w" />
                                    <span className="snapshot-handle e" data-handle="e" />
                                  </>
                                )}
                              </div>
                            )}
                            {!snapshotBusy && snapshotRect && snapshotDraft?.pageNo === pageNo && !snapshotDraft.dragging && (
                              <div
                                className="snapshot-actions"
                                style={{ left: Math.max(8, snapshotRect.x), top: Math.max(8, snapshotRect.y - 40) }}
                              >
                                <button type="button" className="primary" onClick={confirmSnapshotExport}>{t.snapExport}</button>
                                <button type="button" onClick={() => { setSnapshotDraft(null); snapshotDraftRef.current = null; snapshotEditRef.current = null; }}>{t.snapReset}</button>
                                <button type="button" onClick={cancelSnapshotSelection}>{t.cancel}</button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {thumbSidebarOpen && (
            <aside className="pdf-thumbs-sidebar">
              <div className="pdf-thumbs-title">{t.pagesTitle}</div>
              <div className="pdf-thumbs-list" ref={thumbListRef}>
                {Array.from({ length: numPages }, (_, idx) => {
                  const pageNo = idx + 1;
                  return (
                    <PageThumbnail
                      key={pageNo}
                      doc={doc}
                      fileId={fileId}
                      pageNo={pageNo}
                      active={pageNo === currentPage}
                      onClick={goPage}
                      itemRef={(node) => {
                        if (node) thumbItemRefs.current.set(pageNo, node);
                        else thumbItemRefs.current.delete(pageNo);
                      }}
                    />
                  );
                })}
              </div>
            </aside>
          )}
        </div>
      ) : (
        <div className="home-content">
          <div className="home-surface">
            <section className="home-hero-card">
              <div className="home-hero">
                <img className="home-hero-icon" src={r0nixIcon} alt="r0nix" />
                <div className="home-hero-copy">
                  <h2>{t.homeTitle}</h2>
                  <p>{t.homeDesc}</p>
                </div>
              </div>
              <div className="home-actions">
                <button type="button" className="home-open-btn" onClick={onOpenFile}>
                  <FolderOpen size={16} />
                  <span>{t.open}</span>
                </button>
              </div>
            </section>

            <section className="home-address-card">
              <div className="home-card-title">{homeAddressTitle}</div>
              <div className="home-address-bar">
                <Globe2 size={15} />
                <input
                  type="text"
                  value={homeUrl}
                  placeholder={homeAddressPlaceholder}
                  onChange={(e) => setHomeUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") openHomeUrl();
                  }}
                />
                <button type="button" onClick={openHomeUrl} disabled={!homeUrl.trim()}>
                  {homeAddressActionText}
                </button>
                <button
                  type="button"
                  className="home-favorite-btn"
                  onClick={() => {
                    if (!normalizedHomeUrl) return;
                    const host = normalizedHomeUrl.replace(/^https?:\/\//i, "");
                    onAddWebFavorite(normalizedHomeUrl, host);
                  }}
                  disabled={!homeUrl.trim() || homeUrlSaved}
                >
                  <Star size={13} />
                  <span>{homeUrlSaved ? homeSavedText : homeAddFavoriteText}</span>
                </button>
              </div>
              <p className="home-address-hint">{homeAddressHint}</p>
            </section>

            <section className="home-recent-card">
              <div className="home-recent-head">
                <span className="home-card-title">{homeFavoriteTitle}</span>
                <span className="home-recent-count">{favoriteItems.length}</span>
              </div>
              <div className="home-favorite-list">
                {favoriteItems.length > 0 ? favoriteItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`home-favorite-item ${dragOverFavoriteId === item.id ? "drag-over" : ""}`}
                    onClick={() => onOpenFavorite(item)}
                    title={item.target}
                    draggable
                    onDragStart={() => {
                      setDragFavoriteId(item.id);
                      setDragOverFavoriteId(item.id);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragFavoriteId && dragFavoriteId !== item.id) {
                        setDragOverFavoriteId(item.id);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      reorderFavorite(item.id);
                      setDragFavoriteId("");
                      setDragOverFavoriteId("");
                    }}
                    onDragEnd={() => {
                      setDragFavoriteId("");
                      setDragOverFavoriteId("");
                    }}
                  >
                    {item.type === "web" ? <Globe2 size={14} /> : <FileText size={14} />}
                    <span className="home-favorite-main">
                      <span className="home-favorite-name">{item.title}</span>
                      <span className="home-favorite-path">{item.target}</span>
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      className="home-favorite-remove"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onRemoveFavorite(item.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRemoveFavorite(item.id);
                        }
                      }}
                    >
                      <StarOff size={12} />
                    </span>
                  </button>
                )) : <div className="home-recent-empty">{homeNoFavorite}</div>}
              </div>
            </section>

            <section className="home-recent-card">
              <div className="home-recent-head">
                <span className="home-card-title">{t.recent}</span>
                <span className="home-recent-count">{homeRecentFiltered.length}</span>
              </div>
              <div className="home-recent-tools">
                <div className="home-recent-filter-group">
                  <button
                    type="button"
                    className={`home-recent-tool-btn ${recentFilter === "all" ? "active" : ""}`}
                    onClick={() => setRecentFilter("all")}
                  >
                    {t.recentFilterAll}
                  </button>
                  <button
                    type="button"
                    className={`home-recent-tool-btn ${recentFilter === "reading" ? "active" : ""}`}
                    onClick={() => setRecentFilter("reading")}
                  >
                    {t.recentFilterReading}
                  </button>
                  <button
                    type="button"
                    className={`home-recent-tool-btn ${recentFilter === "done" ? "active" : ""}`}
                    onClick={() => setRecentFilter("done")}
                  >
                    {t.recentFilterDone}
                  </button>
                </div>
                <div className="home-recent-sort-group">
                  <button
                    type="button"
                    className={`home-recent-tool-btn ${recentSort === "recent" ? "active" : ""}`}
                    onClick={() => setRecentSort("recent")}
                  >
                    {t.recentSortRecent}
                  </button>
                  <button
                    type="button"
                    className={`home-recent-tool-btn ${recentSort === "progress" ? "active" : ""}`}
                    onClick={() => setRecentSort("progress")}
                  >
                    {t.recentSortProgress}
                  </button>
                </div>
              </div>
              <div className="home-recent">
                {homeRecentItems.length > 0 ? homeRecentItems.map((item, index) => {
                  const latestSession = item.sessions?.[0];
                  const readState = getPdfReadState(item);
                  const canResume =
                    Boolean(onContinueRecentSession) &&
                    typeof latestSession?.endPage === "number" &&
                    Number.isFinite(latestSession.endPage);
                  const lastReadText = t.recentLastRead(formatRecentTime(item.snapshot?.capturedAt || item.lastOpenedAt, language));
                  const readDurationText = t.recentReadDuration(formatReadDuration(item.totalReadSeconds, language));
                  const snapshotText = item.snapshot
                    ? t.recentSnapshot(item.snapshot.lastPage, item.snapshot.totalPages, item.snapshot.zoom)
                    : "";
                  return (
                  <button
                    key={`${item.path}-${index}`}
                    type="button"
                    className={`home-recent-item state-${readState} ${item.missing ? "missing" : ""}`}
                    title={item.path}
                    onClick={() => onOpenRecentFile(item.path)}
                  >
                    <FileText size={14} />
                    <span className="home-recent-main">
                      <span className="home-recent-header">
                        <span className="home-recent-name">{item.name}</span>
                        <span className="home-recent-kind">PDF</span>
                        {item.missing ? (
                          <span className="home-recent-missing">{t.recentMissing}</span>
                        ) : (
                          <span className={`home-recent-state ${readState}`}>
                            {readState === "done"
                              ? t.stateDone
                              : readState === "reading"
                                ? t.stateReading
                                : t.stateUnread}
                          </span>
                        )}
                      </span>
                      <span className="home-recent-meta-row">
                        <span className="home-recent-chip">{lastReadText}</span>
                        <span className="home-recent-chip">{readDurationText}</span>
                        {snapshotText ? <span className="home-recent-chip strong">{snapshotText}</span> : null}
                      </span>
                      {item.sessions && item.sessions.length > 0 ? (
                        <span className="home-recent-sessions">{t.recentSessions(formatRecentSessions(item.sessions, language))}</span>
                      ) : null}
                      {item.sessions && item.sessions.length > 0 && onContinueRecentSession ? (
                        <span className="home-recent-session-jumps">
                          {item.sessions
                            .filter(
                              (session) =>
                                typeof session.endPage === "number" &&
                                Number.isFinite(session.endPage)
                            )
                            .slice(0, 2)
                            .map((session, idx) => (
                              <span
                                key={`${item.path}-jump-${idx}`}
                                role="button"
                                tabIndex={0}
                                className="home-recent-jump-chip"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  onContinueRecentSession(item.path, {
                                    endPage: session.endPage!,
                                    endZoom: session.endZoom,
                                    endAutoFit: session.endAutoFit,
                                    endScrollTopRatio: session.endScrollTopRatio,
                                  });
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onContinueRecentSession(item.path, {
                                      endPage: session.endPage!,
                                      endZoom: session.endZoom,
                                      endAutoFit: session.endAutoFit,
                                      endScrollTopRatio: session.endScrollTopRatio,
                                    });
                                  }
                                }}
                              >
                                {t.jumpPageChip(session.endPage!)}
                              </span>
                            ))}
                        </span>
                      ) : null}
                    </span>
                    <span className="home-recent-actions">
                      {canResume ? (
                        <span
                          role="button"
                          tabIndex={0}
                          className="home-recent-resume"
                          title={t.continueReading}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onContinueRecentSession?.(item.path, {
                              endPage: latestSession.endPage!,
                              endZoom: latestSession.endZoom,
                              endAutoFit: latestSession.endAutoFit,
                              endScrollTopRatio: latestSession.endScrollTopRatio,
                            });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onContinueRecentSession?.(item.path, {
                                endPage: latestSession.endPage!,
                                endZoom: latestSession.endZoom,
                                endAutoFit: latestSession.endAutoFit,
                                endScrollTopRatio: latestSession.endScrollTopRatio,
                              });
                            }
                          }}
                        >
                          {t.continueReading}
                        </span>
                      ) : null}
                      {item.missing && onRelocateRecentFile ? (
                        <span
                          role="button"
                          tabIndex={0}
                          className="home-recent-locate"
                          title={t.locateFile}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onRelocateRecentFile(item.path);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onRelocateRecentFile(item.path);
                            }
                          }}
                        >
                          <FolderOpen size={12} />
                        </span>
                      ) : null}
                      <span
                        role="button"
                        tabIndex={0}
                        className="home-favorite-remove"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const target = favorites.find((fav) => fav.type === "pdf" && fav.target === item.path);
                          if (target) onRemoveFavorite(target.id);
                          else onAddPdfFavorite(item.path, item.name);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            const target = favorites.find((fav) => fav.type === "pdf" && fav.target === item.path);
                            if (target) onRemoveFavorite(target.id);
                            else onAddPdfFavorite(item.path, item.name);
                          }
                        }}
                      >
                        {isPdfFavorite(item.path) ? <StarOff size={12} /> : <Star size={12} />}
                      </span>
                    </span>
                  </button>
                );
                }) : <div className="home-recent-empty">{homeRecentFiltered.length === 0 && recentFiles.length > 0 ? t.noRecentMatch : t.noRecent}</div>}
              </div>
            </section>
          </div>
        </div>
      )}

      <footer className="pdf-status-bar">
        <span className="status-meta">{hasDoc ? `${pageText} · ${Math.round(scale * 100)}%` : ""}</span>
        <span className="status-hint">{statusText}</span>
      </footer>

      {jumpOpen && (
        <div className="viewer-dialog-backdrop" onMouseDown={() => setJumpOpen(false)}>
          <div className="viewer-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="viewer-dialog-title">{t.jumpTitle}</div>
            <input
              type="number"
              min={1}
              max={numPages}
              value={jumpInput}
              onChange={(e) => setJumpInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmJump();
                if (e.key === "Escape") setJumpOpen(false);
              }}
              autoFocus
            />
            <div className="viewer-dialog-actions">
              <button type="button" onClick={() => setJumpOpen(false)}>{t.cancel}</button>
              <button type="button" className="primary" onClick={confirmJump}>{t.jumpConfirm}</button>
            </div>
          </div>
        </div>
      )}

      {menu && (
        <>
          <div className="viewer-context-backdrop" onMouseDown={() => setMenu(null)} />
          <div ref={menuRef} className="viewer-context-menu" style={{ left: menu.x, top: menu.y }}>
            {menu.kind === "viewer" ? (
              <>
                <div className="context-menu-title">{t.viewerMenu}</div>
                <div className="context-menu-group">
                  <div className="context-menu-group-title">{t.grpNav}</div>
                  <button type="button" onClick={() => { goPage(menuPageNo - 1, { behavior: "auto" }); setMenu(null); }} disabled={!canPrev}><ChevronLeft size={14} /><span>{t.mPrev}</span></button>
                  <button type="button" onClick={() => { goPage(menuPageNo + 1, { behavior: "auto" }); setMenu(null); }} disabled={!canNext}><ChevronRight size={14} /><span>{t.mNext}</span></button>
                </div>
                <div className="context-menu-group">
                  <div className="context-menu-group-title">{t.grpZoom}</div>
                  <button type="button" onClick={() => { zoomIn(); setMenu(null); }}><ZoomIn size={14} /><span>{t.mIn}</span></button>
                  <button type="button" onClick={() => { zoomOut(); setMenu(null); }}><ZoomOut size={14} /><span>{t.mOut}</span></button>
                </div>
                <div className="context-menu-group">
                  <div className="context-menu-group-title">{t.grpExport}</div>
                  <button type="button" onClick={() => { void exportPagePng(); setMenu(null); }}><FileImage size={14} /><span>{t.mPng}</span></button>
                  <button type="button" onClick={() => { void exportPageSvg(); setMenu(null); }}><FileCode2 size={14} /><span>{t.mSvg}</span></button>
                  <button type="button" onClick={() => { void exportAllPageSvg(); setMenu(null); }}><Files size={14} /><span>{exportAllSvgText}</span></button>
                  <button type="button" onClick={() => { startSnapshotSelection(menuPageNo); setMenu(null); }}><ScanSearch size={14} /><span>{t.mSnap}</span></button>
                </div>
              </>
            ) : (
              <>
                <div className="context-menu-title">{t.imgTitle}</div>
                <div className="context-menu-subtitle">{t.imgSource(imageSourceType)}</div>
                <div className="context-menu-subtitle">{imageSvgHint}</div>
                <div className="context-menu-group">
                  <div className="context-menu-group-title">{t.grpExport}</div>
                  <button
                    type="button"
                    onClick={() => {
                      if (menu.imageBase64) {
                        const width = menu.imageWidth || 200;
                        const height = menu.imageHeight || 200;
                        if (canDirectImageSvg) {
                          const wrappedSvg = buildWrappedSvg(menu.imageBase64, width, height);
                          previewExportedImage(wrappedSvg, menu.pageNo, width, height, "SVG");
                        } else {
                          previewExportedImage(menu.imageBase64, menu.pageNo, width, height, "PNG");
                        }
                      }
                      setMenu(null);
                    }}
                  >
                    <Search size={14} />
                    <span>{t.imgPreview}</span>
                  </button>
                  <button type="button" onClick={() => { if (menu.imageBase64) void exportImageByFormat(menu.imageBase64, menu.pageNo, menu.imageWidth || 200, menu.imageHeight || 200); setMenu(null); }}><Search size={14} /><span>{t.imgExport}</span></button>
                  {imageSourceType !== "JPG" && (
                    <button type="button" onClick={() => { if (menu.imageBase64) void exportImagePng(menu.imageBase64, menu.pageNo); setMenu(null); }}><FileImage size={14} /><span>{t.imgPng}</span></button>
                  )}
                  {imageSourceType !== "PNG" && imageSourceType !== "UNKNOWN" && (
                    <button type="button" onClick={() => { if (menu.imageBase64) void exportImageJpg(menu.imageBase64, menu.pageNo); setMenu(null); }}><FileImage size={14} /><span>{t.imgJpg}</span></button>
                  )}
                  <button type="button" onClick={() => { if (menu.imageBase64) void exportImageSvg(menu.imageBase64, menu.pageNo, menu.imageWidth || 200, menu.imageHeight || 200); setMenu(null); }}><FileCode2 size={14} /><span>{t.imgSvg}</span></button>
                  {!canDirectImageSvg && (
                    <button type="button" onClick={() => { startSnapshotSelection(menu.pageNo); setMenu(null); }}><ScanSearch size={14} /><span>{t.mSnap}</span></button>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export default PDFViewer;
