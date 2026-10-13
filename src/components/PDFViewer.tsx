import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from"react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Hand,
  Highlighter,
  History,
  Image as ImageIcon,
  Link2,
  ExternalLink,
  Languages,
  List,
  Maximize,
  MessageSquare,
  MousePointer2,
  Pencil,
  Search,
  Sparkles,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  X,
  ZoomIn,
  ZoomOut,
} from"lucide-react";
import type { PDFDocumentProxy } from"pdfjs-dist";
import * as api from"../services/pdfApi";
import type { AppLanguage } from"../services/userSettings";
import type {
  PdfReadingBlock,
  PdfViewState,
  ReaderAnnotation,
  ReaderAnnotationKind,
  ReaderAnnotationRect,
  ReaderNote,
} from"../types";
import type { PDFImageInfo } from"../services/pdfApi";
import { ContextMenu, buildViewerContextActions } from"./ContextMenu";
import { ReadingAssistMenu, type ReadingAssistSelection } from"./ReadingAssistMenu";
import { useCompanionDwell, sampleCompanionFocus } from "./pdfReader/useCompanionDwell";
import { isNonProseRegion } from "../services/companionDwell";
import {
  clearAssistHistory,
  loadAssistHistory,
  newAssistHistoryId,
  persistAssistHistoryEntry,
  type AssistHistoryEntry,
} from"../services/assistHistory";
import { renderAssistantMarkdown } from"../services/assistantMarkdown";
import {
  isBlockDismissed,
  loadDismissedBlocks,
  dismissCompanionBlock,
  buildCompanionMarker,
  findCompanionMarker,
  canAddCompanionMarker,
  companionAnchorPosition,
  companionAnchorsOnPage,
  visibleCompanionMarkersOnPage,
  placeCompanionMarginCards,
  MARGIN_CARD_WIDTH,
  COMPANION_ANCHOR_SIZE,
  COMPANION_ANCHOR_HIT_SLOP,
  COMPANION_ANCHOR_DOT_SIZE,
  COMPANION_ANCHOR_Z_INDEX,
  type CompanionIntensity,
} from "../services/readingCompanion";
import { CompanionMarginCard } from "./pdfReader/CompanionMarginCard";
import { pickSuggestionForBlock, type CompanionSuggestion } from "../services/companionSuggestion";
import {
  suggestReadingCompanion,
  translateReadingBlock,
  translateReadingBlocks,
  translateReadingSelection,
  type LlmServiceConfig,
  type TranslationBlockResult,
} from"../services/readingAssistant";
import { loadTranslationCache, saveTranslationCache } from"../services/translationCache";
import { loadResourceIndex, saveResourceIndex } from"../services/resourceIndexCache";
import { isPinchGesture, pinchZoomFactor, wheelZoomStep } from "../services/pdfZoomGesture";
import { useGesture } from "@use-gesture/react";
import"./PDFViewer.css";
import { PageCanvas } from"./pdfReader/PageCanvas";
import {
  TextLayerMarker,
  clientRectFromRanges,
  rangesFromNormalizedRect,
} from "./pdfReader/textLayerMarker";
import { PageThumbnail } from"./pdfReader/PageThumbnail";
import { ToolButton } from"./pdfReader/ToolButton";
import {
  ACTIVE_NEIGHBOR,
  DEFAULT_PAGE_SIZE,
  I18N,
  PAGE_METADATA_IDLE_MS,
  PAGE_RENDER_OVERSCAN_WHILE_ZOOMING,
  ZOOM_ANIMATION_EASE,
  ZOOM_ANIMATION_SETTLE,
  ZOOM_RENDER_COMMIT_DELAY_MS,
  ZOOM_RENDER_READY_FALLBACK_MS,
  clampPage,
  clampZoomValue,
  cleanBaseName,
  compareReadingBlockOrder,
  createTextRect,
  cropPngBase64,
  dedupeImageCandidates,
  equalSet,
  findReadingBlockIdForRect,
  getAnnotationBadgeStyle,
  getAnnotationOverlayStyle,
  getDraftOverlayStyle,
  getPdfPageWithResourceTimeout,
  imageBlockToCandidate,
  imageTargetKey,
  isAnnotationTool,
  isLineAnnotationTool,
  isLikelyImageCandidate,
  normalizeImageBbox,
  normalizeRect,
  pageNumberAtViewportCenter,
  snapAnnotationRectToLines,
  resolveOutlinePage,
  resourceCacheIdentity,
  toOutlineEntries,
  withResourceScanTimeout,
  type DocumentDoiResource,
  type DocumentLinkResource,
  type DraftAnnotation,
  type ImageContextTarget,
  type OutlineEntry,
  type PageSize,
  type ResourceScanState,
  type SidebarTab,
  type ToolType,
  type ViewerContextMenuState,
} from"./pdfReader/readerCore";

/**
 * 空标注清单的**共享常量**。
 *
 * 为什么不能就地写 `[]`：`PageCanvas` 的波浪线 effect 依赖 `wavyAnnotations` 的
 * **身份**（它要判断"这页的标注变了没"）。而数组字面量每次父组件渲染都是新引用，
 * 于是父组件每渲染一次，**每个活跃页**都要重跑一遍该 effect —— 而它的第一件事是
 * `getPdfTextSpans(textLayer)`，逐个 span 调 `getBoundingClientRect`
 * （每次都是强制同步布局冲刷）。
 *
 * 实测（2026-10-10，WebKit，200 页重页夹具，6 秒连续滚动）：
 *   · 该 effect 执行 465 次；
 *   · `getBoundingClientRect` 29,079 次、合计 924ms；
 *   · 同期慢帧相对 17ms 基线的超额总量 ≈900ms —— **正好被这一条吃干**；
 *   · 同一份代码在 Chromium 上同样 37k 次只要 187ms，所以它只在 WebKit
 *     （= Tauri 的 WKWebView）上显形：Chromium 满帧、WebKit 掉 20% 的帧。
 *
 * 空结果换成同一个常量引用，effect 就不会因为「父组件重渲染」而空跑。
 * 非空结果仍会换引用（那是真的变了），所以 `readTextSpans` 的平移复用
 * 也必须同时在位 —— 两者是「少跑」与「跑得便宜」的关系，缺一不可。
 */
const EMPTY_ANNOTATIONS: ReaderAnnotation[] = [];

/**
 * 缩放预览写在页流上的那个 CSS 变量名。
 *
 * 预览缩放是 `flow.style.transform = scale(v)`（GPU 合成，一整条页流一次变换），
 * 代价是**页流里的每一个后代都被放大** —— 而页流里既有「应该被放大」的
 * 页面内容（canvas / 文本层 / 标注层，按页面归一化坐标锚定），
 * 也有「不该被放大」的 UI chrome（伴读批注卡：264px 定宽 + CSS px 字号）。
 *
 * 于是要有一个**逆比例**给后者用。放 CSS 变量而不是逐节点写 transform：
 * 逆比例每帧都变，逐节点写就是每帧 N 次样式写入；变量只需与预览 transform
 * **在同一处**写一次，抵消交给 CSS（`.pdf-flow-ui-chrome`，见 PDFViewer.css）。
 */
const ZOOM_PREVIEW_INVERSE_VAR = "--reader-zoom-preview-inv";

/**
 * 把「预览缩放」写进页流：transform 与逆比例**必须成对**。
 *
 * 刻意做成一个函数而不是两处各写一行：这两者的失效形态不同，
 * 漏写逆比例只是让批注卡被抻大（看得出、不致命），
 * 而漏清 transform 会让页面**双重放大**（提交后旧 transform 还在）。
 * 收在一个地方，才有「谁写谁清」这个唯一的责任点。
 */
function applyZoomPreviewScale(flow: HTMLElement | null, visualScale: number, originX: number, originY: number) {
  if (!flow) return;
  flow.style.transformOrigin = `${originX}px ${originY}px`;
  if (Math.abs(visualScale - 1) < 0.0001) {
    flow.style.transform = "";
    flow.style.removeProperty(ZOOM_PREVIEW_INVERSE_VAR);
    return;
  }
  flow.style.transform = `scale(${visualScale})`;
  flow.style.setProperty(ZOOM_PREVIEW_INVERSE_VAR, String(1 / visualScale));
}

/** 清掉预览缩放（transform / origin / 逆比例三者一起）。 */
function clearZoomPreviewScale(flow: HTMLElement | null, options?: { keepOrigin?: boolean }) {
  if (!flow) return;
  flow.style.transform = "";
  if (!options?.keepOrigin) flow.style.transformOrigin = "";
  flow.style.removeProperty(ZOOM_PREVIEW_INVERSE_VAR);
}

interface PDFViewerProps {
  title: string;
  documentId?: string;
  documentFileSize?: number;
  fileId?: string;
  language: AppLanguage;
  notes: ReaderNote[];
  annotations: ReaderAnnotation[];
  onOpenFileDialog?: () => void;
  onAddNote?: (
    page: number,
    content: string,
    kind: ReaderNote["kind"],
    reference?: string,
    source?: { documentId?: string; blockId?: string; sourceRect?: ReaderNote["sourceRect"] },
  ) => void;
  onUpdateNote?: (noteId: string, content: string) => void;
  onRemoveNote?: (noteId: string) => void;
  onAddAnnotation?: (annotation: Omit<ReaderAnnotation,"id" |"createdAt">) => void;
  onRemoveAnnotation?: (annotationId: string) => void;
  onResolveDefaultPath?: (fileName: string) => string;
  onProgress?: (page: number, totalPages: number) => void;
  initialViewState?: PdfViewState;
  onViewStateChange?: (state: PdfViewState) => void;
  onOpenExternal?: (url: string) => void;
  onOpenLinkInApp?: (url: string) => void;
  aiModelConfig: LlmServiceConfig;
  /** 伴读总开关（settings.companionEnabled）。关闭时采集端不注册任何监听。 */
  companionEnabled?: boolean;
  /**
   * 密度档位（settings.companionIntensity）。`off` 档下**连停留采集都不启动** ——
   * 采集了又不提示，等于白跑一个计时器。
   */
  companionIntensity?: CompanionIntensity;
  /**
   * 伴读提示出现时，是否顺手在那一块上留一条波浪线标记（settings.companionAutoAnnotate）。
   *
   * 它**独立于** `companionEnabled`：自动标注是静态的、可预期的，不是弹窗，
   * 不构成打扰。但也只在「模型真的给了提示」时才画 —— 没有提示就没有可标记的难懂处。
   */
  companionAutoAnnotate?: boolean;
  /**
   * 标记的**每页预算**档位（settings.companionAutoAnnotateIntensity）。
   *
   * 与 `companionIntensity` 是两件事：那个管提问的密度，这个管纸上留痕的量。
   * `off` 档下不留任何标记，但提示照常出现 —— 想被提醒、不想弄脏纸面的人要的
   * 就是这个组合。
   */
  companionMarkerIntensity?: CompanionIntensity;
  /** 气泡里是否提供快捷提问与追问入口（settings.companionQuickAsk）。 */
  companionQuickAsk?: boolean;
}

export function PDFViewer({
  title,
  documentId,
  fileId,
  language,
  notes,
  annotations,
  onOpenFileDialog,
  onAddNote,
  onUpdateNote,
  onRemoveNote,
  onAddAnnotation,
  onRemoveAnnotation,
  onResolveDefaultPath,
  initialViewState,
  onViewStateChange,
  onProgress,
  onOpenExternal,
  onOpenLinkInApp,
  aiModelConfig,
  documentFileSize,
  companionEnabled = false,
  companionIntensity = "medium",
  companionAutoAnnotate = true,
  companionMarkerIntensity = "medium",
  companionQuickAsk = true,
}: PDFViewerProps) {
  const [zoom, setZoom] = useState(() => clampZoomValue(initialViewState?.zoom ?? 100));
  const [renderZoom, setRenderZoom] = useState(() => clampZoomValue(initialViewState?.zoom ?? 100));
  const [page, setPage] = useState(() => Math.max(1, Math.round(initialViewState?.page ?? 1)));
  const [totalPages, setTotalPages] = useState(1);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * 首屏纸面是否已经画出来。
   *
   * ## 为什么 `loading` 不能一个人扛
   *
   * `loading` 等的是目录解析（`getOutline`）。目录通常几十毫秒就回，
   * 而 canvas 渲染大页要几百毫秒 —— 于是 `loading` 先关、纸面后画，
   * 中间那段就是「一片空白且没有任何提示」，正是 2026-10-08 反馈的现象。
   *
   * 所以加载态要等**真正画完**这个信号，而不是「准备工作做完了」。
   * 两个状态并存：`loading`（准备中）/ `firstPagePainted`（首屏已出），
   * 遮罩取二者的或，保证空白期一定有东西可看。
   */
  const [firstPagePainted, setFirstPagePainted] = useState(false);
  const [renderError, setRenderError] = useState("");
  const [actionHint, setActionHint] = useState("");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("thumbs");
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
  const [activeTool, setActiveTool] = useState<ToolType>("select");
  const [readerMode, setReaderMode] = useState<"reader" |"translation" |"image-label">("reader");
  const [outlineEntries, setOutlineEntries] = useState<OutlineEntry[]>([]);
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({});
  const [activePages, setActivePages] = useState<Set<number>>(new Set([1, 2, 3]));
  const [contextMenu, setContextMenu] = useState<ViewerContextMenuState>({
    x: 0,
    y: 0,
    isOpen: false,
    pageNo: 1,
    imageTarget: null,
  });
  const [selectedImageKey, setSelectedImageKey] = useState<string | null>(null);
  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteDraft, setEditingNoteDraft] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [draftAnnotation, setDraftAnnotation] = useState<DraftAnnotation | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [isGestureRightDown, setIsGestureRightDown] = useState(false);
  const [lockedZoomPage, setLockedZoomPage] = useState<number | null>(null);
  const [pdfImagesByPage, setPdfImagesByPage] = useState<Record<number, PDFImageInfo[]>>({});
  const [readingBlocksVersion, setReadingBlocksVersion] = useState(0);
  const [imageLabelStatus, setImageLabelStatus] = useState<{
    kind:"idle" |"loading" |"ready" |"error";
    message: string;
  }>({ kind:"idle", message:"" });
  const [isImageExportOpen, setIsImageExportOpen] = useState(false);
  const [assistSelection, setAssistSelection] = useState<ReadingAssistSelection | null>(null);
  const [translationPanel, setTranslationPanel] = useState<{
    selection: ReadingAssistSelection;
    answer: string;
    status: string;
    isLoading: boolean;
  } | null>(null);
  const [fullTranslation, setFullTranslation] = useState<{
    status: string;
    completed: number;
    total: number;
    results: TranslationBlockResult[];
    isLoading: boolean;
  }>({ status:"", completed: 0, total: 0, results: [], isLoading: false });
  const fullTranslationResultsRef = useRef<TranslationBlockResult[]>([]);
  const [sidePanelView, setSidePanelView] = useState<"notes" |"translation" |"resources" |"history">("notes");
  /** 本文档的 AI 记录（翻译 / 问问 AI / 解释），持久化见 services/assistHistory.ts。 */
  const [assistHistory, setAssistHistory] = useState<AssistHistoryEntry[]>([]);
  const assistHistoryRef = useRef<AssistHistoryEntry[]>([]);
  assistHistoryRef.current = assistHistory;
  const [linksByPage, setLinksByPage] = useState<Record<number, DocumentLinkResource[]>>({});
  const [resourceTextByPage, setResourceTextByPage] = useState<Record<number, string>>({});
  const [resourceScannedPages, setResourceScannedPages] = useState<number[]>([]);
  const [resourceScan, setResourceScan] = useState<ResourceScanState>({
    status:"idle",
    completed: 0,
    total: 0,
    failedPages: [],
  });
  const [resourceScanAttempt, setResourceScanAttempt] = useState(0);
  const t = I18N[language];
  const annotationLabels = useMemo<Record<ReaderAnnotationKind, string>>(
    () => ({
      highlight: t.highlight,
      underline: t.underline,
      strike: t.strikethrough,
      text: t.addText,
      wavy: t.wavy,
    }),
    [t.addText, t.highlight, t.strikethrough, t.underline, t.wavy],
  );
  /**
   * DEV 诊断探针总开关（**长期保留**，2026-10-09 用户裁决）。
   * `window.__r0nixAssistLog`（devAssistLog：openCompanionForBlock /
   * handleAssistSelection / followUpdate 时间线）从这里取电 —— 气泡定位类
   * 假红（挂载竞态、滚动跟随漂移）靠它区分「应用错了」还是「测量早了」。
   * 生产构建（import.meta.env.DEV=false）下零开销。
   */
  const DEV_PROBE = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  /** DEV 诊断：assist 气泡的所有写入点都留痕，e2e 在断言失败时倾倒这份时间线。 */
  const devAssistLog = (tag: string, payload: Record<string, unknown>) => {
    if (!DEV_PROBE) return;
    const store = (window as unknown as Record<string, unknown>).__r0nixAssistLog as Array<unknown> | undefined;
    const log = Array.isArray(store) ? store : [];
    log.push({ t: Date.now(), tag, ...payload });
    (window as unknown as Record<string, unknown>).__r0nixAssistLog = log;
  };

  const gestureStartRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * 右键手势状态。
   *
   * `zoomAtStart` 是**「这次右键手势到底有没有缩放」**的唯一判据。
   *
   * 为什么需要它：右键按住 + 滚轮是「缩放」手势，而滚轮**不移动指针** ——
   * 于是 `moved` 恒为 false，松手时 `endRightGesture` 把这次手势判成
   * 「原地右键点击」，弹出上下文菜单。实测（2026-10-10，WebKit）：右键按住滚 3 拍，
   * 松手后菜单必开（探针 `probe-pdf-overlay-scale` 的「松手后菜单是否打开」= 是）。
   * 读者每缩放一次就被弹一次菜单，所以这是「缩放频繁触发右键菜单打开」。
   *
   * 判据选「缩放目标变了多少」而不是「onWheel 有没有被调用」：
   * 缩放有三条入口（右键滚轮 / 触控板捏合 / 库的 pinch 引擎），
   * 逐个在回调里打标记就得改三处、且漏一处就静默失效；
   * 而它们最终都落到 `zoomTargetRef` 上，比一次差值就全覆盖了。
   */
  const rightDragRef = useRef<{
    active: boolean;
    moved: boolean;
    pointerId: number | null;
    pageNo: number | null;
    zoomAtStart: number | null;
  }>({
    active: false,
    moved: false,
    pointerId: null,
    pageNo: null,
    zoomAtStart: null,
  });
  const suppressNextContextMenuRef = useRef(false);
  const rightWindowHandlersRef = useRef<{
    onMove: (event: PointerEvent) => void;
    onUp: (event: PointerEvent) => void;
    onCancel: (event: PointerEvent) => void;
  } | null>(null);

  const onProgressRef = useRef(onProgress);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const thumbListRef = useRef<HTMLDivElement | null>(null);
  const thumbItemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const thumbnailObserverRef = useRef<IntersectionObserver | null>(null);
  const thumbnailVisibilityHandlersRef = useRef<Map<number, (visible: boolean) => void>>(new Map());
  const rafRef = useRef<number | null>(null);
  const zoomAnimationRef = useRef<number | null>(null);
  const zoomRenderCommitTimerRef = useRef<number | null>(null);
  const zoomLockReleaseTimerRef = useRef<number | null>(null);
  const zoomTargetRef = useRef(zoom);
  const zoomPreviewRef = useRef(zoom);
  const renderZoomRef = useRef(renderZoom);
  const zoomRenderReadyRef = useRef(false);
  const pageRef = useRef(page);
  const viewStateRef = useRef<PdfViewState | undefined>(initialViewState);
  const viewStateTimerRef = useRef<number | null>(null);
  const isRestoringViewRef = useRef(false);
  const suppressSyncUntilRef = useRef(0);
  const thumbJumpUntilRef = useRef(0);
  /**
   * 缩放锚点：**预览 transform 的全部输入**。
   *
   * `originX/originY` 是锚点在页流 border box **本地坐标系**里的位置 ——
   * 也就是 `transform-origin` 需要的那个值。
   *
   * ⚠️ 它必须和 `viewportX/viewportY` 在**同一次量测**里得到。
   * 这两者曾经分开存在（`zoomAnchorRef` + `zoomFlowBaseRef`），
   * 于是「有锚点但没有基准」成为一种可表达的状态，而代码用
   * `base ? … : 0` 兜底 —— 2026-10-10 实测：按住右键时页流被
   * `handleViewerPointerDown` 提前锁页，`applyZoomTarget` 里那段
   * 「首次锁页才采基准」的分支被整段跳过，基准恒为 null，
   * 预览于是恒以 `transform-origin: 0 0`（页流左上角）缩放 ——
   * **光标下的内容会顺着左上角滑走**（60 页夹具实测：光标在页内的
   * 归一化位置 0.5 → 0.357 → 0.26 → 0.19 → 0.098，连滚 5 拍后
   * 已经滑掉 4/5 个页宽）。
   * 合并成一个对象之后，「有锚点却算不出原点」在类型上就不可表达了。
   */
  const zoomAnchorRef = useRef<{
    pageNo: number;
    relX: number;
    relY: number;
    viewportX: number;
    viewportY: number;
    /** 锚点在页流本地坐标系里的位置（= 预览 transform 的原点）。 */
    originX: number;
    originY: number;
  } | null>(null);
  const lockedZoomPageRef = useRef<number | null>(null);
  /**
   * 提交 `renderZoom` 时要补的那次滚动（见 scheduleRenderZoomCommit 与
   * 紧随其后的 useLayoutEffect）。
   *
   * 为什么必须补：预览是 `scale()` **绕锚点**缩放，而提交后页流是
   * **绕自己的左上角**按新尺寸重排的 —— 两者原点不同。只修原点不补滚动的话，
   * 手势期间跟手、一提交就整体跳走。2026-10-10 实测（172%，光标在页心）：
   * 提交瞬间光标下的内容纵向跳 285px。
   *
   * 存的是**采集时的快照**，不是引用 —— 提交那一刻 zoomAnchorRef 会被清掉。
   */
  const pendingZoomAnchorRestoreRef = useRef<{
    pageNo: number;
    relX: number;
    relY: number;
    viewportX: number;
    viewportY: number;
  } | null>(null);

  /** 所有页的直接父容器 —— 缩放预览作用在它上面，而不是某一页。 */
  const pageFlowRef = useRef<HTMLDivElement | null>(null);
  const readingBlocksByPageRef = useRef<Map<number, PdfReadingBlock[]>>(new Map());
  /**
   * 当前展开的伴读批注卡（margin note，2026-10-09）。
   *
   * 卡片本身随标注生灭、挂在页侧批注栏里随文档滚动；这个 id 只表达
   * 「外部唤出命中的是哪一张」—— 命中的卡展开并自动发问一次。
   * null = 没有外部唤出，所有卡保持收起（读者仍可手动展开任意一张）。
   */
  const [activeMarginCardId, setActiveMarginCardId] = useState<string | null>(null);
  /**
   * 待展开的块：显式唤出时卡还在预热路上（标记没落纸），先记下块 id，
   * 标记落纸的那一刻由 effect 补展开。null = 没有待展开的块。
   */
  const [pendingActivateBlockId, setPendingActivateBlockId] = useState<string | null>(null);
  /** 滚动容器宽度 —— 批注栏宽度 =（pane 宽 − 页宽）/ 2 的钳制值，随它重算。 */
  const [paneWidth, setPaneWidth] = useState(0);
  const companionAbortRef = useRef<AbortController | null>(null);
  /**
   * 伴读提示的按块缓存，key 是 blockId。
   *
   * 存在理由见 requestCompanionSuggestion 的缓存段：模型调用已前移到停留判定，
   * 只有缓存能让「点开即读」成立，而不是把等待从点击时挪到别处。
   *
   * 带 `blockText` 是为了防「id 复用但内容已变」—— 同页重解析后blockId 可能重复，
   * 那时拿回旧答案等于答非所问，比答不出来更糟。
   */
  const suggestionCacheRef = useRef(
    new Map<string, { suggestion: CompanionSuggestion; blockText: string }>()
  );
  /**
   * 态 A 的那块块：停留达标后只留锚点，读者点它才展开气泡。
   * null = 当前没有等待被点开的锚点。
   */
  const [companionSeedBlockId, setCompanionSeedBlockId] = useState<string | null>(null);
  /** 气泡锚在哪一块上（page + 归一化矩形）。滚动时按它重算气泡位置，气泡才会跟着走。 */
  const assistAnchorRef = useRef<{ page: number; rect: ReaderAnnotationRect } | null>(null);
  /**
   * 当前批注表的 ref。伴读要在「模型给了提示」的那一刻查重并补一条波浪线，
   * 那一刻发生在异步回调里 —— 直接用闭包里的 `annotations` 会读到发起请求时的
   * 旧表，于是同一块被标两次。
   */
  const annotationsRef = useRef<readonly ReaderAnnotation[]>(annotations);
  annotationsRef.current = annotations;

  /**
   * 向模型要「这一块该怎么问」，并把结果筛到停留块上。
   *
   * **三种失败形态在 UI 上完全一致**：不显示提示卡，气泡退化成普通阅读辅助工具栏。
   * 未配置 / 网络错 / 超时 / 模型说这页没什么可问的 / 模型挑了别的块 —— 都不提示。
   * 理由：伴读是主动找上门的，它失败时不该再占用一次注意力去报错；
   * 而「提示挂在错误的块上」比不提示更坏，所以最后一道过滤放在这里。
   */
  const requestCompanionSuggestion = (
    block: PdfReadingBlock,
    // 预留的静默标记位：dwell 预热传 { silent: true }。当前所有调用都是预热
    // （没有前台等待路径了），参数保留是为了调用点语义自明、日后好接。
    _options?: { silent?: boolean }
  ) => {
    // 否定性记忆的第一道闸，且必须排在请求之前 —— 被 dismiss 过的块连模型都不该问。
    //
    // 为什么这道闸不能只留在 dwell 的 isDismissed 里：那边只守自动触发，而工具栏
    // 的「伴读」按钮走的是同一个 openCompanionForBlock，读者可以自由落在任意块上。
    // 漏了这道闸的后果是：读者删掉一条波浪线，点一下工具栏，AI 又在同一句画回来 ——
    // 而「否定性记忆比正向标注更重要」正是这套设计里最该守住的一条。
    //
    // （2026-10-09：伴读改为页侧批注卡后，「显式请求绕过本闸」的通道不复存在 ——
    // 手动唤出只是展开已存在的批注卡，不再发起新请求。否定集合从此管住一切：
    // 被拒绝的块既不会重新画线，也不会长出新的卡。）
    if (documentId && isBlockDismissed(loadDismissedBlocks(), documentId, block.id)) {
      return;
    }
    /**
     * 命中缓存：**这一块已经问过了，直接跳过请求**。
     *
     * 预热路径（dwell 的 silent 调用）靠它去重 —— 停留判定会对同一块反复
     * fire，没有这道闸就是反复烧模型。缓存会随 page / 文档切换清空，
     * 避免拿旧文档的答案回答新文档的同一块。
     */
    const cached = suggestionCacheRef.current.get(block.id);
    if (cached && cached.blockText === block.text) return;
    companionAbortRef.current?.abort();
    const controller = new AbortController();
    companionAbortRef.current = controller;
    void (async () => {
      try {
        const suggestions = await suggestReadingCompanion({
          config: aiModelConfig,
          documentTitle: title,
          page: block.page,
          blocks: readingBlocksByPageRef.current.get(block.page) ?? [],
          intensity: companionIntensity,
          focusedBlockId: block.id,
          signal: controller.signal,
        });
        if (controller.signal.aborted || companionAbortRef.current !== controller) return;
        const suggestion = pickSuggestionForBlock(suggestions, block.id) ?? null;
        // 写缓存，供后续预热去重（见函数头的缓存说明）。
        // 存 blockText 是为了防「块内容已变但 id 复用」时拿回过期答案。
        if (suggestion) {
          suggestionCacheRef.current.set(block.id, {
            suggestion,
            blockText: block.text,
          });
        }
        // 有提示才留标记：波浪线的语义是「这里可能难懂」，而「难懂在哪」就是模型
        // 给出的这句疑问。没有提示就没有可标记的难懂处 —— 此时画线只会变成
        // 「不知道为什么这里有条线」，比不画更糟。
        //
        // ⚠️ 否定集合在这里**独立于上面的请求闸**再查一遍：被读者拒绝过的块
        // 绝不能画线 —— 「删掉一条波浪线，点一下工具栏，AI 又画回来」正是这里要拦的。
        if (
          suggestion &&
          companionAutoAnnotate &&
          onAddAnnotation &&
          !(documentId && isBlockDismissed(loadDismissedBlocks(), documentId, block.id))
        ) {
          // 两道闸：① 同一块不叠第二条（去重）；② 这一页的标记预算还没用完。
          // 少任何一道，反复唤出伴读都会把纸面画满一模一样的波浪线。
          if (
            !findCompanionMarker(annotationsRef.current, block.id) &&
            canAddCompanionMarker(annotationsRef.current, {
              page: block.page,
              intensity: companionMarkerIntensity,
            })
          ) {
            // 划线范围同样是整块（段落）——与停留触发路径保持同一语义，
            // 理由见 onFire 内的注释（2026-10-09「划线只在一行」反馈）。
            const marker = buildCompanionMarker({
              documentId,
              block: { id: block.id, page: block.page, rect: block.rect },
              question: suggestion.question,
              reason: suggestion.reason,
            });
            if (marker) onAddAnnotation(marker);
          }
        }
      } catch {
        // 预热失败**静默**：读者根本没看见这次请求，弹错误才是打扰。
        // 该块没有标记、没有卡 —— 下一次停留触发会再给一次机会。
      } finally {
        if (companionAbortRef.current === controller) {
          companionAbortRef.current = null;
        }
      }
    })();
  };

  /** 激活某张批注卡：展开、自动发问一次，并滚进视口。 */
  const activateMarginCard = useCallback((markerId: string) => {
    devAssistLog("openCompanionForBlock", { markerId });
    // 从态 A 进入态 B：种子锚点已被点开，撤掉「等待点开」的高亮态。
    setCompanionSeedBlockId(null);
    setActiveMarginCardId(markerId);
    // 卡可能位于视口外（锚点贴近屏幕边缘 / 唤出来自工具栏）——滚到最近可见。
    requestAnimationFrame(() => {
      const card = scrollRef.current?.querySelector(`[data-margin-card-id="${markerId}"]`);
      card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }, []);

  /**
   * 唤出伴读 —— 自动停留触发的锚点点击与工具栏手动唤出**共用这一条路径**。
   *
   * 不共用就会长出两套「入口落在哪」的判定，两套判定迟早会飘开。
   *
   * 2026-10-09 起伴读是**页侧批注卡**：唤出 = 展开该块的卡并滚进视口。
   * 卡还在预热路上（模型没回来）时先记下「待展开」的块，标记落纸的那一刻
   * 由下方的 effect 补展开 —— 显式唤出不该让读者再点第二次。
   * 被「暂不提示」的块在本闸直接告知：否定集合管住一切再唤出。
   */
  const openCompanionForBlock = useCallback(
    (block: PdfReadingBlock) => {
      // 与停留触发**同一条**版面过滤。
      // 两条路径共用 openCompanionForBlock 是刻意的（避免两套入口判定），
      // 所以过滤也必须共用：否则读者手动点页眉就能把伴读叫到页眉上，
      // 绕过自动触发时那道闸。
      if (isNonProseRegion(block)) {
        showActionHint(t.companionNoProse);
        return;
      }
      const marker = findCompanionMarker(annotationsRef.current, block.id);
      if (marker) {
        activateMarginCard(marker.id);
        return;
      }
      // 没有卡：被拒绝的块直接告知；没被拒绝的块可能是预热还没回来 ——
      // 补发一次预热请求，标记落纸后由 effect 自动展开。
      if (documentId && isBlockDismissed(loadDismissedBlocks(), documentId, block.id)) {
        showActionHint(t.companionDismissedHint);
        return;
      }
      setPendingActivateBlockId(block.id);
      requestCompanionSuggestion(block, { silent: true });
    },
    // requestCompanionSuggestion / activateMarginCard 每次渲染换身份，
    // 但它们只是动作不是语义输入；写进来会让锚点点击回调每次渲染都变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t.companionNoProse, t.companionDismissedHint, activateMarginCard, documentId],
  );

  // 「待展开」的块等到自己的标记落纸：展开它的卡。
  // 预热失败（模型没给提示）时标记永远不会出现，pending 静置无害 ——
  // 下一次唤出会重新走一遍，且否定集合 / 预算的闸都在上游。
  useEffect(() => {
    if (!pendingActivateBlockId) return;
    const marker = findCompanionMarker(annotationsRef.current, pendingActivateBlockId);
    if (!marker) return;
    setPendingActivateBlockId(null);
    activateMarginCard(marker.id);
    // annotationsVersion 是标注表的变化信号（annotations prop 每次渲染都是新引用）。
  }, [pendingActivateBlockId, annotations, activateMarginCard]);

  /**
   * 批注栏宽度需要显式测量：页流是 `w-fit`（fit-content），CSS 弹性空槽
   * 在其中会收缩到 0，量不出「页面两侧到底有多少空地」。
   * 窗口缩放、侧栏开合都体现为滚动容器尺寸变化，ResizeObserver 一次接住。
   */
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const measure = () => setPaneWidth(root.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [scrollRef]);

  /**
   * 手动唤出时没有量出焦点块时的兜底：取当前页里**正文最长**的那一段。
   *
   * 为什么是「最长」而不是「第一个」：pdf.js 的 DOM 块顺序按文本流，页眉、页码、
   * 作者行都排在正文前面。取第一个会把气泡挂在页眉上。
   */

  /**
   * 批注卡的「暂不提示」—— 语义与旧浮动气泡完全一致：
   * 写入否定集合（打扰度判据唯一的输入）+ 连波浪线一起收掉。
   * 只清卡、留着线，读者看到的是「说不提示了但线还在」，会以为按钮没生效。
   */
  const handleMarginCardDismiss = useCallback(
    (annotation: ReaderAnnotation) => {
      const blockId = annotation.blockId;
      if (documentId && blockId) {
        dismissCompanionBlock(loadDismissedBlocks(), documentId, blockId);
      }
      if (onRemoveAnnotation) onRemoveAnnotation(annotation.id);
      companionAbortRef.current?.abort();
      setCompanionSeedBlockId(null);
      setActiveMarginCardId((current) => (current === annotation.id ? null : current));
    },
    [documentId, onRemoveAnnotation],
  );

  /** 批注卡的问答入历史 —— 与划词面板共用同一份历史仓库。 */
  const handleMarginCardAnswer = useCallback(
    (annotation: ReaderAnnotation, question: string, answer: string) => {
      const block = annotation.blockId
        ? (readingBlocksByPageRef.current.get(annotation.page) || []).find(
            (item) => item.id === annotation.blockId
          )
        : undefined;
      recordAssistHistory({
        kind: "ask",
        reference: `${title} / page ${annotation.page}`,
        page: annotation.page,
        excerpt: (block?.text ?? annotation.content ?? "").slice(0, 2000),
        question,
        result: answer,
        model: aiModelConfig.model,
      });
    },
    [title, aiModelConfig.model],
  );

  /**
   * 手动唤出时没有量出焦点块时的兜底：取当前页里**正文最长**的那一段。
   *
   * 为什么是「最长」而不是「第一个」：pdf.js 的 DOM 块顺序按文本流，页眉、页码、
   * 作者行都排在正文前面。取第一个会把气泡挂在页眉上。
   */
  const firstCompanionBlockOnPage = useCallback((pageNo: number): PdfReadingBlock | null => {
    const blocks = readingBlocksByPageRef.current.get(pageNo) || [];
    let best: PdfReadingBlock | null = null;
    for (const block of blocks) {
      // 排除判据与另两条路径共用，不在这里另写一套 `kind === "image"` ——
      // 上一版就是这么写的，结果「最长」的兜底仍然可能挑中页脚：
      // 页脚常有很长的版权行，长度上完全可能赢过正文。
      if (isNonProseRegion(block)) continue;
      if (!best || block.text.length > best.text.length) best = block;
    }
    return best;
  }, []);

  /**
   * 伴读采集端：停留 2.5s 后**只留锚点，不弹气泡**（态 A种子），读者点锚点才展开。
   *
   * 为什么不沿用「停留达标即弹气泡」：伴读是主动找上门的功能，而读者视线刚落定
   * 那一刻恰恰最不该被弹窗打断 —— 弹窗遮正文、要立刻做决定，而此刻读者还没读完
   * 上下文，无从判断这个提示值不值得。设计稿把这一步拆成两段正是为此。
   *
   * 判定全在 `services/companionDwell.ts`（纯函数、有单测），这里只做 DOM 测量与计时。
   * 关闭开关时 hook 内部不注册任何 scroll 监听，也不起 interval。
   */
  useCompanionDwell({
    enabled: companionEnabled && companionIntensity !== "off",
    scrollRef,
    pageRefs,
    blocksByPageRef: readingBlocksByPageRef,
    isDismissed: (blockId) =>
      documentId ? isBlockDismissed(loadDismissedBlocks(), documentId, blockId) : false,
    onFire: (block) => {
      // ⚠️ 版面区域过滤必须在**最前面**。
      // 页眉、页脚、页码、图表说明不该被伴读盯上：读者刚打开文档时
      // 视线落在首页页眉上，而那一行他百分之百没在读。这类误报比漏报伤害大得多 ——
      // 读者会认定「这个功能吵」，然后整体关掉（2026-10-08 反馈）。
      if (isNonProseRegion(block)) return;

      // 态 A：落锚点 + **顺带把模型问出来**。
      //
      // 为什么模型调用在这里而不是读者点锚点时（2026-10-08 反馈「点了还要等」）：
      // 读者点开的心智是「我要看答案」，让他等一次完整往返（首 token 常要 1–2s）
      // 是白付的代价。而停留判定已经证明「他在这块停了足够久」——
      // 这次调用的命中率本来就最高，此刻不call 更待何时。
      // 配套的两道闸见 requestCompanionSuggestion：同块去重 + abort 取消上一轮。
      if (!findCompanionMarker(annotationsRef.current, block.id) && onAddAnnotation) {
        const canAnnotate = canAddCompanionMarker(annotationsRef.current, {
          page: block.page,
          intensity: companionAutoAnnotate ? companionMarkerIntensity : "off",
        });
        if (canAnnotate) {
          // 划线范围 = 整个阅读块（段落）——伴读的「句」就是块：提示卡引用的
          // 原文是 block.text，波浪线却只画一行的话，读者看到的是「半句有线」
          // （2026-10-09 反馈「划线还是只在一行，不是一整句」）。
          // 渲染侧按 span 中心点命中，多行矩形天然画出多行波浪线。
          const marker = buildCompanionMarker({
            documentId,
            block: { id: block.id, page: block.page, rect: block.rect },
            question: block.text,
          });
          if (marker) onAddAnnotation(marker);
        }
      }
      // 先落后台问；结果到了读者早就点开了。失败/取消不打扰 ——
      // 静默即可，读者真点进去时还有一次机会拿到提示。
      void requestCompanionSuggestion(block, { silent: true });
      setCompanionSeedBlockId(block.id);
    },
  });

  /**
   * 气泡跟随滚动：锚点是「块在页面里的归一化矩形」，滚动只改页面元素的屏幕位置，
   * 所以每帧按锚点重算一次即可。
   *
   * 不这么做的话气泡会钉在第一次弹出的屏幕坐标上：读者一滚，它就跟所指的段落
   * 脱开，看上去像「提示指错了地方」，甚至被滚出可视区后彻底消失。
   */
  useEffect(() => {
    if (!assistSelection || !assistAnchorRef.current) return;
    const root = scrollRef.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const anchor = assistAnchorRef.current;
      if (!anchor) return;
      const element = pageRefs.current.get(anchor.page);
      const rect = element?.getBoundingClientRect();
      if (!rect) return;
      const x = rect.left + anchor.rect.x * rect.width;
      const y = rect.top + anchor.rect.y * rect.height;
      setAssistSelection((previous) => {
        if (!previous) return previous;
        devAssistLog('followUpdate', { x, y, scrollTop: scrollRef.current?.scrollTop ?? null });
        if (Math.abs(previous.x - x) < 0.5 && Math.abs(previous.y - y) < 0.5) return previous;
        return { ...previous, x, y };
      });
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // 布局位移不只来自滚动：左侧栏开合、面板伸缩都会平移页面元素，
    // 但它们既不发 scroll 事件也不改 window 尺寸 —— 只监听这两样，
    // 气泡会拿着过期坐标钉在原地（2026-10-09 反馈「被固定了位置」，
    // 实测气泡落在了 PDF 面板之外的侧栏上方）。观察滚动容器自身的
    // 尺寸变化即可覆盖这类位移；缩放/换页引起的滚动由上面的 scroll 接住。
    let layoutObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      layoutObserver = new ResizeObserver(schedule);
      layoutObserver.observe(root);
    }
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      layoutObserver?.disconnect();
    };
  }, [assistSelection?.id, assistSelection?.blockId, scrollRef]);

  // 卸载时收掉在途请求：否则它会在没有组件承接的时候继续 setState。
  useEffect(() => () => companionAbortRef.current?.abort(), []);
  const readingBlocksInFlightRef = useRef<Map<string, Promise<PdfReadingBlock[]>>>(new Map());
  const readingBlocksAbortRef = useRef<Map<string, AbortController>>(new Map());
  const pdfImagesByPageRef = useRef<Record<number, PDFImageInfo[]>>({});
  const imageDetectionInFlightRef = useRef<
    Map<
      number,
      {
        promise: Promise<PDFImageInfo[]>;
        controller: AbortController;
        consumers: number;
        settled: boolean;
      }
    >
  >(new Map());
  const readingBlocksLoadRef = useRef<Promise<PdfReadingBlock[]> | null>(null);
  const readingBlocksLoadAbortRef = useRef<AbortController | null>(null);
  const readingBlocksLoadedFileRef = useRef<string | null>(null);
  const fullTranslationAbortRef = useRef<AbortController | null>(null);
  const translationRetryAbortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const resourcesScanRef = useRef(0);
  const resourceScanAbortRef = useRef<AbortController | null>(null);
  const translationAbortRef = useRef<AbortController | null>(null);
  const resourceCacheLoadedRef = useRef(false);
  const resourceCacheLoadGenerationRef = useRef(0);
  const linksByPageRef = useRef<Record<number, DocumentLinkResource[]>>({});
  const resourceTextByPageRef = useRef<Record<number, string>>({});
  const resourceScannedPagesRef = useRef<Set<number>>(new Set());
  const imageTargetAtPointRef = useRef<(pageNo: number, clientX: number, clientY: number) => ImageContextTarget | null>(
    () => null,
  );
  const detectPageImagesRef = useRef<
    (pageNo: number, signal?: AbortSignal) => Promise<PDFImageInfo[] | undefined>
  >(async () => []);
  /**
   * ⚠️ 为什么这里也要存一份 ref：`prefetchImageLabelsAround` 依赖 `getVisibleImagesForPage`，
   * 而后者依赖 `pdfImagesByPage` / `pageSizes` —— 这两个几乎每次渲染都是新引用。
   * 于是 prefetch 的**函数身份每次渲染都变**，一旦把它写进 effect 依赖，同一页的图片扫描
   * 就会被反复发起再被 cleanup 取消（实测 page 1 出现 30 次 get_page_images→cancel）。
   * effect 只该在「换文件 / 换页」时跑一次，所以通过 ref 拿最新实现，断掉这条抖动链。
   */
  const prefetchImageLabelsAroundRef = useRef<(centerPage: number) => void>(() => {});
  const loadPageReadingBlocksRef = useRef<(pageNo: number, signal?: AbortSignal) => Promise<PdfReadingBlock[]>>(
    async () => [],
  );
  const contextPointRef = useRef<{ pageNo: number; x: number; y: number } | null>(null);

  const hasDoc = Boolean(fileId && pdfDoc);
  const currentFileIdRef = useRef(fileId);
  currentFileIdRef.current = fileId;
  const pdfFingerprint =
    pdfDoc?.fingerprints?.find((value): value is string => typeof value ==="string" && value.trim().length > 0) ||"";
  const resourceCacheKey = resourceCacheIdentity(documentId || fileId ||"", documentFileSize, pdfFingerprint);
  const renderZoomScale = useMemo(() => Math.max(0.5, renderZoom / 100), [renderZoom]);
  const visiblePage = lockedZoomPage ?? page;
  renderZoomRef.current = renderZoom;

  /**
   * 缩略图可见性登记表。
   *
   * 回调参数是**双向**的（进入 / 离开都上报）：侧栏缩略图的 `<canvas>` 只在
   * 视口 ±240px 内才挂载，靠的就是「离开」这一侧 —— 只报进入的话，200 页文档里
   * 那 200 个 canvas 会永久常驻，实测这就是连续滚动残余 12% 慢帧的主因。
   */
  const registerThumbnailVisibility = useCallback((pageNo: number, onVisibilityChange: ((visible: boolean) => void) | null) => {
    if (onVisibilityChange) thumbnailVisibilityHandlersRef.current.set(pageNo, onVisibilityChange);
    else thumbnailVisibilityHandlersRef.current.delete(pageNo);
  }, []);

  useEffect(() => {
    const root = thumbListRef.current;
    if (!root || typeof IntersectionObserver ==="undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNo = Number((entry.target as HTMLElement).dataset.thumbnailPage);
          if (!Number.isInteger(pageNo)) continue;
          // 双向上报：`isIntersecting` 为假时收件方会**卸载 canvas**（见 PageThumbnail）。
          thumbnailVisibilityHandlersRef.current.get(pageNo)?.(entry.isIntersecting);
        }
      },
      { root, rootMargin:"240px" },
    );
    thumbnailObserverRef.current = observer;
    root.querySelectorAll<HTMLElement>("[data-thumbnail-page]").forEach((node) => observer.observe(node));
    return () => {
      observer.disconnect();
      thumbnailObserverRef.current = null;
      thumbnailVisibilityHandlersRef.current.clear();
    };
  }, [fileId]);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  const pageNotes = useMemo(() => notes.filter((note) => note.page === page), [notes, page]);
  const pageNumbers = useMemo(() => Array.from({ length: totalPages }, (_, index) => index + 1), [totalPages]);
  const annotationsByPage = useMemo(() => {
    const grouped = new Map<number, ReaderAnnotation[]>();
    for (const annotation of annotations) {
      const pageAnnotations = grouped.get(annotation.page) || [];
      pageAnnotations.push(annotation);
      grouped.set(annotation.page, pageAnnotations);
    }
    return grouped;
  }, [annotations]);
  /**
   * 标注数组的单调版本号。
   *
   * `annotations` 的身份每渲染一次就变，把它直接写进 PageCanvas 的 effect 依赖
   * 会让**每一页**的文本层标注在每次父渲染时重算一遍 —— 一页几百个 span 的
   * `getBoundingClientRect` 加一次全量切分，静置状态下就能吃掉整帧。
   * 版本号只在标注真的增删改时前进，依赖它才是廉价的。
   */
  const [annotationsVersion, setAnnotationsVersion] = useState(0);
  useEffect(() => {
    setAnnotationsVersion((value) => value + 1);
  }, [annotations]);

  /**
   * 每页的 `TextLayerMarker` 注册表。
   *
   * 波浪线的绘制必须在 PageCanvas 内部完成（只有它有 `textDivs` 映射），
   * 但**锚点定位**需要反过来查「这条标注实际命中了哪几段文字」——
   * 而这只能问 marker。所以这里收下实例，锚点渲染时用它的 `clientRectFromRanges`
   * 拿真实包围盒，而不是用标注的并集 rect。
   */
  const textLayerMarkersRef = useRef<Map<number, TextLayerMarker>>(new Map());
  /**
   * marker 注册/注销时递增的版本号。
   *
   * marker 存在 ref 里、注册发生在子组件的 effect 里，两件事都不会引起
   * React 渲染 —— 但锚点位置依赖 marker（要查实际命中的文字片段）。
   * 所以这里必须显式 bump 一次版本，把「marker 变了」翻译成一次重渲染，
   * 否则锚点会一直停在「marker 还没就绪」时算出的退化位置（用并集 rect）。
   */
  const [markerRevision, setMarkerRevision] = useState(0);
  /**
   * 把「marker 已注册」这件事本身当成一个可派生值。
   *
   * `textLayerMarkersRef` 是 ref，改它不引起渲染；而锚点位置依赖 marker。
   * 与其让下游到处读计数器，不如在这里就把它固化成 `markersByPage` 这个
   * memo —— 依赖 markerRevision，marker 一变整张表就重算，锚点自然跟上。
   */
  const markersByPage = useMemo(() => {
    void markerRevision;
    return new Map(textLayerMarkersRef.current);
  }, [markerRevision]);
  const handleTextLayerMarker = useCallback((pageNo: number, marker: TextLayerMarker | null) => {
    if (marker) textLayerMarkersRef.current.set(pageNo, marker);
    else textLayerMarkersRef.current.delete(pageNo);
    setMarkerRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    const markers = textLayerMarkersRef.current;
    return () => {
      markers.clear();
    };
  }, []);

  const pageAnnotations = useMemo(
    () =>
      annotations
        .filter((annotation) => annotation.page === page)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [annotations, page],
  );
  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.id === selectedAnnotationId) || null,
    [annotations, selectedAnnotationId],
  );

  useEffect(() => {
    viewStateRef.current = initialViewState;
  }, [initialViewState]);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (!isGestureRightDown && !suppressNextContextMenuRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => window.removeEventListener("contextmenu", onContextMenu, true);
  }, [isGestureRightDown]);

  useEffect(() => {
    if (!selectedAnnotationId || !onRemoveAnnotation) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !=="Delete" && event.key !=="Backspace") return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      ) {
        return;
      }
      onRemoveAnnotation(selectedAnnotationId);
      setSelectedAnnotationId(null);
      showActionHint(t.annotationDeleted);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRemoveAnnotation, selectedAnnotationId]);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    const restoredPage = Math.max(1, Math.round(initialViewState?.page ?? 1));
    viewStateRef.current = initialViewState;
    isRestoringViewRef.current = Boolean(fileId && initialViewState);
    if (zoomAnimationRef.current !== null) {
      window.cancelAnimationFrame(zoomAnimationRef.current);
      zoomAnimationRef.current = null;
    }
    for (const node of pageRefs.current.values()) {
      node.style.transform ="";
      node.style.transformOrigin ="";
    }
    if (zoomRenderCommitTimerRef.current !== null) {
      window.clearTimeout(zoomRenderCommitTimerRef.current);
      zoomRenderCommitTimerRef.current = null;
    }
    if (zoomLockReleaseTimerRef.current !== null) {
      window.clearTimeout(zoomLockReleaseTimerRef.current);
      zoomLockReleaseTimerRef.current = null;
    }
    setPage(restoredPage);
    const restoredZoom = clampZoomValue(initialViewState?.zoom ?? 100);
    zoomTargetRef.current = restoredZoom;
    zoomPreviewRef.current = restoredZoom;
    setZoom(restoredZoom);
    setRenderZoom(restoredZoom);
    setRenderError("");
    setPageSizes({});
    setActivePages(new Set([clampPage(restoredPage - 1, Number.MAX_SAFE_INTEGER), restoredPage, restoredPage + 1]));
    setDraftAnnotation(null);
    setSelectedAnnotationId(null);
    lockedZoomPageRef.current = null;
    setLockedZoomPage(null);
    setSidebarTab("thumbs");
    setIsNotesOpen(false);
    setLinksByPage({});
    linksByPageRef.current = {};
    setResourceTextByPage({});
    resourceTextByPageRef.current = {};
    resourceScannedPagesRef.current = new Set();
    setResourceScannedPages([]);
    setResourceScan({ status:"idle", completed: 0, total: 0, failedPages: [] });
    setResourceScanAttempt(0);
    resourceScanAbortRef.current?.abort(new DOMException("The document changed","AbortError"));
    resourceScanAbortRef.current = null;
    resourcesScanRef.current += 1;
    setPdfImagesByPage({});
    pdfImagesByPageRef.current = {};
    for (const task of imageDetectionInFlightRef.current.values()) {
      if (!task.settled) task.controller.abort(new DOMException("The document changed","AbortError"));
    }
    imageDetectionInFlightRef.current.clear();
    resourceCacheLoadedRef.current = false;
    setReadingBlocksVersion(0);
    setImageLabelStatus({ kind:"idle", message:"" });
    readingBlocksByPageRef.current.clear();
    for (const controller of readingBlocksAbortRef.current.values()) {
      controller.abort(new DOMException("The document changed","AbortError"));
    }
    readingBlocksAbortRef.current.clear();
    readingBlocksInFlightRef.current.clear();
    readingBlocksLoadAbortRef.current?.abort(new DOMException("The document changed","AbortError"));
    readingBlocksLoadAbortRef.current = null;
    readingBlocksLoadedFileRef.current = null;
    readingBlocksLoadRef.current = null;
    fullTranslationAbortRef.current?.abort();
    fullTranslationAbortRef.current = null;
    translationRetryAbortRef.current?.abort();
    translationRetryAbortRef.current = null;
    translationAbortRef.current?.abort();
    translationAbortRef.current = null;
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setIsSearching(false);
    setTranslationPanel(null);
    fullTranslationResultsRef.current = [];
    setFullTranslation({ status:"", completed: 0, total: 0, results: [], isLoading: false });

    if (!fileId) {
      setPdfDoc(null);
      setTotalPages(1);
      setOutlineEntries([]);
      setLoading(false);
      setFirstPagePainted(false);
      return;
    }

    const cached = api.getPdfDocument(fileId);
    if (!cached) {
      setPdfDoc(null);
      setTotalPages(1);
      setOutlineEntries([]);
      setLoading(false);
      setFirstPagePainted(false);
      setRenderError(t.pdfNotLoaded);
      return;
    }

    setLoading(true);
    // ⚠️ 必须重置首屏就绪标记。换文档时若沿用上一份的 true，
    // 新文档还没画出第一帧，遮罩就已经撤掉 —— 又是空白无提示。
    setFirstPagePainted(false);
    // ⚠️ 伴读缓存**必须**跟着文档一起清。
    // 不清的话，新文档里恰好有同id 的块时，会直接读到上一份文档的答案 ——
    // 读者看到一段「解释」却对不上眼前这句话，比没有解释更糟。
    suggestionCacheRef.current.clear();
    setPdfDoc(cached);
    setTotalPages(Math.max(1, cached.numPages || 1));

    let disposed = false;
    const loadingGuard = window.setTimeout(() => {
      if (!disposed) setLoading(false);
    }, 260);

    /**
     * 首屏遮罩的兜底闸。
     *
     * ⚠️ 这条兜底是必需的，不是保险起见：`firstPagePainted` 只由「canvas 真的画完」
     * 推进，而渲染失败（加密文件、损坏的 xref、字体缺失导致 render task reject）时
     * 那一行代码根本不会执行。没有兜底的话，遮罩会**永久**盖住整个文档 ——
     * 那比空白无提示严重得多：读者以为应用卡死，连关闭文档的入口都点不到。
     *
     * 12 秒足够慢机器渲染完一张大页；超时后放行，让错误提示（`renderError`）露出来，
     * 至少读者还能看到原因。宁可展示一个空壳，也不要展示一个打不开的界面。
     */
    const paintGuard = window.setTimeout(() => {
      if (!disposed) setFirstPagePainted(true);
    }, 12_000);

    void cached
      .getOutline()
      .then(async (items) => {
        if (disposed) return;
        const entries = toOutlineEntries(items);
        const resolved = await Promise.all(
          entries.map(async (entry) => ({
            ...entry,
            page: await resolveOutlinePage(cached, entry.destination),
          })),
        );
        if (disposed) return;
        setOutlineEntries(resolved);
      })
      .catch(() => {
        if (disposed) return;
        setOutlineEntries([]);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
      window.clearTimeout(loadingGuard);
      window.clearTimeout(paintGuard);
    };
  }, [fileId, t.pdfNotLoaded]);

  useEffect(() => {
    if (!pdfDoc) return;
    return () => {
      // Keep the PDFDocumentProxy cached so switching back to this tab does
      // not reopen the file, but release page-level fonts and common objects
      // held by PDF.js while the viewer is unmounted or replaced.
      try {
        pdfDoc.cleanup();
      } catch {
        // PDF.js can reject cleanup while a render task is winding down. The
        // page effects cancel their tasks independently during unmount.
      }
    };
  }, [pdfDoc]);

  useEffect(() => {
    if (!resourceCacheKey || typeof window ==="undefined") return;
    const loadGeneration = ++resourceCacheLoadGenerationRef.current;
    resourceCacheLoadedRef.current = false;
    const cached = loadResourceIndex(resourceCacheKey);
    if (cached) {
      setPdfImagesByPage(cached.images);
      pdfImagesByPageRef.current = cached.images;
      setLinksByPage(cached.links);
      linksByPageRef.current = cached.links;
      setPageSizes(cached.pageSizes);
      setResourceTextByPage(cached.textByPage);
      resourceTextByPageRef.current = cached.textByPage;
      const cachedScannedPages = cached.scannedPages;
      resourceScannedPagesRef.current = new Set(cachedScannedPages);
      setResourceScannedPages(cachedScannedPages);
    }
    queueMicrotask(() => {
      if (resourceCacheLoadGenerationRef.current === loadGeneration) {
        resourceCacheLoadedRef.current = true;
      }
    });
  }, [fileId, resourceCacheKey]);

  useEffect(() => {
    if (!resourceCacheKey || !resourceCacheLoadedRef.current || typeof window ==="undefined") return;
    saveResourceIndex(resourceCacheKey, {
      images: pdfImagesByPage,
      links: linksByPage,
      pageSizes,
      scannedPages: resourceScannedPages,
      textByPage: resourceTextByPage,
    });
  }, [linksByPage, pageSizes, pdfImagesByPage, resourceCacheKey, resourceScannedPages, resourceTextByPage]);

  useEffect(() => {
    setPage((prev) => clampPage(prev, totalPages));
  }, [totalPages]);

  useEffect(() => {
    if (selectedAnnotationId && !annotations.some((annotation) => annotation.id === selectedAnnotationId)) {
      setSelectedAnnotationId(null);
    }
  }, [annotations, selectedAnnotationId]);

  const updatePageSize = useCallback((pageNo: number, width: number, height: number) => {
    setPageSizes((prev) => {
      const existing = prev[pageNo];
      const safeWidth = Math.max(1, Math.round(width));
      const safeHeight = Math.max(1, Math.round(height));
      if (existing && existing.width === safeWidth && existing.height === safeHeight) {
        return prev;
      }
      return { ...prev, [pageNo]: { width: safeWidth, height: safeHeight } };
    });
  }, []);

  const emitViewState = useCallback(
    (next: Partial<PdfViewState>) => {
      if (!fileId || !onViewStateChange) return;
      const root = scrollRef.current;
      const merged: PdfViewState = {
        page,
        totalPages,
        zoom,
        scrollTop: root?.scrollTop ?? viewStateRef.current?.scrollTop ?? 0,
        scrollLeft: root?.scrollLeft ?? viewStateRef.current?.scrollLeft ?? 0,
        updatedAt: new Date().toISOString(),
        ...next,
      };
      viewStateRef.current = merged;
      if (viewStateTimerRef.current !== null) {
        window.clearTimeout(viewStateTimerRef.current);
      }
      viewStateTimerRef.current = window.setTimeout(() => {
        viewStateTimerRef.current = null;
        onViewStateChange(merged);
      }, 120);
    },
    [fileId, onViewStateChange, page, totalPages, zoom],
  );
  const isTranslationReader = readerMode ==="translation";
  /**
   * 左键是否归「文本选中」。这与右键分工无关 —— 拖拽页面走右键（handleViewerPointerDown
   * 里 button === 2 的分支），左键从来不负责平移。左键的争夺发生在**批注 overlay** 上：
   *   select       → overlay 让路（pointer-events: none），左键穿透到 pdf.js 文本层
   *   hand         → overlay 收事件，左键用来点已有批注、打开笔记
   *   （这是 Acrobat 的 Hand / Select 分工：Hand 下选不中文字是约定，不是缺陷）
   *   行类标注工具 → overlay 让路：左键做**文本选择**，mouseup 的选区直接落成标注
   *                  （2026-10-09 用户裁决「标注应该和选择文本是同一个操作」）。
   *                  见 commitSelectionAnnotation —— 拖拽坐标绘制的老路已退役。
   *   text（便签） → overlay 收事件，左键拖放对话框（唯一的 overlay 绘制残留）
   *
   * ★ 这个判定有两个消费方：PageCanvas 的 enableTextLayer 与 overlay 的 pointer-events。
   * 它们必须同源 —— 只改一处会得到「文本层渲染了、但被 overlay 挡住」，看得见却选不中，
   * 且不报任何错，是这类分层里最难排查的形态。
   */
  const textSelectionEnabled = activeTool ==="select" || isTranslationReader || isLineAnnotationTool(activeTool);
  const isImageLabelReader = readerMode ==="image-label";
  const handleAssistSelection = useCallback(
    (selection: Omit<ReadingAssistSelection,"id" |"sourceTitle">) => {
      // 划词气泡也要跟随滚动：与伴读气泡共用 assistAnchorRef —— 锚在「页 + 归一化矩形」上，
      // 滚动跟随 effect（见下）按它逐帧重算。缺了这一步，气泡钉在第一次弹出的屏幕坐标，
      // 一滚就跟所指文本脱开，甚至被滚出视口。
      assistAnchorRef.current =
        selection.page != null && selection.sourceRect
          ? { page: selection.page, rect: selection.sourceRect }
          : null;
      devAssistLog('handleAssistSelection', { y: selection.y, x: selection.x, reference: selection.reference });
      setAssistSelection({
        ...selection,
        id:`translation-${selection.reference}-${Date.now()}`,
        sourceTitle: title,
      });
      setIsNotesOpen(true);
      setSidePanelView("translation");
    },
    [title],
  );

  useEffect(() => {
    return () => {
      if (viewStateTimerRef.current !== null) {
        window.clearTimeout(viewStateTimerRef.current);
      }
      if (zoomAnimationRef.current !== null) {
        window.cancelAnimationFrame(zoomAnimationRef.current);
      }
      for (const node of pageRefs.current.values()) {
        node.style.transform ="";
        node.style.transformOrigin ="";
      }
      if (zoomRenderCommitTimerRef.current !== null) {
        window.clearTimeout(zoomRenderCommitTimerRef.current);
      }
      if (zoomLockReleaseTimerRef.current !== null) {
        window.clearTimeout(zoomLockReleaseTimerRef.current);
      }
      searchAbortRef.current?.abort();
      exportAbortRef.current?.abort();
      resourceScanAbortRef.current?.abort(new DOMException("The viewer was closed","AbortError"));
      for (const task of imageDetectionInFlightRef.current.values()) {
        if (!task.settled) task.controller.abort(new DOMException("The viewer was closed","AbortError"));
      }
      imageDetectionInFlightRef.current.clear();
      for (const controller of readingBlocksAbortRef.current.values()) {
        controller.abort(new DOMException("The viewer was closed","AbortError"));
      }
      readingBlocksAbortRef.current.clear();
      readingBlocksLoadAbortRef.current?.abort(new DOMException("The viewer was closed","AbortError"));
      readingBlocksLoadAbortRef.current = null;
      readingBlocksInFlightRef.current.clear();
      readingBlocksLoadRef.current = null;
      translationAbortRef.current?.abort();
      translationRetryAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
  }, [fileId]);

  const releaseLockedZoomPage = useCallback(() => {
    if (rightDragRef.current.active) return;
    if (zoomLockReleaseTimerRef.current !== null) {
      window.clearTimeout(zoomLockReleaseTimerRef.current);
      zoomLockReleaseTimerRef.current = null;
    }
    zoomAnchorRef.current = null;
    zoomRenderReadyRef.current = false;
    const flow = pageFlowRef.current;
    // 预览 transform 是绕开 React 写在 DOM 上的。提交完成后必须把所有权
    // 交还回去，否则之后切换文档 / 标签页会继承一个过期 transform。
    // 走统一入口：transform / origin / 逆比例三者必须一起清（见它的注释）。
    clearZoomPreviewScale(flow);
    lockedZoomPageRef.current = null;
    setLockedZoomPage(null);
  }, []);

  const handleFirstPagePainted = useCallback(() => {
    setFirstPagePainted(true);
  }, []);

  const handlePageRendered = useCallback(
    (pageNo: number, renderedScale: number) => {
      const lockedPage = lockedZoomPageRef.current;
      const targetScale = Math.max(0.5, zoomTargetRef.current / 100);
      if (lockedPage !== pageNo || Math.abs(renderedScale - targetScale) > 0.01) return;
      zoomRenderReadyRef.current = true;
      if (!rightDragRef.current.active) releaseLockedZoomPage();
    },
    [releaseLockedZoomPage],
  );

  const scheduleRenderZoomCommit = useCallback(
    (targetZoom: number) => {
      if (zoomRenderCommitTimerRef.current !== null) {
        window.clearTimeout(zoomRenderCommitTimerRef.current);
        zoomRenderCommitTimerRef.current = null;
      }
      /**
       * ★ 同时作废「上一轮的锁释放兜底」—— 这两个定时器必须互斥。
       *
       * 兜底回调无条件调 `releaseLockedZoomPage()`，而它会清掉 `zoomAnchorRef`
       * （锚点与预览 transform 是一对）。只要兜底抢在提交落地之前跑，
       * 提交那一刻就拿不到锚点 → 补不了那次滚动 → 松手瞬间内容跳走。
       *
       * 2026-10-10 实测（右键滚轮，光标固定在页心）：
       *   连滚 3 拍 → 提交先跑，锚点还在，`A` 组补偿 76/285px ✓
       *   连滚 5 拍 → 上一轮残留的兜底先跑（t=17343，`releaseFallback`），
       *               锚点已空，`F` 组一次滚动写入都没有 ✗
       * 同一个操作两种结果，就是竞态 —— 靠「谁先触发」决定对错。
       *
       * 兜底本来要守的「手势失败时不能永久锁死」不受影响：本次提交落地时
       * 会重新排一个兜底（见下），每一轮都有自己的那一份。
       */
      if (zoomLockReleaseTimerRef.current !== null) {
        window.clearTimeout(zoomLockReleaseTimerRef.current);
        zoomLockReleaseTimerRef.current = null;
      }
      zoomRenderReadyRef.current = false;
      // A right-button wheel gesture is a visual-only phase. Committing
      // renderZoom here would resize every page while the pointer is still
      // moving, causing canvas re-renders, blank frames, and page drift.
      if (rightDragRef.current.active) return;
      zoomRenderCommitTimerRef.current = window.setTimeout(() => {
        zoomRenderCommitTimerRef.current = null;
        const nextRenderZoom = clampZoomValue(targetZoom);
        // 页块尺寸是在 render 里由 renderZoomScale 算出的内联样式，所以换了尺寸
        // 才有「绕左上角重排」这件事要补。同值提交时 React 会 bail out，布局没动，
        // 留一个待补项反而会在读者随后滚动时误补一次。
        if (nextRenderZoom !== renderZoomRef.current) {
          const anchor = zoomAnchorRef.current;
          pendingZoomAnchorRestoreRef.current = anchor
            ? {
                pageNo: anchor.pageNo,
                relX: anchor.relX,
                relY: anchor.relY,
                viewportX: anchor.viewportX,
                viewportY: anchor.viewportY,
              }
            : null;
        }
        setRenderZoom(nextRenderZoom);
        // ★ 提交 renderZoom 的同一时刻必须清零预览 transform。
        // 预览比例是 previewScale / renderZoomScale：提交后分母变成新 scale，
        // 页流也已按新尺寸重新布局，此时旧的 transform 不再是「补足差值」，
        // 而是「再放大一遍」。留着它，页面会被双重放大，等锁定页重绘完
        // releaseLockedZoomPage() 再清时又整体缩回去 —— 就是缩放结束后
        // 那个多余的「重新缩放」动作。
        // 清零只牺牲 canvas 尚未重绘完时的清晰度；尺寸从这一刻起就是对的。
        //
        // ⚠️ transform 与锚点必须**成对**清掉。锚点里存着「旧布局坐标系里的
        // 原点」，只清 transform 不清锚点，rAF 里剩余的那几帧（缓动还没收敛时
        // 每帧都会调 applyZoomPreview）就会围着旧原点写 scale，把内容甩偏。
        const flow = pageFlowRef.current;
        // `keepOrigin`：提交这一刻**不清 origin**。它与 releaseLockedZoomPage
        // 的语义差别是有意的 —— 那里是「整个手势结束」，这里是「预览交棒给新布局」。
        clearZoomPreviewScale(flow, { keepOrigin: true });
        zoomAnchorRef.current = null;
        // PageCanvas releases the lock after the target page has actually
        // painted. Keep a long fallback for malformed/failed renders so a
        // gesture cannot leave the viewer permanently locked.
        if (zoomLockReleaseTimerRef.current !== null) {
          window.clearTimeout(zoomLockReleaseTimerRef.current);
        }
        const releaseFallback = () => {
          zoomLockReleaseTimerRef.current = null;
          if (rightDragRef.current.active) {
            zoomLockReleaseTimerRef.current = window.setTimeout(releaseFallback, 120);
            return;
          }
          releaseLockedZoomPage();
        };
        zoomLockReleaseTimerRef.current = window.setTimeout(releaseFallback, ZOOM_RENDER_READY_FALLBACK_MS);
      }, ZOOM_RENDER_COMMIT_DELAY_MS);
    },
    [releaseLockedZoomPage],
  );

  /**
   * 采集缩放锚点 —— 连同预览 transform 需要的**原点**（见 zoomAnchorRef 注释）。
   *
   * ## ⚠️ 量测必须在「页流没有预览 transform」的状态下进行
   *
   * 本函数在手势期间**每一步都会被调用**（滚轮每一格、捏合每一帧），
   * 而上一帧刚写过 `scale(...)`。带 transform 量 `getBoundingClientRect()` 得到的是
   * **视觉盒**：`flowRect.width/height` 已经乘过缩放，`left/top` 也被 origin 推偏，
   * 于是 `originX = 锚点屏幕坐标 − flowRect.left` 量出来的是「视觉偏移」而不是
   * 「本地偏移」—— 误差随缩放累积。
   *
   * 2026-10-10 实测（右键滚轮连滚 3 拍，光标固定）：不摘 transform 时
   * origin 每拍都换一个值（451 → 559 → 719），光标在页内的归一化位置
   * 0.5 → 0.499 → 0.557 → 0.684，内容仍在滑走；摘掉之后三拍全部停在 0.5。
   *
   * 摘掉再还原是安全的：两次写 `style` 在同一个任务里，中间不会发生绘制，
   * 所以不会有闪帧。这也是本函数唯一的同步 reflow（每步一次）。
   *
   * `relX/relY` 不受此影响 —— 它是**比值**，分子分母同乘同一个缩放因子，
   * 所以用视觉盒算出来的比值与布局盒完全相等（可以自行验算：屏幕坐标是
   * 局部坐标的仿射变换，而比值对仿射变换不变）。
   */
  const captureZoomAnchor = useCallback(
    (pageNo: number, clientX?: number, clientY?: number) => {
      const root = scrollRef.current;
      const node = pageRefs.current.get(clampPage(pageNo, totalPages));
      const flow = pageFlowRef.current;
      if (!root || !node || !flow) return;
      const rootRect = root.getBoundingClientRect();
      const pendingTransform = flow.style.transform;
      if (pendingTransform) flow.style.transform ="";
      const nodeRect = node.getBoundingClientRect();
      const flowRect = flow.getBoundingClientRect();
      if (pendingTransform) flow.style.transform = pendingTransform;
      const viewportX = typeof clientX ==="number" ? clientX - rootRect.left : root.clientWidth / 2;
      const viewportY = typeof clientY ==="number" ? clientY - rootRect.top : root.clientHeight / 2;
      zoomAnchorRef.current = {
        pageNo: clampPage(pageNo, totalPages),
        relX: Math.max(0, Math.min(1, (rootRect.left + viewportX - nodeRect.left) / Math.max(1, nodeRect.width))),
        relY: Math.max(0, Math.min(1, (rootRect.top + viewportY - nodeRect.top) / Math.max(1, nodeRect.height))),
        viewportX,
        viewportY,
        // `transform-origin` 的坐标系是页流自己的 border box，所以拿
        // 「锚点的屏幕坐标 − 页流的屏幕左/上边」；两边都含祖先变换，相减抵消。
        // 上式在「无 transform」前提下成立 —— 见上方警告。
        originX: rootRect.left + viewportX - flowRect.left,
        originY: rootRect.top + viewportY - flowRect.top,
      };
    },
    [totalPages],
  );

  /**
   * 取得缩放锁 —— **唯一**的入口。
   *
   * 为什么必须唯一：锁有两个副作用是别人依赖的前提 ——
   * ① `lockedZoomPageRef` 非空期间 `scheduleSync` 走「报告锁定页」的分支；
   * ② 活跃页集合被换成锁定页 ±`PAGE_RENDER_OVERSCAN_WHILE_ZOOMING`
   *    （缩放途中不能让远处页被卸载/重渲）。
   *
   * 曾经这里是两处各写一遍（`applyZoomTarget` 内联一段、右键 pointerdown 再一段），
   * 而 `applyZoomTarget` 只在「自己刚刚锁上」时才做首次采基准 ——
   * 右键路径提前锁了页，于是那段整段被跳过，预览原点恒为 0。见 zoomAnchorRef 注释。
   */
  const lockZoomPage = useCallback(
    (pageNo: number) => {
      const target = clampPage(pageNo, totalPages);
      lockedZoomPageRef.current = target;
      setLockedZoomPage(target);
      const nextActive = new Set<number>();
      for (
        let offset = -PAGE_RENDER_OVERSCAN_WHILE_ZOOMING;
        offset <= PAGE_RENDER_OVERSCAN_WHILE_ZOOMING;
        offset += 1
      ) {
        nextActive.add(clampPage(target + offset, totalPages));
      }
      setActivePages(nextActive);
      return target;
    },
    [totalPages],
  );

  const applyZoomPreview = useCallback(
    (previewZoom: number) => {
      const anchor = zoomAnchorRef.current;
      const flow = pageFlowRef.current;
      if (!anchor || !flow) return;

      const previewScale = Math.max(0.5, previewZoom / 100);
      const visualScale = previewScale / Math.max(0.01, renderZoomScale);
      // ★ 缩放整个页流，而不是锁定的那一页。
      // 之前只对锁定页写 transform，于是它先变、其余页停在旧尺寸，
      // 直到 160ms 后 renderZoom 提交才一齐跟上 —— 就是那个「某一页先缩放」的过渡态。
      // CSS transform 是 GPU 合成的，一次变换 vs 每页一次变换成本几乎没差别，
      // 而 canvas 重渲染依旧延后，所以「一起预览」不牺牲任何原有取舍。
      //
      // transform-origin 必须是**同一个绝对原点**（锚点在页流坐标系里的像素位置）。
      // 若每页各按自己的相对原点缩放，页与页的间距会跟着变，看起来像「散开」。
      //
      // 原点与锚点同一次量测得到（见 zoomAnchorRef 注释）—— 这里**没有兜底值**：
      // 「算不出原点」在类型上不可表达，所以不存在「悄悄退回 0 0」这条路径。
      //
      // 走统一入口写 transform：它同时写下**逆比例**变量，页流内的 UI chrome
      // （伴读批注卡）靠它抵消放大（见 ZOOM_PREVIEW_INVERSE_VAR 的注释）。
      // Keep the point under the pointer fixed by the transform itself. A
      // second scroll correction causes the page to drift left and snap back.
      applyZoomPreviewScale(flow, visualScale, anchor.originX, anchor.originY);
    },
    [renderZoomScale],
  );

  /**
   * 提交后的锚点补偿：把光标下那个内容点推回它在采集时的屏幕位置。
   *
   * 为什么放在 useLayoutEffect：页块的 width/height 是 render 里由 renderZoomScale
   * 算出的内联样式，所以 renderZoom 一提交，新布局就已经在 DOM 上（React 在
   * layout effect 之前刷完变更），而浏览器**还没绘制** —— 此刻改 scrollLeft/Top
   * 既不会闪，读者也看不到中间态。放到 useEffect（绘制后）就会看到那一跳。
   *
   * 为什么用「量现值再推回去」而不是按缩放比例推算：量与推都可以只依赖
   * 锚点的 `relX/relY`（对仿射变换不变的比值）+ 实时 rect，不需要知道
   * 页流在哪、也不需要在两个坐标系之间做算术 —— 与「恢复阅读位置」那段
   * useLayoutEffect 用的是同一个手法，同一类错误只会有一种写法。
   */
  useLayoutEffect(() => {
    const pending = pendingZoomAnchorRestoreRef.current;
    if (!pending) return;
    pendingZoomAnchorRestoreRef.current = null;
    const root = scrollRef.current;
    const node = pageRefs.current.get(pending.pageNo);
    if (!root || !node) return;
    const rootRect = root.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const currentX = nodeRect.left + pending.relX * nodeRect.width;
    const currentY = nodeRect.top + pending.relY * nodeRect.height;
    root.scrollLeft += currentX - (rootRect.left + pending.viewportX);
    root.scrollTop += currentY - (rootRect.top + pending.viewportY);
  }, [renderZoom]);

  const animateZoomToTarget = useCallback(() => {
    if (zoomAnimationRef.current !== null) return;

    // 尊重系统「减少动态效果」。这条判断写在这里而不是指望令牌层，
    // 是因为 tokens.css 把 --duration-* 归零只对走 CSS / transition 的消费者生效；
    // 本文件的缩放是 rAF 手写循环，与 CSS 令牌没有任何连接，
    // 不自己判断的话 reduce 用户照样会看到完整的逐帧逼近。
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true) {
      const target = zoomTargetRef.current;
      zoomPreviewRef.current = target;
      applyZoomPreview(target);
      setZoom(target);
      scheduleRenderZoomCommit(target);
      return;
    }

    const tick = () => {
      zoomAnimationRef.current = null;
      const target = zoomTargetRef.current;
      const currentZoom = zoomPreviewRef.current;
      const delta = target - currentZoom;
      if (Math.abs(delta) <= ZOOM_ANIMATION_SETTLE) {
        zoomPreviewRef.current = target;
        applyZoomPreview(target);
        setZoom(target);
        scheduleRenderZoomCommit(target);
        return;
      }
      const nextZoom = currentZoom + delta * ZOOM_ANIMATION_EASE;
      zoomPreviewRef.current = nextZoom;
      applyZoomPreview(nextZoom);
      zoomAnimationRef.current = window.requestAnimationFrame(tick);
    };
    zoomAnimationRef.current = window.requestAnimationFrame(tick);
  }, [applyZoomPreview, scheduleRenderZoomCommit]);

  const cancelZoomAnimationForViewChange = useCallback(() => {
    if (zoomAnimationRef.current === null) return;
    window.cancelAnimationFrame(zoomAnimationRef.current);
    zoomAnimationRef.current = null;

    // Do not let a live zoom RAF write an old anchor after the reader mode
    // changes. Freeze the current visual frame and commit that same frame.
    const settledZoom = clampZoomValue(zoomPreviewRef.current);
    zoomTargetRef.current = settledZoom;
    zoomPreviewRef.current = settledZoom;
    zoomAnchorRef.current = null;
    setZoom(settledZoom);
    scheduleRenderZoomCommit(settledZoom);
  }, [scheduleRenderZoomCommit]);

  const applyZoomTarget = useCallback(
    (nextZoom: number, options?: { pageNo?: number; clientX?: number; clientY?: number }) => {
      const anchorPage = clampPage(
        options?.pageNo ?? lockedZoomPageRef.current ?? lockedZoomPage ?? visiblePage,
        totalPages,
      );
      // 首次进入手势时锁页（唯一入口，见 lockZoomPage 注释）。
      // ⚠️ 不要在这里再采「基准」—— 原来的实现就是在这里采的，
      // 而右键路径在 pointerdown 里已经锁过页，这段被整段跳过 → 预览原点恒为 0。
      // 原点现在由 captureZoomAnchor 与锚点一起采（就在下一行）。
      if (lockedZoomPageRef.current === null) lockZoomPage(anchorPage);
      captureZoomAnchor(anchorPage, options?.clientX, options?.clientY);
      zoomTargetRef.current = clampZoomValue(nextZoom);
      zoomRenderReadyRef.current = false;
      scheduleRenderZoomCommit(zoomTargetRef.current);
      animateZoomToTarget();
    },
    [
      animateZoomToTarget,
      captureZoomAnchor,
      lockZoomPage,
      lockedZoomPage,
      scheduleRenderZoomCommit,
      visiblePage,
    ],
  );

  /** 滚轮 / 按钮：离散的一步，用增量（zoom + delta）。 */
  const smoothZoomBy = useCallback(
    (delta: number, options?: { pageNo?: number; clientX?: number; clientY?: number }) => {
      applyZoomTarget(zoomTargetRef.current + delta, options);
    },
    [applyZoomTarget],
  );

  /**
   * 捏合：连续的位移，用倍率（zoom × factor）。
   *
   * 一次捏合会派发几十个事件，每个事件的 deltaY 都很小。若按增量理解，
   * 每个事件至少 +7%（WHEEL_ZOOM_MIN_STEP 兜底），一次手势就翻倍 ——
   * 实测单窗口 13~15 个事件，正是这样爆掉的。倍率没有这个问题。
   */
  const smoothZoomByFactor = useCallback(
    (factor: number, options?: { pageNo?: number; clientX?: number; clientY?: number }) => {
      applyZoomTarget(zoomTargetRef.current * factor, options);
    },
    [applyZoomTarget],
  );

  /**
   * 滚轮 / 捏合手势 —— 识别交给 `@use-gesture/react`，这里只做产品决策。
   *
   * ## 为什么不再手写 wheel 监听
   *
   * 旧实现自己挂了 non-passive wheel 监听，自己判 ctrlKey/metaKey，
   * 自己按 deltaMode 换算，自己用 `exp(-k·deltaY)` 累积倍率。这三件事
   * 都是**通用输入问题**，不是 PDF 特有的：换一个手势库就不该重写一遍，
   * 而手写版本已经因为「React 的 onWheel 是 passive」「deltaMode 有三种」
   * 各返工过一次（见上方 smoothZoomByFactor 的注释）。
   *
   * `useGesture` 把 wheel 与 pinch 收进同一个引擎，自带 modifierKey 识别、
   * deltaMode 归一、non-passive 绑定与捏合倍率累积。`eventOptions.passive: false`
   * 是必须的：不关掉它，WKWebView 会顺手做一次原生页面放大，
   * 整个界面（工具栏、侧栏）跟着变形变模糊。
   *
   * ## ★ 为什么两个分支必须互斥
   *
   * 库的 pinch 引擎与 wheel 引擎是**两个独立引擎**，都监听同一批 wheel 事件。
   * 一次捏合会同时命中 `onPinch` 和 `onWheel` —— 不挡掉的话同一次手势
   * 缩放两遍（一次按倍率、一次按步进），表现为「捏一下就炸开」。
   * `isPinchGesture` 就是这个互斥判据，必须与 `pinch.modifierKey` 保持一致。
   *
   * ## 为什么仍然要 refs
   *
   * `useGesture` 返回的绑定函数身份每次渲染都变，直接把它放进任何依赖里
   * 都会让下游 effect 重跑。所以最新回调一律经 ref 读取（沿用本文件既有做法）。
   */
  const isGestureRightDownRef = useRef(isGestureRightDown);
  isGestureRightDownRef.current = isGestureRightDown;
  const smoothZoomByRef = useRef(smoothZoomBy);
  smoothZoomByRef.current = smoothZoomBy;
  const smoothZoomByFactorRef = useRef(smoothZoomByFactor);
  smoothZoomByFactorRef.current = smoothZoomByFactor;

  useGesture(
    {
      /**
       * 捏合：连续位移 → 倍率。
       *
       * ## ⚠️ 必须除掉 `lastOffset`
       *
       * `offset[0]` **不是**「本次手势捏了多少」。库的 `PinchEngine.reset()`
       * 不重置 offset —— `init()` 只在构造时设一次 `[1,0]`，一次手势结束时
       * 它是 1.75，下一次手势就从 1.75 继续累。直接乘到 zoom 上，
       * 第二次捏合会先凭空放大 1.75 倍（实测手感：「捏一下就炸开」，
       * 且第二次比第一次夸张得多）。
       *
       * `offset[0] / lastOffset[0]` 才是本次手势的相对倍率，
       * 语义与乘法（`movement = offset - lastOffset`）一致。
       * 换算与灵敏度标定在 `pinchZoomFactor` 里。
       */
      onPinch: ({ offset: [scale], lastOffset: [startScale], origin, event }) => {
        if (!Number.isFinite(scale) || !Number.isFinite(startScale) || startScale <= 0) return;
        const factor = pinchZoomFactor(scale, startScale);
        // factor 恒为正（内部已夹），但仍守住「不缩放」这一档：
        // 库在极端反向 deltaY 下可能给出 <= 0 的 offset。
        if (!Number.isFinite(factor) || factor <= 0) return;
        smoothZoomByFactorRef.current(factor, {
          clientX: origin[0],
          clientY: origin[1],
        });
        // 双保险：库内部已 preventDefault，但 Safari 的 gesture 事件路径
        // 在旧WebKit 上仍可能漏掉 —— 漏掉的表现是整个界面被原生放大。
        if (event.cancelable) event.preventDefault();
      },
      /**
       * 滚轮：只有右键手势才缩放，普通滚动保持浏览器默认行为。
       *
       * ## ⚠️ 必须用 `delta` 而不是 `movement`
       *
       * 库的 `WheelEngine` 是坐标引擎，`movement` 来自 `_movement`的**累加**，
       * 而一次 wheel 手势要到 140ms 无新事件才结束。拿它当单事件步进，
       * 连续滚动时步进会越来越大（越滚越快），停下后手感与起步时完全不同。
       * `delta[1]` 才是本次事件的位移（本次 offset 与上次之差）。
       */
      onWheel: ({ delta: [, deltaY], event }) => {
        // 捏合事件已由 onPinch 处理，这里必须让路（见上方「两个分支必须互斥」）。
        if (isPinchGesture(event as WheelEvent)) return;
        if (!isGestureRightDownRef.current) return;
        if (event.cancelable) event.preventDefault();
        const step = wheelZoomStep(deltaY);
        if (step === 0) return;
        smoothZoomByRef.current(step, {
          clientX: (event as WheelEvent).clientX,
          clientY: (event as WheelEvent).clientY,
        });
      },
    },
    {
      target: scrollRef,
      eventOptions: { passive: false },
      pinch: {
        // 与 isPinchGesture 保持同一套 modifier，否则两个分支的边界会错开。
        modifierKey: ["ctrlKey", "metaKey"],
        // 由 wheel 驱动捏合：WKWebView / Chromium 都把触控板捏合合成为
        // wheel + ctrlKey，不开这一项则捏合完全不被识别。
        pinchOnWheel: true,
      },
      wheel: {
        // 滚动容器自己会滚，不需要库的 offset 累积；
        // 这里要的是每个事件的位移量，不是位置。
        axis: "y",
      },
    },
  );

  const scheduleSync = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const root = scrollRef.current;
      if (!root || !fileId) return;
      if (isRestoringViewRef.current) return;
      if (Date.now() < suppressSyncUntilRef.current) return;
      const currentLockedPage = lockedZoomPageRef.current ?? lockedZoomPage;
      if (currentLockedPage !== null) {
        emitViewState({
          page: currentLockedPage,
          totalPages,
          zoom,
          scrollTop: root.scrollTop,
          scrollLeft: root.scrollLeft,
        });
        return;
      }

      // 逐帧的「当前页」判定：交给浏览器的命中测试（`pageNumberAtViewportCenter`）。
      //
      // ⚠️ 这里曾经是自己维护的「每页页顶几何缓存 + 二分查找」（以 scrollHeight
      // 为失效指纹）。2026-10-10 它造成过一次**静默的整屏空白**：缓存存的坐标是
      // `rect.top - rootRect.top - scrollTop`，而比较基准是
      // `scrollTop + clientHeight / 2` —— 两边不在同一坐标系，等于把阈值写成
      // `3 × scrollTop`。scrollTop = 0 时两者相同，所以首屏一直正常、e2e 也全绿；
      // 一旦阅读位置在深处（恢复上次位置 / 深跳），活跃窗口就整体超前
      // `2 × scrollTop ÷ 页高` 页，**屏幕上正在看的那一页根本不在活跃集合里**
      // → 正文整片空白 → 点缩略图（直接写活跃集合）立刻可见 → 再滚一下又空白。
      // 实测（60 页夹具，scrollTop = 23938）判定成第 58 页，视口里是第 29–30 页。
      //
      // 教训：**别维护 DOM 的影分身**。「视口中心下面是谁」浏览器已经算好了，
      // 一次 `elementFromPoint` 与读一次 clientHeight 同级，且不存在失效时机问题。
      // 命中不到时回退到上一次的页码（它一定在活跃集合里，不会造成空白）。
      const nearest = pageNumberAtViewportCenter(root) ?? page;
      const nextActive = new Set<number>();

      for (let delta = 1; delta <= ACTIVE_NEIGHBOR; delta += 1) {
        nextActive.add(clampPage(nearest - delta, totalPages));
        nextActive.add(clampPage(nearest + delta, totalPages));
      }
      nextActive.add(nearest);

      setActivePages((prev) => (equalSet(prev, nextActive) ? prev : nextActive));
      setPage((prev) => (prev === nearest ? prev : nearest));
      emitViewState({
        page: nearest,
        totalPages,
        zoom: zoomTargetRef.current,
        scrollTop: root.scrollTop,
        scrollLeft: root.scrollLeft,
      });
    });
  }, [emitViewState, fileId, lockedZoomPage, page, totalPages, zoom]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !fileId) return;

    const onScroll = () => scheduleSync();
    root.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    scheduleSync();

    return () => {
      root.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [fileId, scheduleSync]);

  useEffect(() => {
    if (isGestureRightDown) return;
    scheduleSync();
  }, [isGestureRightDown, lockedZoomPage, scheduleSync, totalPages, zoom, pageSizes]);

  useLayoutEffect(() => {
    if (!fileId || !initialViewState) return;
    if (!isRestoringViewRef.current) return;
    const root = scrollRef.current;
    if (!root) return;
    const targetPage = clampPage(initialViewState?.page ?? page, totalPages);
    const targetZoom = clampZoomValue(initialViewState?.zoom ?? zoom);
    zoomTargetRef.current = targetZoom;
    setPage(targetPage);
    setZoom(targetZoom);
    setRenderZoom(targetZoom);
    window.requestAnimationFrame(() => {
      const nextRoot = scrollRef.current;
      if (!nextRoot) return;
      const focusRect = initialViewState.focusRect;
      const focusNode = pageRefs.current.get(targetPage);
      if (focusRect && focusNode) {
        const rootRect = nextRoot.getBoundingClientRect();
        const pageRect = focusNode.getBoundingClientRect();
        const centerX = pageRect.left + focusRect.x * pageRect.width + (focusRect.width * pageRect.width) / 2;
        const centerY = pageRect.top + focusRect.y * pageRect.height + (focusRect.height * pageRect.height) / 2;
        const top = Math.max(0, nextRoot.scrollTop + centerY - rootRect.top - nextRoot.clientHeight / 2);
        const left = Math.max(0, nextRoot.scrollLeft + centerX - rootRect.left - nextRoot.clientWidth / 2);
        nextRoot.scrollTo({ top, left, behavior:"auto" });
        isRestoringViewRef.current = false;
        scheduleSync();
        return;
      }
      const top = Math.max(0, initialViewState?.scrollTop ?? 0);
      const left = Math.max(0, initialViewState?.scrollLeft ?? 0);
      if (top > 0 || left > 0) {
        nextRoot.scrollTo({ top, left, behavior:"auto" });
        window.setTimeout(() => {
          isRestoringViewRef.current = false;
          scheduleSync();
        }, 80);
        return;
      }
      const node = pageRefs.current.get(targetPage);
      if (!node) {
        window.setTimeout(() => {
          isRestoringViewRef.current = false;
          scheduleSync();
        }, 80);
        return;
      }
      const rootRect = nextRoot.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      nextRoot.scrollTo({
        top: Math.max(0, nextRoot.scrollTop + (nodeRect.top - rootRect.top) - 12),
        behavior:"auto",
      });
      window.setTimeout(() => {
        isRestoringViewRef.current = false;
        scheduleSync();
      }, 80);
    });
  }, [fileId, initialViewState, page, scheduleSync, totalPages, zoom]);

  useEffect(() => {
    if (!fileId) return;
    onProgressRef.current?.(page, totalPages);
  }, [fileId, page, totalPages]);

  useEffect(() => {
    if (sidebarTab !=="thumbs") return;
    if (lockedZoomPage !== null) return;
    const list = thumbListRef.current;
    const node = thumbItemRefs.current.get(page);
    if (!list || !node) return;
    const targetTop = node.offsetTop - list.clientHeight / 2 + node.clientHeight / 2;
    const boundedTop = Math.max(0, Math.min(targetTop, list.scrollHeight - list.clientHeight));
    const behavior: ScrollBehavior = Date.now() < thumbJumpUntilRef.current ?"auto" :"smooth";
    list.scrollTo({ top: boundedTop, behavior });
  }, [lockedZoomPage, page, sidebarTab]);

  const goToPage = useCallback(
    (pageNo: number, behavior: ScrollBehavior ="smooth", options?: { source?:"thumb" |"control" |"restore" }) => {
      const target = clampPage(pageNo, totalPages);
      const root = scrollRef.current;
      const node = pageRefs.current.get(target);
      if (!root || !node) {
        setPage(target);
        return;
      }
      const rootRect = root.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const targetTop = root.scrollTop + (nodeRect.top - rootRect.top) - 12;
      if (options?.source ==="thumb") {
        suppressSyncUntilRef.current = Date.now() + 360;
        thumbJumpUntilRef.current = Date.now() + 420;
        setPage(target);
        setActivePages((prev) => {
          const next = new Set(prev);
          next.add(clampPage(target - 1, totalPages));
          next.add(target);
          next.add(clampPage(target + 1, totalPages));
          return equalSet(prev, next) ? prev : next;
        });
        root.scrollTo({ top: Math.max(0, targetTop), behavior:"auto" });
        return;
      }
      root.scrollTo({ top: Math.max(0, targetTop), behavior });
      setPage(target);
    },
    [totalPages],
  );

  const goToSource = useCallback(
    (targetPage: number, sourceRect?: ReaderNote["sourceRect"]) => {
      const target = clampPage(targetPage, totalPages);
      if (!sourceRect) {
        goToPage(target,"auto");
        return;
      }
      goToPage(target,"auto");
      window.requestAnimationFrame(() => {
        const root = scrollRef.current;
        const node = pageRefs.current.get(target);
        if (!root || !node) return;
        const rootRect = root.getBoundingClientRect();
        const pageRect = node.getBoundingClientRect();
        const centerX = pageRect.left + sourceRect.x * pageRect.width + (sourceRect.width * pageRect.width) / 2;
        const centerY = pageRect.top + sourceRect.y * pageRect.height + (sourceRect.height * pageRect.height) / 2;
        root.scrollTo({
          left: Math.max(0, root.scrollLeft + centerX - rootRect.left - root.clientWidth / 2),
          top: Math.max(0, root.scrollTop + centerY - rootRect.top - root.clientHeight / 2),
          behavior:"auto",
        });
        emitViewState({ page: target, scrollTop: root.scrollTop, scrollLeft: root.scrollLeft });
      });
    },
    [emitViewState, goToPage, totalPages],
  );

  const handleThumbnailClick = useCallback(
    (targetPage: number) => goToPage(targetPage,"auto", { source:"thumb" }),
    [goToPage],
  );
  const handleThumbnailItemRef = useCallback((targetPage: number, node: HTMLButtonElement | null) => {
    if (node) thumbItemRefs.current.set(targetPage, node);
    else thumbItemRefs.current.delete(targetPage);
  }, []);
  const handleThumbnailContextMenu = useCallback(
    (targetPage: number, event: React.MouseEvent<HTMLButtonElement>) => {
      setPage(clampPage(targetPage, totalPages));
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        isOpen: true,
        pageNo: clampPage(targetPage, totalPages),
        imageTarget: null,
      });
    },
    [totalPages],
  );

  const showActionHint = (message: string) => {
    setActionHint(message);
    window.setTimeout(() => setActionHint(""), 2000);
  };
  const exportPng = async (target?: {
    pageNo: number;
    imageTarget?: ImageContextTarget | null;
    mode?:"page" |"original" |"crop";
  }) => {
    if (!fileId) return;
    const targetPage = clampPage(target?.pageNo ?? page, totalPages);
    exportAbortRef.current?.abort();
    const controller = new AbortController();
    exportAbortRef.current = controller;
    try {
      const pageSize = pageSizes[targetPage] || DEFAULT_PAGE_SIZE;
      const imageTarget = target?.imageTarget;
      const mode = target?.mode || (imageTarget ?"original" :"page");
      let extracted = null as Awaited<ReturnType<typeof api.extractPDFImage>> | null;
      if (mode ==="original") {
        if (!imageTarget || imageTarget.image.source !=="xref" || imageTarget.image.xref <= 0) {
          throw new Error(
            language ==="zh-CN"
              ?"当前资源没有可独立导出的原始图片，请选择裁剪 PNG。"
              :"This resource has no independently exportable original image; choose crop PNG.",
          );
        }
        try {
          extracted = await api.extractPDFImage(fileId, targetPage, imageTarget.image.xref, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          throw new Error(
            language ==="zh-CN"
              ?"原始图片资源无法解码，请选择裁剪 PNG。"
              :"The original image resource could not be decoded; choose crop PNG.",
          );
        }
      }
      // Original xref resources do not need a full-page raster first. This is
      // faster and avoids making a large export part of a small image action.
      const pagePngBase64 = extracted ?"" : await api.exportPagePNG(fileId, targetPage, 2, controller.signal);
      const pngBase64 =
        extracted?.dataBase64 ??
        (mode ==="crop" && imageTarget
          ? await cropPngBase64(pagePngBase64, imageTarget.rect, pageSize)
          : pagePngBase64);
      const baseName = cleanBaseName(title ||"document");
      const extension = extracted?.extension ||"png";
      const defaultName = imageTarget
        ?`${baseName}-page-${targetPage}-${extracted ?"original" :"crop"}-${imageTarget.image.xref ||"region"}.${extension}`
        :`${baseName}-page-${targetPage}.png`;
      if (extracted) {
        await api.saveImageToFile(pngBase64, onResolveDefaultPath?.(defaultName) || defaultName, extension);
      } else {
        await api.savePNGToFile(pngBase64, onResolveDefaultPath?.(defaultName) || defaultName);
      }
      showActionHint(extracted ? (language ==="zh-CN" ?"原始图片已导出" :"Original image exported") : t.pngExported);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      setRenderError(`PNG export failed: ${message}`);
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null;
    }
  };
  const exportSvg = async (target?: { pageNo: number; imageTarget?: ImageContextTarget | null }) => {
    if (!fileId) return;
    const targetPage = clampPage(target?.pageNo ?? page, totalPages);
    exportAbortRef.current?.abort();
    const controller = new AbortController();
    exportAbortRef.current = controller;
    try {
      const imageTarget = target?.imageTarget;
      const svg = imageTarget
        ? await api.exportPageSVGCrop(fileId, targetPage, imageTarget.rect, controller.signal)
        : await api.exportPageSVG(fileId, targetPage, controller.signal);
      const baseName = cleanBaseName(title ||"document");
      const defaultName = imageTarget
        ?`${baseName}-page-${targetPage}-image-${imageTarget.image.xref ||"crop"}.svg`
        :`${baseName}-page-${targetPage}.svg`;
      await api.saveSVGToFile(svg, onResolveDefaultPath?.(defaultName) || defaultName);
      showActionHint(t.svgExported);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      setRenderError(`SVG export failed: ${message}`);
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null;
    }
  };

  const handleSearch = async () => {
    if (!pdfDoc) return;

    const query = window.prompt(t.searchKeywordPrompt);
    if (query === null) return;

    const trimmed = query.trim();
    if (!trimmed) {
      showActionHint(t.enterKeyword);
      return;
    }

    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setRenderError("");
    setIsSearching(true);
    try {
      const needle = trimmed.toLowerCase();
      for (let pageNo = 1; pageNo <= pdfDoc.numPages; pageNo += 1) {
        if (controller.signal.aborted) return;
        const pdfPage = await getPdfPageWithResourceTimeout(pdfDoc, pageNo);
        try {
          const textContent = await withResourceScanTimeout(pdfPage.getTextContent(),`PDF search page ${pageNo} text`);
          if (controller.signal.aborted) return;
          const text = textContent.items
            .map((item) => ("str" in item && typeof item.str ==="string" ? item.str :""))
            .join("")
            .toLowerCase();

          if (text.includes(needle)) {
            goToPage(pageNo,"auto");
            showActionHint(t.foundOnPage.replace("{page}", String(pageNo)));
            return;
          }
        } finally {
          pdfPage.cleanup();
        }
      }
      showActionHint(t.noMatches.replace("{query}", trimmed));
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      setRenderError(`Search failed: ${message}`);
    } finally {
      if (searchAbortRef.current === controller) {
        searchAbortRef.current = null;
        setIsSearching(false);
      }
    }
  };

  const submitNote = () => {
    const trimmed = noteDraft.trim();
    if (!trimmed) return;
    onAddNote?.(page, trimmed, activeTool ==="highlight" ?"highlight" :"note");
    setNoteDraft("");
    showActionHint(t.noteAdded);
  };

  const updateDraftPoint = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };

  const handleAnnotationPointerDown = (pageNo: number, event: React.PointerEvent<HTMLDivElement>) => {
    // 行类工具的左键归文本选择（见 textSelectionEnabled 的注释）：这里必须
    // **提前返回且不 preventDefault** —— pointer 处理器挂在页面 wrapper 上，
    // overlay 的 pointer-events:none 挡不住它，若在这里 setPointerCapture/
    // preventDefault，原生文本选择会被整个吃掉，选区永远建立不起来。
    if (isLineAnnotationTool(activeTool)) return;
    if (!isAnnotationTool(activeTool)) return;
    const point = updateDraftPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftAnnotation({
      page: pageNo,
      kind: activeTool,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
    });
    setSelectedAnnotationId(null);
    event.preventDefault();
    event.stopPropagation();
  };

  const handleAnnotationPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draftAnnotation) return;
    const point = updateDraftPoint(event);
    if (!point) return;
    setDraftAnnotation((prev) =>
      prev
        ? {
            ...prev,
            currentX: point.x,
            currentY: point.y,
          }
        : prev,
    );
  };

  const commitDraftAnnotation = async () => {
    if (!draftAnnotation) return;
    const { kind, page: targetPage, startX, startY, currentX, currentY } = draftAnnotation;
    setDraftAnnotation(null);

    let rect = normalizeRect(startX, startY, currentX, currentY);
    let content: string | undefined;

    if (kind ==="text") {
      rect = createTextRect(startX, startY);
      const raw = window.prompt(t.textAnnotationPrompt);
      if (raw === null) return;
      const trimmed = raw.trim();
      if (!trimmed) {
        showActionHint(t.textAnnotationCancelled);
        return;
      }
      content = trimmed;
    } else if (rect.width < 0.01 && rect.height < 0.01) {
      showActionHint(t.dragToCreate);
      return;
    }

    const pageBlocks = readingBlocksByPageRef.current.get(targetPage) || [];
    const blockId = findReadingBlockIdForRect(rect, pageBlocks);
    // ⚠️ 行吸附必须在**写入之前**，而不是渲染时补：存进localStorage 的
    // 1.7px 矩形在别的入口（笔记卡片、导出、AI 重新定位）里永远是错的，
    // 而渲染侧兜底只解决「看不看得见」。见 snapAnnotationRectToLines 的注释。
    const visibleRect =
      kind === "text"
        ? rect
        : snapAnnotationRectToLines(
            rect,
            blockId ? (pageBlocks.find((item) => item.id === blockId)?.lines ?? undefined) : undefined,
          );

    onAddAnnotation?.({
      blockId,
      page: targetPage,
      kind,
      rect: visibleRect,
      content,
    });
    setPage(targetPage);
    setIsNotesOpen(true);
    showActionHint(t.annotationSaved.replace("{label}", annotationLabels[kind]));
  };

  const handleAnnotationPointerUp = (pageNo: number, event: React.PointerEvent<HTMLDivElement>) => {
    if (!draftAnnotation || draftAnnotation.page !== pageNo) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    void commitDraftAnnotation();
  };

  /**
   * 选择式标注落纸：行类工具（highlight/underline/strike）激活时，mouseup 上的
   * 非空文本选区直接落成标注 —— 「标注和选择文本是同一个操作」（2026-10-09 用户裁决）。
   *
   * 几何来源是**真实选区行盒**（Range.getClientRects 的并集），比 overlay 拖拽坐标
   * 更准：它天然贴着文字。行吸附仍然要走一遍 —— 选区跨行时并集框的纵向跨度需要
   * 收敛成行并集，且与拖拽路径共享同一个吸附函数（写入侧行为必须一致）。
   *
   * 返回 true 表示本次 pointerup 已被消费（调用了 onAddAnnotation），上层不必再走
   * draft 提交路径。跨页选区当前只提交 pointerup 所在页的矩形 —— 跨页划线是罕见
   * 操作，等真实需求出现再按页拆分提交（注释先钉住这个已知边界）。
   */
  const commitSelectionAnnotation = (pageNo: number, pageEl: HTMLDivElement): boolean => {
    if (!isLineAnnotationTool(activeTool) || isTranslationReader) return false;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    if (!(selection.toString() || "").trim()) return false;
    const pageRect = pageEl.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) return false;

    const rects: DOMRect[] = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      const rangeRects = range.getClientRects();
      for (const item of rangeRects) {
        if (item.width <= 0 && item.height <= 0) continue;
        // 选区可能落在本页之外（跨页/页面边缘），只收与页面相交的行盒。
        if (item.right <= pageRect.left || item.left >= pageRect.right) continue;
        if (item.bottom <= pageRect.top || item.top >= pageRect.bottom) continue;
        rects.push(item);
      }
    }
    if (rects.length === 0) return false;

    const left = Math.min(...rects.map((item) => item.left));
    const top = Math.min(...rects.map((item) => item.top));
    const right = Math.max(...rects.map((item) => item.right));
    const bottom = Math.max(...rects.map((item) => item.bottom));
    const rect = {
      x: Math.max(0, (left - pageRect.left) / pageRect.width),
      y: Math.max(0, (top - pageRect.top) / pageRect.height),
      width: Math.min(1, (right - left) / pageRect.width),
      height: Math.min(1, (bottom - top) / pageRect.height),
    };

    const pageBlocks = readingBlocksByPageRef.current.get(pageNo) || [];
    const blockId = findReadingBlockIdForRect(rect, pageBlocks);
    // ⚠️ 与 commitDraftAnnotation 同一条铁律：行吸附在写入之前（见那里注释）。
    const visibleRect = snapAnnotationRectToLines(
      rect,
      blockId ? (pageBlocks.find((item) => item.id === blockId)?.lines ?? undefined) : undefined,
    );

    onAddAnnotation?.({
      blockId,
      page: pageNo,
      kind: activeTool,
      rect: visibleRect,
    });
    // 选区已落成标注：清除原生选区，把「选中态」让位给标注本身。
    selection.removeAllRanges();
    setPage(pageNo);
    setIsNotesOpen(true);
    showActionHint(t.annotationSaved.replace("{label}", annotationLabels[activeTool]));
    return true;
  };

  const handleAnnotationPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (draftAnnotation && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraftAnnotation(null);
  };

  const detachRightWindowHandlers = useCallback(() => {
    const handlers = rightWindowHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener("pointermove", handlers.onMove as EventListener);
    window.removeEventListener("pointerup", handlers.onUp as EventListener);
    window.removeEventListener("pointercancel", handlers.onCancel as EventListener);
    rightWindowHandlersRef.current = null;
  }, []);

  const cancelRightGesture = useCallback(
    (pointerId: number) => {
      const right = rightDragRef.current;
      if (!right.active || right.pointerId !== pointerId) return;

      rightDragRef.current = { active: false, moved: false, pointerId: null, pageNo: null, zoomAtStart: null };
      gestureStartRef.current = null;
      detachRightWindowHandlers();
      setIsGestureRightDown(false);
      if (
        zoomRenderReadyRef.current ||
        Math.abs(zoomTargetRef.current - renderZoomRef.current) <= ZOOM_ANIMATION_SETTLE
      ) {
        releaseLockedZoomPage();
      }
      scheduleRenderZoomCommit(zoomTargetRef.current);
      suppressNextContextMenuRef.current = true;
      window.setTimeout(() => {
        suppressNextContextMenuRef.current = false;
      }, 120);
    },
    [detachRightWindowHandlers, releaseLockedZoomPage, scheduleRenderZoomCommit],
  );

  const moveRightGesture = useCallback((pointerId: number, clientX: number, clientY: number) => {
    const right = rightDragRef.current;
    if (!right.active || right.pointerId !== pointerId) return;
    const start = gestureStartRef.current;
    if (!start) {
      gestureStartRef.current = { x: clientX, y: clientY };
      return;
    }

    const dx = clientX - start.x;
    const dy = clientY - start.y;
    if (!right.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      rightDragRef.current = { ...right, moved: true };
    }

    if (!right.moved) return;

    const root = scrollRef.current;
    if (root) {
      root.scrollLeft -= dx;
      root.scrollTop -= dy;
    }

    gestureStartRef.current = { x: clientX, y: clientY };
  }, []);

  const endRightGesture = useCallback(
    (pointerId: number, clientX: number, clientY: number, options?: { openMenuIfClick?: boolean }) => {
      const right = rightDragRef.current;
      if (!right.active || right.pointerId !== pointerId) return false;

      /**
       * 「原地右键点击」的三个必要条件，缺一不可：
       *   ① 调用方允许开（拖拽平移那条路径传 false）
       *   ② 没有平移过（`moved`）——「右键拖拽 = 平移」不该弹菜单
       *   ③ **这次手势没有改变缩放** ← 本行是 2026-10-10 补的
       *
       * ③ 为什么必须有：右键按住 + 滚轮是**缩放**手势，而滚轮不移动指针 ——
       * `moved` 恒为 false，于是每次缩放一松手都被判成「原地点击」而弹菜单。
       * 读者在页面上缩放，每次松手都被菜单打断，这就是「缩放频繁触发右键菜单」。
       *
       * 判据用「缩放目标相对手势起点的变化量」而不是「onWheel 有没有被调用」：
       * 缩放有三条入口（右键滚轮 / 触控板捏合 / pinch 引擎），逐个打标记要改三处、
       * 漏一处就静默失效；而它们最终都落在 `zoomTargetRef` 上，比一次差值全覆盖。
       * 容差 0.5 个百分点：`wheelZoomStep` 最小步进是 7%，而缓动收敛的尾数
       * 远小于 0.5 —— 真缩放过就必然超过它。
       */
      const zoomChangedDuringGesture =
        right.zoomAtStart !== null && Math.abs(zoomTargetRef.current - right.zoomAtStart) > 0.5;
      const shouldOpenMenu = Boolean(options?.openMenuIfClick) && !right.moved && !zoomChangedDuringGesture;

      rightDragRef.current = { active: false, moved: false, pointerId: null, pageNo: null, zoomAtStart: null };
      gestureStartRef.current = null;
      detachRightWindowHandlers();
      setIsGestureRightDown(false);
      scheduleRenderZoomCommit(zoomTargetRef.current);
      if (
        zoomRenderReadyRef.current ||
        Math.abs(zoomTargetRef.current - renderZoomRef.current) <= ZOOM_ANIMATION_SETTLE
      ) {
        releaseLockedZoomPage();
      }

      // suppress the native/contextmenu event that usually fires after right click release
      suppressNextContextMenuRef.current = true;
      window.setTimeout(() => {
        suppressNextContextMenuRef.current = false;
      }, 120);

      if (shouldOpenMenu && right.pageNo) {
        const contextPage = right.pageNo;
        setPage(clampPage(contextPage, totalPages));
        contextPointRef.current = { pageNo: contextPage, x: clientX, y: clientY };
        const imageTarget = imageTargetAtPointRef.current(contextPage, clientX, clientY);
        setSelectedImageKey(imageTargetKey(imageTarget));
        setContextMenu({
          x: clientX,
          y: clientY,
          isOpen: true,
          pageNo: clampPage(contextPage, totalPages),
          imageTarget,
        });
        void (async () => {
          try {
            await detectPageImagesRef.current(contextPage);
            await loadPageReadingBlocksRef.current(contextPage).catch(() => []);
            const target = imageTargetAtPointRef.current(contextPage, clientX, clientY);
            setContextMenu((current) => {
              const point = contextPointRef.current;
              if (
                !current.isOpen ||
                current.pageNo !== contextPage ||
                !point ||
                point.x !== clientX ||
                point.y !== clientY
              ) {
                return current;
              }
              return { ...current, imageTarget: target };
            });
            setSelectedImageKey(imageTargetKey(target));
          } catch {
            // Keep the page export actions available when optional image indexing fails.
          }
        })();
      }

      return true;
    },
    [detachRightWindowHandlers, releaseLockedZoomPage, scheduleRenderZoomCommit, totalPages],
  );

  const attachRightWindowHandlers = useCallback(() => {
    if (rightWindowHandlersRef.current) return;
    const onMove = (event: PointerEvent) => {
      moveRightGesture(event.pointerId, event.clientX, event.clientY);
      // avoid text selection / native gestures while right-dragging
      event.preventDefault();
    };
    const onUp = (event: PointerEvent) => {
      if (endRightGesture(event.pointerId, event.clientX, event.clientY, { openMenuIfClick: true })) {
        event.preventDefault();
      }
    };
    const onCancel = (event: PointerEvent) => {
      cancelRightGesture(event.pointerId);
    };

    rightWindowHandlersRef.current = { onMove, onUp, onCancel };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: false });
    window.addEventListener("pointercancel", onCancel, { passive: true });
  }, [cancelRightGesture, endRightGesture, moveRightGesture]);

  const handleViewerPointerDown = (pageNo: number, event: React.PointerEvent<HTMLDivElement>) => {
    const isRight = event.button === 2 || (event.buttons & 2) === 2;
    if (isRight) {
      // 锁页走**唯一入口**（lockZoomPage）。这里曾经内联重写一遍，
      // 而「采页流基准」只写在 applyZoomTarget 的那份副本里 —— 于是右键路径
      // 提前锁页把对方的分支整个跳过，预览原点恒为 0 0，缩放甩飞光标下的内容。
      const lockedPage = lockZoomPage(pageNo);
      rightDragRef.current = {
        active: true,
        moved: false,
        pointerId: event.pointerId,
        pageNo: lockedPage,
        // 记下起点缩放：松手时用它判断「这次手势是不是缩放过」——
        // 滚轮不移动指针，只看 `moved` 会把每一次缩放都误判成「原地点击」并弹菜单。
        zoomAtStart: zoomTargetRef.current,
      };
      gestureStartRef.current = { x: event.clientX, y: event.clientY };
      setIsGestureRightDown(true);
      setPage(lockedPage);
      attachRightWindowHandlers();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // ignore capture failures; window listeners will still track the gesture
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    handleAnnotationPointerDown(pageNo, event);
  };

  const handleViewerPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const right = rightDragRef.current;
    if (right.active && right.pointerId === event.pointerId) {
      moveRightGesture(event.pointerId, event.clientX, event.clientY);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    handleAnnotationPointerMove(event);
  };

  const handleViewerPointerUp = (pageNo: number, event: React.PointerEvent<HTMLDivElement>) => {
    const right = rightDragRef.current;
    if (right.active && right.pointerId === event.pointerId && right.pageNo === pageNo) {
      endRightGesture(event.pointerId, event.clientX, event.clientY, { openMenuIfClick: true });
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (commitSelectionAnnotation(pageNo, event.currentTarget)) {
      return;
    }

    handleAnnotationPointerUp(pageNo, event);
  };

  const handleViewerPointerCancel = (pageNo: number, event: React.PointerEvent<HTMLDivElement>) => {
    const right = rightDragRef.current;
    if (right.active && right.pointerId === event.pointerId && right.pageNo === pageNo) {
      cancelRightGesture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    handleAnnotationPointerCancel(event);
  };

  const draftRect = useMemo(() => {
    if (!draftAnnotation) return null;
    if (draftAnnotation.kind ==="text") {
      return createTextRect(draftAnnotation.startX, draftAnnotation.startY);
    }
    const raw = normalizeRect(
      draftAnnotation.startX,
      draftAnnotation.startY,
      draftAnnotation.currentX,
      draftAnnotation.currentY,
    );
    // ⚠️ 草稿预览必须与 `commitDraftAnnotation` 落地的矩形**走同一个函数**。
    // 不共用的话，读者拖动时看到一条细缝、松手后整行被涂上 ——
    // 「所见非所得」在划线工具上的代价是读者以为工具坏了。
    const pageBlocks = readingBlocksByPageRef.current.get(draftAnnotation.page) || [];
    const blockId = findReadingBlockIdForRect(raw, pageBlocks);
    return snapAnnotationRectToLines(
      raw,
      blockId ? (pageBlocks.find((item) => item.id === blockId)?.lines ?? undefined) : undefined,
    );
  }, [draftAnnotation]);

  const updateReadingBlocks = useCallback(
    (pageNo: number, blocks: PdfReadingBlock[]) => {
      if (currentFileIdRef.current !== fileId) return;
      const previous = readingBlocksByPageRef.current.get(pageNo) || [];
      const structured = previous.filter((block) => block.source !=="pdfjs-dom");
      if (blocks.length === 0) {
        if (structured.length > 0) readingBlocksByPageRef.current.set(pageNo, structured);
        else readingBlocksByPageRef.current.delete(pageNo);
        setReadingBlocksVersion((value) => value + 1);
        return;
      }
      readingBlocksByPageRef.current.set(pageNo, [
        ...structured,
        ...blocks.map((block) => ({ ...block, documentId: documentId || block.documentId })),
      ]);
      // PDF.js text-layer geometry is authoritative for derived image/resource views.
      // Publish it immediately instead of waiting for a later sidebar state change.
      setReadingBlocksVersion((value) => value + 1);
    },
    [documentId, fileId],
  );

  const updatePageLinks = useCallback(
    (pageNo: number, links: Array<{ url: string }>) => {
      if (currentFileIdRef.current !== fileId) return;
      setLinksByPage((previous) => {
        const next = {
          ...previous,
          [pageNo]: links.map((link, index) => ({
            ...link,
            page: pageNo,
            documentId,
            resourceId:`${documentId || fileId}:link:${pageNo}:${index}:${link.url}`,
          })),
        };
        linksByPageRef.current = next;
        return next;
      });
    },
    [documentId, fileId],
  );

  const storeReadingBlocks = useCallback(
    (blocks: PdfReadingBlock[]) => {
      if (currentFileIdRef.current !== fileId) return;
      const byPage = new Map<number, PdfReadingBlock[]>();
      for (const block of blocks) {
        const pageBlocks = byPage.get(block.page) || [];
        pageBlocks.push(block);
        byPage.set(block.page, pageBlocks);
      }
      for (const [pageNo, pageBlocks] of byPage) {
        readingBlocksByPageRef.current.set(
          pageNo,
          pageBlocks.map((block) => ({ ...block, documentId: documentId || block.documentId })),
        );
      }
    },
    [documentId, fileId],
  );

  const loadPageReadingBlocks = useCallback(
    async (pageNo: number, signal?: AbortSignal) => {
      if (!fileId) return [] as PdfReadingBlock[];
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted","AbortError");
      }
      const target = clampPage(pageNo, totalPages);
      const cached = readingBlocksByPageRef.current.get(target);
      if (cached) return cached;
      const requestKey =`${fileId}:${target}`;
      const inFlight = readingBlocksInFlightRef.current.get(requestKey);
      if (inFlight) return inFlight;

      const controller = new AbortController();
      const abortRequest = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abortRequest, { once: true });
      readingBlocksAbortRef.current.set(requestKey, controller);
      const request = api
        .getPDFReadingBlocks(fileId, undefined, controller.signal, {
          startPage: target,
          endPage: target,
        })
        .then((blocks) => {
          if (currentFileIdRef.current !== fileId) return blocks;
          storeReadingBlocks(blocks);
          setReadingBlocksVersion((value) => value + 1);
          return blocks;
        })
        .finally(() => {
          signal?.removeEventListener("abort", abortRequest);
          if (readingBlocksInFlightRef.current.get(requestKey) === request) {
            readingBlocksInFlightRef.current.delete(requestKey);
          }
          if (readingBlocksAbortRef.current.get(requestKey) === controller) {
            readingBlocksAbortRef.current.delete(requestKey);
          }
        });

      readingBlocksInFlightRef.current.set(requestKey, request);
      return request;
    },
    [fileId, storeReadingBlocks, totalPages],
  );

  const detectPageImages = useCallback(
    async (pageNo: number, signal?: AbortSignal) => {
      if (!fileId) return;
      const target = clampPage(pageNo, totalPages);
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted","AbortError");
      }
      if (pdfImagesByPageRef.current[target] !== undefined) return pdfImagesByPageRef.current[target];
      let shared = imageDetectionInFlightRef.current.get(target);
      if (!shared) {
        const controller = new AbortController();
        const task = (async () => {
          const { images } = await api.getPDFImages(fileId, target, controller.signal);
          if (controller.signal.aborted) {
            throw controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new DOMException("The operation was aborted","AbortError");
          }
          if (currentFileIdRef.current !== fileId) return images;
          setPdfImagesByPage((prev) => {
            const nextImages = images.map((image, index) => ({
              ...image,
              documentId: documentId || image.documentId,
              resourceId: image.resourceId ||`${documentId || fileId}:image:${target}:${image.xref || index}`,
            }));
            const next = { ...prev, [target]: nextImages };
            pdfImagesByPageRef.current = next;
            return next;
          });
          return images;
        })();
        shared = { promise: task, controller, consumers: 0, settled: false };
        imageDetectionInFlightRef.current.set(target, shared);
        void task
          .finally(() => {
            shared!.settled = true;
            if (imageDetectionInFlightRef.current.get(target) === shared) {
              imageDetectionInFlightRef.current.delete(target);
            }
          })
          .catch(() => undefined);
      }

      const task = shared;
      task.consumers += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        task.consumers = Math.max(0, task.consumers - 1);
        if (task.consumers === 0 && !task.settled) {
          if (imageDetectionInFlightRef.current.get(target) === task) {
            imageDetectionInFlightRef.current.delete(target);
          }
          task.controller.abort(new DOMException("The operation was aborted","AbortError"));
        }
      };
      try {
        if (!signal) {
          try {
            return await task.promise;
          } finally {
            release();
          }
        }
        return await new Promise<PDFImageInfo[]>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            release();
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("The operation was aborted","AbortError"),
            );
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
            return;
          }
          task.promise.then(
            (images) => {
              signal.removeEventListener("abort", onAbort);
              release();
              resolve(images);
            },
            (error) => {
              signal.removeEventListener("abort", onAbort);
              release();
              reject(error);
            },
          );
        });
      } catch (error) {
        release();
        if (signal?.aborted || (error instanceof DOMException && error.name ==="AbortError")) throw error;
        if (currentFileIdRef.current !== fileId) throw error;
        const message = error instanceof Error ? error.message : String(error);
        setImageLabelStatus({ kind:"error", message: t.imageLabelFailed.replace("{message}", message) });
        throw error;
      }
    },
    [documentId, fileId, t.imageLabelFailed, totalPages],
  );

  const ensureReadingBlocksLoaded = useCallback(
    (signal?: AbortSignal) => {
      if (!fileId) return Promise.resolve([] as PdfReadingBlock[]);
      if (readingBlocksLoadedFileRef.current === fileId) {
        return Promise.resolve(Array.from(readingBlocksByPageRef.current.values()).flat());
      }
      if (readingBlocksLoadRef.current) return readingBlocksLoadRef.current;
      const controller = new AbortController();
      readingBlocksLoadAbortRef.current = controller;
      const detachCallerAbort = () => {
        if (signal?.aborted) controller.abort(signal.reason);
      };
      signal?.addEventListener("abort", detachCallerAbort, { once: true });
      if (signal?.aborted) detachCallerAbort();
      const request = api
        .getPDFReadingBlocks(
          fileId,
          (completed, total) => {
            if (currentFileIdRef.current !== fileId) return;
            setImageLabelStatus({
              kind:"loading",
              message:
                language ==="zh-CN"
                  ?`正在抽取全文块 ${completed}/${total} 页...`
                  :`Extracting reading blocks ${completed}/${total} pages...`,
            });
          },
          controller.signal,
        )
        .then((blocks) => {
          if (currentFileIdRef.current !== fileId) return blocks;
          storeReadingBlocks(blocks);
          readingBlocksLoadedFileRef.current = fileId;
          setReadingBlocksVersion((value) => value + 1);
          return blocks;
        })
        .catch((error) => {
          if (
            signal?.aborted ||
            controller.signal.aborted ||
            (error instanceof DOMException && error.name ==="AbortError")
          ) {
            if (currentFileIdRef.current !== fileId) throw error;
            setImageLabelStatus({
              kind:"idle",
              message: language ==="zh-CN" ?"全文块提取已取消" :"Reading block extraction cancelled",
            });
            throw error;
          }
          if (currentFileIdRef.current !== fileId) throw error;
          const message = error instanceof Error ? error.message : String(error);
          setImageLabelStatus({ kind:"error", message: t.imageLabelFailed.replace("{message}", message) });
          throw error;
        })
        .finally(() => {
          signal?.removeEventListener("abort", detachCallerAbort);
          if (readingBlocksLoadRef.current === request) readingBlocksLoadRef.current = null;
          if (readingBlocksLoadAbortRef.current === controller) readingBlocksLoadAbortRef.current = null;
        });
      readingBlocksLoadRef.current = request;
      return request;
    },
    [fileId, language, storeReadingBlocks, t.imageLabelFailed],
  );

  const getVisibleImagesForPage = useCallback(
    (pageNo: number) => {
      const indexedImages = pdfImagesByPage[pageNo] || [];
      const indexedPageSize = indexedImages.find(
        (image) =>
          Number.isFinite(image.pageWidth) &&
          Number.isFinite(image.pageHeight) &&
          image.pageWidth! > 0 &&
          image.pageHeight! > 0,
      );
      const pageSize =
        pageSizes[pageNo] ||
        (indexedPageSize
          ? { width: indexedPageSize.pageWidth!, height: indexedPageSize.pageHeight! }
          : DEFAULT_PAGE_SIZE);
      const pageReadingBlocks = readingBlocksByPageRef.current.get(pageNo) || [];
      const xrefItems = indexedImages
        .map((img) => {
          const bbox = Array.isArray(img.bbox) && img.bbox.length === 4 ? img.bbox : null;
          const rect = bbox ? normalizeImageBbox(bbox, pageSize) : null;
          if (!rect) return null;
          if (!isLikelyImageCandidate(img, rect, pageSize, pageReadingBlocks)) return null;
          return { img, rect };
        })
        .filter(
          (item): item is { img: PDFImageInfo; rect: { left: number; top: number; width: number; height: number } } =>
            Boolean(item),
        );
      const blockItems = pageReadingBlocks
        .map((block) => imageBlockToCandidate(block, pageSize))
        .filter(
          (item): item is { img: PDFImageInfo; rect: { left: number; top: number; width: number; height: number } } =>
            Boolean(item),
        );
      return dedupeImageCandidates([...xrefItems, ...blockItems], pageSize);
    },
    [pageSizes, pdfImagesByPage, readingBlocksVersion],
  );

  detectPageImagesRef.current = detectPageImages;
  loadPageReadingBlocksRef.current = loadPageReadingBlocks;

  imageTargetAtPointRef.current = (pageNo, clientX, clientY) => {
    const targetPage = clampPage(pageNo, totalPages);
    const pageNode = pageRefs.current.get(targetPage);
    if (!pageNode) return null;
    const pageRect = pageNode.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) return null;
    const indexedImage = (pdfImagesByPage[targetPage] || []).find(
      (image) =>
        Number.isFinite(image.pageWidth) &&
        Number.isFinite(image.pageHeight) &&
        image.pageWidth! > 0 &&
        image.pageHeight! > 0,
    );
    const pageSize =
      pageSizes[targetPage] ||
      (indexedImage ? { width: indexedImage.pageWidth!, height: indexedImage.pageHeight! } : DEFAULT_PAGE_SIZE);
    const localX = ((clientX - pageRect.left) / pageRect.width) * pageSize.width;
    const localY = ((clientY - pageRect.top) / pageRect.height) * pageSize.height;
    const hit = getVisibleImagesForPage(targetPage).find(
      ({ rect }) =>
        localX >= rect.left &&
        localX <= rect.left + rect.width &&
        localY >= rect.top &&
        localY <= rect.top + rect.height,
    );
    return hit ? { pageNo: targetPage, image: hit.img, rect: hit.rect } : null;
  };

  const prefetchImageLabelsAround = useCallback(
    (centerPage: number) => {
      if (!fileId || !pdfDoc) return;
      const target = clampPage(centerPage, totalPages);
      const backgroundPages = [target + 1, target - 1]
        .map((item) => clampPage(item, totalPages))
        .filter((item, index, array) => array.indexOf(item) === index);
      setImageLabelStatus({ kind:"loading", message: t.imageLabelDetecting });
      void detectPageImages(target)
        .then(async (results) => {
          const nearbyPages = [target, ...backgroundPages].filter(
            (pageNo, index, pages) => pages.indexOf(pageNo) === index,
          );
          await Promise.all(
            nearbyPages.map(async (pageNo) => {
              try {
                await loadPageReadingBlocks(pageNo);
              } catch {
                // Xref/vector detection remains useful when the optional page block fallback fails.
              }
            }),
          );
          for (const pageNo of backgroundPages) void detectPageImages(pageNo).catch(() => undefined);
          const count = Math.max(results?.length ?? 0, getVisibleImagesForPage(target).length);
          setImageLabelStatus({ kind:"ready", message: t.imageLabelReady.replace("{count}", String(count)) });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setImageLabelStatus({ kind:"error", message: t.imageLabelFailed.replace("{message}", message) });
        });
    },
    [
      detectPageImages,
      fileId,
      getVisibleImagesForPage,
      loadPageReadingBlocks,
      pdfDoc,
      t.imageLabelDetecting,
      t.imageLabelFailed,
      t.imageLabelReady,
      totalPages,
    ],
  );

  prefetchImageLabelsAroundRef.current = prefetchImageLabelsAround;

  const getCollectedReadingBlocks = useCallback(() => {
    return Array.from(readingBlocksByPageRef.current.values())
      .flat()
      .filter((block) => block.text.trim().length > 0)
      .sort(compareReadingBlockOrder);
  }, []);

  const loadFullTranslationBlocks = useCallback(
    async (signal: AbortSignal) => {
      if (!fileId) return getCollectedReadingBlocks();
      try {
        const blocks = await ensureReadingBlocksLoaded(signal);
        if (signal.aborted) return [];
        const textBlocks = blocks.filter((block) => block.text.trim().length > 0).sort(compareReadingBlockOrder);
        if (textBlocks.length > 0) {
          storeReadingBlocks(textBlocks);
          return textBlocks;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showActionHint(
          language ==="zh-CN"
            ?`全文块抽取失败，改用已加载页面：${message}`
            :`Full-document block extraction failed; using loaded pages: ${message}`,
        );
      }
      return getCollectedReadingBlocks();
    },
    [ensureReadingBlocksLoaded, fileId, getCollectedReadingBlocks, language, storeReadingBlocks],
  );

  // 打开文档时恢复该文档的 AI 记录（每份 PDF 一个 JSON，见 services/assistHistory.ts）。
  // ⚠️ 必须在 startFullTranslation 之前声明：它的 useCallback 依赖数组在渲染期求值，
  // 引用后声明的 const 会触发 TDZ（tsc 会红，别只靠 eslint）。
  useEffect(() => {
    let canceled = false;
    setAssistHistory([]);
    if (!documentId) return;
    void loadAssistHistory(documentId).then((entries) => {
      if (!canceled) setAssistHistory(entries);
    });
    return () => {
      canceled = true;
    };
  }, [documentId]);

  const recordAssistHistory = useCallback(
    (entry: Omit<AssistHistoryEntry, "id" | "createdAt">) => {
      if (!documentId || !entry.result.trim()) return;
      const full: AssistHistoryEntry = {
        ...entry,
        id: newAssistHistoryId(),
        createdAt: new Date().toISOString(),
      };
      void persistAssistHistoryEntry(documentId, assistHistoryRef.current, full).then((next) => {
        assistHistoryRef.current = next;
        setAssistHistory(next);
      });
    },
    [documentId],
  );

  const handleClearAssistHistory = useCallback(() => {
    if (!documentId) return;
    void clearAssistHistory(documentId).then(() => {
      assistHistoryRef.current = [];
      setAssistHistory([]);
      showActionHint(t.assistHistoryCleared);
    });
  }, [documentId, t.assistHistoryCleared]);

  const startFullTranslation = useCallback(() => {
    if (!fileId) {
      showActionHint(language ==="zh-CN" ?"请先打开 PDF。" :"Open a PDF first.");
      return;
    }

    fullTranslationAbortRef.current?.abort();
    translationRetryAbortRef.current?.abort();
    translationRetryAbortRef.current = null;
    const controller = new AbortController();
    fullTranslationAbortRef.current = controller;
    fullTranslationResultsRef.current = [];
    setIsNotesOpen(true);
    setSidePanelView("translation");
    setFullTranslation({
      status: language ==="zh-CN" ?"正在抽取全文块..." :"Extracting full-document blocks...",
      completed: 0,
      total: 0,
      results: [],
      isLoading: true,
    });

    void loadFullTranslationBlocks(controller.signal)
      .then((blocks) => {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("全文翻译已取消。");
        }
        if (blocks.length === 0) {
          throw new Error(
            language ==="zh-CN" ?"未抽取到可翻译文本块。" :"No translatable text blocks were extracted.",
          );
        }
        setFullTranslation((prev) => ({
          ...prev,
          status: language ==="zh-CN" ?"正在分块翻译..." :"Translating blocks...",
          total: blocks.length,
        }));
        const cached = loadTranslationCache("pdf", documentId || fileId, aiModelConfig, blocks);
        if (cached) {
          return Promise.resolve({ blocks, results: cached.results });
        }
        const blockOrder = new Map(blocks.map((block, index) => [block.id, index]));
        return translateReadingBlocks({
          config: aiModelConfig,
          blocks,
          sourceTitle: title,
          signal: controller.signal,
          onProgress: (completed, total, latest) => {
            if (controller.signal.aborted || fullTranslationAbortRef.current !== controller) return;
            if (latest) {
              fullTranslationResultsRef.current = [
                ...fullTranslationResultsRef.current.filter((item) => item.block.id !== latest.block.id),
                latest,
              ].sort(
                (a, b) =>
                  (blockOrder.get(a.block.id) ?? Number.MAX_SAFE_INTEGER) -
                  (blockOrder.get(b.block.id) ?? Number.MAX_SAFE_INTEGER),
              );
            }
            const shouldFlushResults =
              latest !== undefined && (fullTranslationResultsRef.current.length % 8 === 0 || completed === total);
            setFullTranslation((prev) => ({
              ...prev,
              completed,
              total,
              status:`${completed}/${total}`,
              results: shouldFlushResults ? [...fullTranslationResultsRef.current] : prev.results,
            }));
          },
        }).then((results) => ({ blocks, results }));
      })
      .then((results) => {
        if (controller.signal.aborted || fullTranslationAbortRef.current !== controller) return;
        saveTranslationCache("pdf", documentId || fileId, aiModelConfig, results.blocks, results.results);
        recordAssistHistory({
          kind:"full-translation",
          reference:`${title} / 全文`,
          excerpt: language ==="zh-CN" ? `全文翻译（${results.results.length} 块）` : `Full translation (${results.results.length} blocks)`,
          result:
            language ==="zh-CN"
              ? `已完成 ${results.results.length} 段翻译，详见「翻译」页签。`
              : `Translated ${results.results.length} blocks. See the Translation tab.`,
          model: aiModelConfig.model,
        });
        setFullTranslation({
          status: language ==="zh-CN" ?"全文翻译完成" :"Full translation complete",
          completed: results.results.length,
          total: results.blocks.length,
          results: results.results,
          isLoading: false,
        });
        fullTranslationResultsRef.current = results.results;
      })
      .catch((error) => {
        if (fullTranslationAbortRef.current !== controller) return;
        const aborted = controller.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        setFullTranslation((prev) => ({
          ...prev,
          status: aborted
            ? language ==="zh-CN"
              ?"全文翻译已取消"
              :"Full translation cancelled"
            :`${t.translateFailed}: ${message}`,
          isLoading: false,
        }));
      })
      .finally(() => {
        if (fullTranslationAbortRef.current === controller) {
          fullTranslationAbortRef.current = null;
        }
      });
  }, [aiModelConfig, documentId, fileId, language, loadFullTranslationBlocks, recordAssistHistory, t.translateFailed, title]);

  const retryFullTranslationBlock = useCallback(
    async (block: PdfReadingBlock) => {
      if (!fileId) return;
      translationRetryAbortRef.current?.abort();
      const controller = new AbortController();
      translationRetryAbortRef.current = controller;
      setFullTranslation((prev) => ({
        ...prev,
        status: language ==="zh-CN" ?"正在重试段落..." :"Retrying block...",
      }));
      try {
        const result = await translateReadingBlock({
          config: aiModelConfig,
          block,
          sourceTitle: title,
          signal: controller.signal,
        });
        if (controller.signal.aborted || translationRetryAbortRef.current !== controller) return;
        setFullTranslation((prev) => {
          const results = [...prev.results.filter((item) => item.block.id !== block.id), result].sort((a, b) =>
            compareReadingBlockOrder(a.block, b.block),
          );
          fullTranslationResultsRef.current = results;
          saveTranslationCache(
"pdf",
            documentId || fileId,
            aiModelConfig,
            results.map((item) => item.block),
            results,
          );
          return { ...prev, results, status: language ==="zh-CN" ?"段落翻译已更新" :"Block translation updated" };
        });
      } catch (error) {
        if (controller.signal.aborted || translationRetryAbortRef.current !== controller) return;
        const message = error instanceof Error ? error.message : String(error);
        setFullTranslation((prev) => ({
          ...prev,
          results: prev.results.map((item) => (item.block.id === block.id ? { ...item, error: message } : item)),
          status:`${t.translateFailed}: ${message}`,
        }));
      } finally {
        if (translationRetryAbortRef.current === controller) translationRetryAbortRef.current = null;
      }
    },
    [aiModelConfig, documentId, fileId, language, t.translateFailed, title],
  );

  const openTranslationPreview = useCallback(
    (selection: ReadingAssistSelection) => {
      translationAbortRef.current?.abort();
      const controller = new AbortController();
      translationAbortRef.current = controller;
      setIsNotesOpen(true);
      setSidePanelView("translation");
      setTranslationPanel({
        selection,
        answer:"",
        status: t.translating,
        isLoading: true,
      });
      void translateReadingSelection({
        config: aiModelConfig,
        excerpt: selection.text,
        reference:`${selection.sourceTitle} / ${selection.reference}`,
        signal: controller.signal,
      })
        .then((result) => {
          if (controller.signal.aborted || translationAbortRef.current !== controller) return;
          setTranslationPanel({
            selection,
            answer: result.answer,
            status:"",
            isLoading: false,
          });
          recordAssistHistory({
            kind:"translate",
            reference:`${selection.sourceTitle} / ${selection.reference}`,
            page: selection.page,
            excerpt: selection.text,
            result: result.answer,
            model: aiModelConfig.model,
          });
        })
        .catch((error) => {
          if (controller.signal.aborted || translationAbortRef.current !== controller) return;
          const message = error instanceof Error ? error.message : String(error);
          setTranslationPanel({
            selection,
            answer:"",
            status:`${t.translateFailed}: ${message}`,
            isLoading: false,
          });
        })
        .finally(() => {
          if (translationAbortRef.current === controller) translationAbortRef.current = null;
        });
    },
    [aiModelConfig, recordAssistHistory, t.translateFailed, t.translating],
  );

  useEffect(() => {
    if (!fileId || !pdfDoc) return;
    // 依赖里刻意**不放** `detectPageImages` / `prefetchImageLabelsAround`：它们的身份会随
    // `pdfImagesByPage`、`pageSizes` 这类每渲染都变新的派生数据漂移，放进来会让同一页的
    // 扫描被反复发起又取消。这里只依赖「换文件 / 换页」这些真正决定扫谁的语义值，
    // 实现统一从 ref 取最新的。
    if (isImageLabelReader) {
      prefetchImageLabelsAroundRef.current(page);
      return;
    }
    const controller = new AbortController();
    /**
     * ⚠️ 换页即扫是错的：`page` 在滚动期间每跨一页就变一次，于是滚动跨 10 页会
     * 立刻发 10 次后端请求（穿过 PDF.js / 后端边界，Tauri 下是本地服务 +
     * PyMuPDF 扫该页图像），并取消掉 9 次 —— 每页一次的后端往返与滚动抢主线程，
     * 用户感知就是「滚动/翻页卡」。用户 2026-10-10 报的就是这个。
     *
     * 改成静默期后再扫：只在**滚动停下的那一页**上发一次请求。
     * 功能不受影响 —— 右键菜单在打开时会自己再要一次（见
     * `handleViewerContextMenu` 里的 `detectPageImagesRef.current(pageNo)`），
     * 预取只负责提前量，不是正确性的唯一来源。
     */
    const timer = window.setTimeout(() => {
      void detectPageImagesRef.current(page, controller.signal).catch(() => undefined);
    }, PAGE_METADATA_IDLE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [fileId, isImageLabelReader, page, pdfDoc]);

  useEffect(() => {
    if (!fileId || !pdfDoc || !isNotesOpen || sidePanelView !=="resources") return;
    const scanId = ++resourcesScanRef.current;
    const controller = new AbortController();
    resourceScanAbortRef.current?.abort();
    resourceScanAbortRef.current = controller;
    setResourceScan({ status:"scanning", completed: 0, total: totalPages, failedPages: [] });
    let cancelProgressFrame = () => {};
    void (async () => {
      const failedPages: number[] = [];
      const scannedPageSizes: Record<number, PageSize> = {};
      let completed = 0;
      let nextPage = 1;
      let progressFrame: number | null = null;
      let pendingCompleted = 0;
      const publishProgress = () => {
        pendingCompleted = completed;
        if (progressFrame !== null) return;
        progressFrame = window.requestAnimationFrame(() => {
          progressFrame = null;
          if (controller.signal.aborted || resourcesScanRef.current !== scanId) return;
          setResourceScan((previous) => ({ ...previous, completed: pendingCompleted, failedPages: [...failedPages] }));
        });
      };
      cancelProgressFrame = () => {
        if (progressFrame !== null) {
          window.cancelAnimationFrame(progressFrame);
          progressFrame = null;
        }
      };
      const scanPage = async (pageNo: number) => {
        if (controller.signal.aborted || resourcesScanRef.current !== scanId) return;
        if (
          resourceScannedPagesRef.current.has(pageNo) ||
          (pdfImagesByPageRef.current[pageNo] !== undefined &&
            Object.prototype.hasOwnProperty.call(linksByPageRef.current, pageNo) &&
            Object.prototype.hasOwnProperty.call(resourceTextByPageRef.current, pageNo))
        ) {
          if (!resourceScannedPagesRef.current.has(pageNo)) {
            resourceScannedPagesRef.current.add(pageNo);
            setResourceScannedPages((previous) =>
              previous.includes(pageNo) ? previous : [...previous, pageNo].sort((a, b) => a - b),
            );
          }
          completed += 1;
          publishProgress();
          return;
        }
        let pageProxy: {
          getAnnotations: () => Promise<unknown>;
          getTextContent: () => Promise<{ items: unknown[] }>;
          getViewport: (params: { scale: number }) => { width: number; height: number };
          cleanup: () => void;
        } | null = null;
        try {
          pageProxy = await getPdfPageWithResourceTimeout(pdfDoc, pageNo);
          const viewport = pageProxy.getViewport({ scale: 1 });
          if (viewport.width > 0 && viewport.height > 0) {
            scannedPageSizes[pageNo] = { width: viewport.width, height: viewport.height };
          }
          const [annotations, textContent] = await withResourceScanTimeout(
            Promise.all([pageProxy.getAnnotations(), pageProxy.getTextContent()]),
`PDF page ${pageNo} resource extraction`,
          );
          if (controller.signal.aborted || resourcesScanRef.current !== scanId) return;
          const links = (annotations as Array<Record<string, unknown>>)
            .filter((item) => item.subtype ==="Link" && typeof item.url ==="string" && item.url)
            .map((item, index) => ({
              url: item.url as string,
              page: pageNo,
              documentId,
              resourceId:`${documentId || fileId}:link:${pageNo}:${index}:${item.url as string}`,
            }));
          const text = (textContent.items as Array<Record<string, unknown>>)
            .map((item) => (typeof item.str ==="string" ? item.str :""))
            .join("")
            .replace(/\s+/g,"")
            .trim();
          setLinksByPage((previous) => {
            const next = { ...previous, [pageNo]: links };
            linksByPageRef.current = next;
            return next;
          });
          setResourceTextByPage((previous) => {
            const next = { ...previous, [pageNo]: text };
            resourceTextByPageRef.current = next;
            return next;
          });
          const detectedImages = await detectPageImages(pageNo, controller.signal);
          // Most PDFs expose images through native metadata. If that fast
          // path yields no usable candidate, use the existing page-level
          // reading-block extractor as a targeted fallback. Do not start the
          // full-document block scan for every resource page.
          if ((detectedImages?.length ?? 0) === 0) {
            await loadPageReadingBlocks(pageNo, controller.signal).catch(() => undefined);
          }
          resourceScannedPagesRef.current.add(pageNo);
          setResourceScannedPages((previous) =>
            previous.includes(pageNo) ? previous : [...previous, pageNo].sort((a, b) => a - b),
          );
        } catch {
          if (!controller.signal.aborted && resourcesScanRef.current === scanId) failedPages.push(pageNo);
        } finally {
          pageProxy?.cleanup();
          if (!controller.signal.aborted && resourcesScanRef.current === scanId) {
            completed += 1;
            publishProgress();
          }
        }
      };
      const worker = async () => {
        while (!controller.signal.aborted && resourcesScanRef.current === scanId) {
          const pageNo = nextPage++;
          if (pageNo > totalPages) return;
          await scanPage(pageNo);
        }
      };
      // Keep resource extraction serialized. Image detection crosses the
      // PDF.js/native boundary and concurrent scans create avoidable CPU,
      // memory pressure, and contention with the visible reader.
      await worker();
      if (!controller.signal.aborted && resourcesScanRef.current === scanId) {
        cancelProgressFrame();
        if (Object.keys(scannedPageSizes).length > 0) {
          setPageSizes((previous) => ({ ...previous, ...scannedPageSizes }));
        }
        setResourceScan({ status:"ready", completed: totalPages, total: totalPages, failedPages });
      }
      cancelProgressFrame();
    })();
    return () => {
      controller.abort();
      // The scan can be cancelled while a coalesced progress frame is queued.
      // Cancel it so a stale progress update cannot repaint a new document.
      cancelProgressFrame();
      if (resourceScanAbortRef.current === controller) resourceScanAbortRef.current = null;
      setResourceScan((previous) => (previous.status ==="scanning" ? { ...previous, status:"cancelled" } : previous));
    };
  }, [
    detectPageImages,
    documentId,
    fileId,
    isNotesOpen,
    loadPageReadingBlocks,
    pdfDoc,
    resourceScanAttempt,
    sidePanelView,
    totalPages,
  ]);

  const documentLinks = useMemo(
    () =>
      Object.values(linksByPage)
        .flat()
        .filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index),
    [linksByPage],
  );
  const documentImages = useMemo(() => {
    const indexedPages = new Set<number>([
      ...Object.keys(pdfImagesByPage).map(Number),
      ...Array.from(readingBlocksByPageRef.current.keys()),
    ]);
    return Array.from(indexedPages)
      .filter((pageNo) => pageNo >= 1 && pageNo <= totalPages)
      .sort((left, right) => left - right)
      .flatMap((pageNo) => getVisibleImagesForPage(pageNo).map(({ img: image }) => ({ page: pageNo, image })));
  }, [getVisibleImagesForPage, pdfImagesByPage, readingBlocksVersion, totalPages]);
  const documentDois = useMemo<DocumentDoiResource[]>(() => {
    const source = [
      ...Array.from(readingBlocksByPageRef.current.values())
        .flat()
        .map((block) => block.text),
      ...Object.values(resourceTextByPage),
    ].join("\n");
    return Array.from(new Set(source.match(/\b10\.\d{4,9}\/[\-._;()/:A-Z0-9]+/gi) || []))
      .map((doi) => doi.replace(/[.,;:)]+$/,""))
      .filter(Boolean)
      .map((doi) => ({ doi, documentId, resourceId:`${documentId || fileId}:doi:${doi}` }));
  }, [documentId, fileId, readingBlocksVersion, resourceTextByPage]);

  const renderAnnotationCard = (annotation: ReaderAnnotation) => (
    <div
      key={annotation.id}
      className={`group relative rounded-2xl border p-4 ${
        selectedAnnotationId === annotation.id
          ?"border-content-primary bg-surface-hover/50"
          :"border-border-subtle bg-surface-app"
      }`}
      onClick={() => {
        setSelectedAnnotationId(annotation.id);
        goToSource(annotation.page, annotation.rect);
      }}
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide text-content-muted">
          <span className="px-2 py-0.5 rounded-full" style={getAnnotationBadgeStyle(annotation.kind)}>
            {annotationLabels[annotation.kind]}
          </span>
          {t.page} {annotation.page}
        </div>
        {onRemoveAnnotation ? (
          <button
            className="p-1.5 rounded-md text-content-muted hover:text-state-danger hover:bg-surface-hover transition-colors opacity-0 group-hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onRemoveAnnotation(annotation.id);
            }}
            title={t.deleteAnnotation}
          >
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
      <div className="text-xs text-content-muted mb-2">
        x {Math.round(annotation.rect.x * 100)}% | y {Math.round(annotation.rect.y * 100)}% | w{""}
        {Math.round(annotation.rect.width * 100)}% | h {Math.round(annotation.rect.height * 100)}%
      </div>
      <p className="text-sm leading-6 text-content-secondary whitespace-pre-wrap">
        {annotation.content || t.areaAnnotationSaved}
      </p>
      <div className="text-[11px] text-content-muted mt-3">{new Date(annotation.createdAt).toLocaleString()}</div>
    </div>
  );
  return (
    <div className="relative flex h-full bg-surface-app text-content-primary font-sans overflow-hidden">
      {actionHint ? (
        <div
          className="absolute top-4 right-4 z-50 px-3 py-1.5 rounded-md text-xs shadow-lg"
          style={{ backgroundColor:"var(--reader-accent)", color:"var(--reader-accent-contrast)" }}
        >
          {actionHint}
        </div>
      ) : null}
      <ReadingAssistMenu
        selection={assistSelection}
        language={language}
        modelConfig={aiModelConfig}
        onClose={() => {
          // 伴读已迁往页侧批注卡（2026-10-09），这个菜单只剩划词/翻译流 ——
          // 但预热中的伴读请求仍要收掉，与旧行为一致。
          companionAbortRef.current?.abort();
          setAssistSelection(null);
          assistAnchorRef.current = null;
        }}
        onHint={showActionHint}
        onTranslate={openTranslationPreview}
        quickAskEnabled={companionQuickAsk}
        onSaveQuote={(selection, quote) =>
          onAddNote?.(page, quote,"highlight", selection.reference, {
            documentId,
            blockId: selection.blockId,
            sourceRect: selection.sourceRect,
          })
        }
        onAnswer={({ question, answer }) => {
          // 解释按钮只是预填了固定 prompt；按 prompt 内容区分「解释」与「问问 AI」。
          const explainPrompts = ["解释这段中的关键术语、缩写和方法名。", "Explain the key terms, abbreviations, and method names in this excerpt."];
          recordAssistHistory({
            kind: explainPrompts.includes(question) ?"explain" :"ask",
            reference: `${title} / ${assistSelection?.reference ?? `page ${page}`}`,
            page: assistSelection?.page ?? page,
            excerpt: (assistSelection?.text ?? "").slice(0, 2000),
            question,
            result: answer,
            model: aiModelConfig.model,
          });
        }}
        variant={isTranslationReader ?"inline-toolbar" :"panel"}
      />

      <div
        className={`${isLeftSidebarOpen ?"w-[196px]" :"w-0"} transition-[width] duration-slow ease-out bg-surface-panel border-r border-border-subtle hidden md:flex md:flex-col shrink-0 overflow-hidden`}
      >
        <div className="w-[196px] flex border-b border-border-subtle items-center px-2 py-1.5">
          <button
            onClick={() => setSidebarTab("outline")}
            className={`flex-1 rounded-md px-2 py-2 text-sm font-semibold leading-none flex items-center justify-center gap-1.5 transition-colors ${sidebarTab ==="outline" ?"text-content-primary bg-surface-hover" :"text-content-muted hover:text-content-secondary hover:bg-surface-hover/50"}`}
          >
            <List size={15} /> {t.outline}
          </button>
          <button
            onClick={() => setSidebarTab("thumbs")}
            className={`flex-1 rounded-md px-2 py-2 text-sm font-semibold leading-none flex items-center justify-center gap-1.5 transition-colors ${sidebarTab ==="thumbs" ?"text-content-primary bg-surface-hover" :"text-content-muted hover:text-content-secondary hover:bg-surface-hover/50"}`}
          >
            <ImageIcon size={15} /> {t.thumbs}
          </button>
        </div>

        <div
          ref={thumbListRef}
          className="flex-1 overflow-y-auto p-3 space-y-2 text-sm text-content-secondary bg-surface-app/60"
        >
          {sidebarTab ==="outline" ? (
            outlineEntries.length > 0 ? (
              outlineEntries.map((item, index) => (
                <button
                  key={`${item.title}-${index}`}
                  className="w-full text-left rounded-md px-2.5 py-2 leading-5 hover:bg-surface-hover/50 cursor-pointer disabled:cursor-default disabled:opacity-60"
                  disabled={item.page === null && !item.url}
                  onClick={() => {
                    if (item.page !== null) {
                      goToPage(item.page,"auto");
                    } else if (item.url) {
                      onOpenExternal?.(item.url);
                    }
                  }}
                >
                  <span className="block truncate">{item.title}</span>
                  {item.page !== null ? (
                    <span className="block text-[10px] text-content-muted">
                      {t.page} {item.page}
                    </span>
                  ) : null}
                </button>
              ))
            ) : (
              <div className="text-content-muted">{t.noOutline}</div>
            )
          ) : (
            pageNumbers.map((pageNo) => {
              return (
                <PageThumbnail
                  key={pageNo}
                  doc={pdfDoc}
                  fileId={fileId}
                  pageNo={pageNo}
                  active={visiblePage === pageNo}
                  onClick={handleThumbnailClick}
                  onItemRef={handleThumbnailItemRef}
                  thumbnailObserverRef={thumbnailObserverRef}
                  onRegisterThumbnailVisibility={registerThumbnailVisibility}
                  pageLabel={t.page}
                  onContextMenu={handleThumbnailContextMenu}
                />
              );
            })
          )}
        </div>
      </div>

      <div
        className={`flex-1 flex flex-col min-w-0 transition-[padding-right] duration-base ease-out ${isNotesOpen ?"lg:pr-80" :""}`}
      >
        <div className="min-h-14 bg-surface-panel border-b border-border-subtle flex flex-nowrap items-center justify-between gap-2 px-3 py-2 shrink-0 shadow-sm z-30 overflow-visible">
          <div className="flex min-w-0 items-center gap-1 overflow-hidden">
            <button
              type="button"
              className="p-1.5 text-content-muted hover:bg-surface-hover rounded-md transition-colors"
              onClick={() => {
                setIsLeftSidebarOpen((value) => !value);
              }}
              title={isLeftSidebarOpen ? t.hideLeftSidebar : t.showLeftSidebar}
            >
              {isLeftSidebarOpen ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
            </button>
            <div className="flex bg-surface-sunken p-1 rounded-md mr-2 shrink-0">
              <ToolButton
                icon={<Hand size={16} />}
                active={activeTool ==="hand"}
                onClick={() => setActiveTool("hand")}
                title={t.handTool}
              />
              <ToolButton
                icon={<MousePointer2 size={16} />}
                active={activeTool ==="select"}
                onClick={() => setActiveTool("select")}
                title={t.selectText}
              />
              <div className="w-px h-4 bg-border-default mx-1 self-center" />
              <ToolButton
                icon={<Highlighter size={16} />}
                active={activeTool ==="highlight"}
                onClick={() => setActiveTool("highlight")}
                title={t.highlight}
              />
              <ToolButton
                icon={<Underline size={16} />}
                active={activeTool ==="underline"}
                onClick={() => setActiveTool("underline")}
                title={t.underline}
              />
              <ToolButton
                icon={<Strikethrough size={16} />}
                active={activeTool ==="strike"}
                onClick={() => setActiveTool("strike")}
                title={t.strikethrough}
              />
              <div className="w-px h-4 bg-border-default mx-1 self-center" />
              <ToolButton
                icon={<Type size={16} />}
                active={activeTool ==="text"}
                onClick={() => setActiveTool("text")}
                title={t.addText}
              />
            </div>

            <button
              className="p-1.5 text-content-muted hover:bg-surface-hover rounded-md transition-colors"
              onClick={() => smoothZoomBy(-12)}
              title={t.zoomOut}
            >
              <ZoomOut size={18} />
            </button>
            <span className="text-xs font-mono w-12 text-center text-content-secondary">
              {Math.round(zoom)}%
            </span>
            <button
              className="p-1.5 text-content-muted hover:bg-surface-hover rounded-md transition-colors"
              onClick={() => smoothZoomBy(12)}
              title={t.zoomIn}
            >
              <ZoomIn size={18} />
            </button>
            <div className="w-px h-4 bg-border-default mx-1" />
            <button
              className="p-1.5 text-content-muted hover:bg-surface-hover rounded-md transition-colors"
              onClick={() => {
                captureZoomAnchor(visiblePage);
                zoomTargetRef.current = 100;
                scheduleRenderZoomCommit(100);
                animateZoomToTarget();
              }}
              title={t.resetZoom}
            >
              <Maximize size={18} />
            </button>
            <button
              type="button"
              className="p-1.5 text-content-muted hover:bg-surface-hover rounded-md transition-colors disabled:opacity-50"
              title={isSearching ? t.cancel : t.search}
              aria-label={isSearching ? t.cancel : t.search}
              onClick={() => {
                if (isSearching) {
                  searchAbortRef.current?.abort();
                } else {
                  void handleSearch();
                }
              }}
              disabled={!hasDoc}
            >
              {isSearching ? <X size={18} /> : <Search size={18} />}
            </button>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              className="p-1.5 text-content-muted hover:bg-surface-hover rounded-md transition-colors"
              onClick={() => goToPage(visiblePage - 1)}
              title={t.prevPage}
            >
              <ChevronLeft size={18} />
            </button>
            <div className="text-sm font-mono text-content-secondary flex items-center gap-1">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={visiblePage}
                // 稳定的测试钩子：深处滚动后「视口中心的页」与这里显示的值必须一致。
                // 2026-10-10 的整屏空白回归里，这个值会被算成超前几百页的错页，
                // 是「正文空白 + 缩略图列表乱跳」的共同源头（见 scheduleSync 注释）。
                data-pdf-page-indicator={visiblePage}
                onChange={(event) => {
                  if (!/^\d*$/.test(event.target.value)) return;
                  const next = Number(event.target.value);
                  if (!Number.isFinite(next)) return;
                  goToPage(next,"auto");
                }}
                className="w-14 text-center bg-surface-sunken border border-border-default rounded py-0.5 focus:outline-none focus:ring-1 focus:ring-content-primary text-content-primary"
              />
              <span className="text-content-muted">/ {totalPages}</span>
            </div>
            <button
              className="p-1.5 text-content-muted hover:bg-surface-hover rounded-md transition-colors"
              onClick={() => goToPage(visiblePage + 1)}
              title={t.nextPage}
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <div className="toolbar-lang">
              <button
                className="toolbar-responsive-action toolbar-responsive-action-primary"
                style={{ backgroundColor:"var(--reader-accent)", color:"var(--reader-accent-contrast)" }}
                onClick={() => {
                  setIsImageExportOpen((value) => {
                    if (!value) {
                      void Promise.all([detectPageImages(page), loadPageReadingBlocks(page)]).catch(() => undefined);
                    }
                    return !value;
                  });
                }}
                disabled={!hasDoc}
                title={t.exportImages}
                aria-label={t.exportImages}
              >
                <ImageIcon size={18} />
              </button>
              {isImageExportOpen ? (
                <div className="absolute right-0 top-full z-[120] mt-2 w-72 rounded-lg border border-border-subtle bg-surface-panel p-2 shadow-xl">
                  <div className="mb-2 flex items-center justify-between gap-2 px-1">
                    <div className="text-xs font-semibold uppercase tracking-wide text-content-muted">
                      {t.exportImagesTitle}
                    </div>
                    <button
                      type="button"
                      className="text-xs text-content-muted hover:text-content-primary"
                      onClick={() => setIsImageExportOpen(false)}
                    >
                      {t.cancel}
                    </button>
                  </div>
                  <div className="max-h-80 space-y-1 overflow-y-auto">
                    {getVisibleImagesForPage(page).length > 0 ? (
                      getVisibleImagesForPage(page).map(({ img, rect }, idx) => (
                        <div
                          key={`export-image-${page}-${idx}`}
                          className="rounded-md border border-border-subtle p-2"
                        >
                          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-content-muted">
                            <span className="font-mono">image-{idx + 1}</span>
                            <span className="font-mono">
                              {Math.round(rect.width)}x{Math.round(rect.height)} · {img.extension ||"unknown"}
                            </span>
                          </div>
                          <div className="flex gap-2">
                            {img.source ==="xref" ? (
                              <button
                                type="button"
                                className="flex-1 rounded-md px-2 py-1.5 text-xs font-semibold"
                                style={{
                                  backgroundColor:"var(--reader-accent)",
                                  color:"var(--reader-accent-contrast)",
                                }}
                                onClick={() => {
                                  setIsImageExportOpen(false);
                                  void exportPng({
                                    pageNo: page,
                                    imageTarget: { pageNo: page, image: img, rect },
                                    mode:"original",
                                  });
                                }}
                              >
                                {t.exportImagePng}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="flex-1 rounded-md border border-border-subtle px-2 py-1.5 text-xs font-semibold text-content-secondary hover:bg-surface-hover"
                              onClick={() => {
                                setIsImageExportOpen(false);
                                void exportPng({
                                  pageNo: page,
                                  imageTarget: { pageNo: page, image: img, rect },
                                  mode:"crop",
                                });
                              }}
                            >
                              {t.exportImageCropPng}
                            </button>
                            {img.source ==="vector" ? (
                              <button
                                type="button"
                                className="flex-1 rounded-md border border-border-subtle px-2 py-1.5 text-xs font-semibold text-content-secondary hover:bg-surface-hover"
                                onClick={() => {
                                  setIsImageExportOpen(false);
                                  void exportSvg({ pageNo: page, imageTarget: { pageNo: page, image: img, rect } });
                                }}
                              >
                                {t.exportImageSvg}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-md border border-dashed border-border-subtle px-3 py-6 text-center text-xs text-content-muted">
                        {t.noPdfImages}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="inline-flex items-center gap-0.5 rounded-lg bg-surface-sunken p-1">
              <button
                type="button"
                className={`toolbar-responsive-action ${
                  readerMode ==="reader"
                    ?"bg-content-primary text-content-inverse shadow-sm"
                    :"text-content-secondary hover:bg-surface-panel hover:text-content-primary"
                }`}
                onClick={() => {
                  cancelZoomAnimationForViewChange();
                  setReaderMode("reader");
                  setActiveTool("select");
                }}
                title={t.readerView}
                aria-label={t.readerView}
              >
                <BookOpen size={18} />
              </button>
              <button
                type="button"
                className={`toolbar-responsive-action ${
                  readerMode ==="translation"
                    ?"bg-content-primary text-content-inverse shadow-sm"
                    :"text-content-secondary hover:bg-surface-panel hover:text-content-primary"
                }`}
                onClick={() => {
                  cancelZoomAnimationForViewChange();
                  setReaderMode("translation");
                  setActiveTool("select");
                  setIsNotesOpen(true);
                  setSidePanelView("translation");
                }}
                title={t.translationView}
                aria-label={t.translationView}
              >
                <Languages size={18} />
              </button>
              <button
                type="button"
                className={`toolbar-responsive-action ${
                  readerMode ==="image-label"
                    ?"bg-content-primary text-content-inverse shadow-sm"
                    :"text-content-secondary hover:bg-surface-panel hover:text-content-primary"
                }`}
                onClick={() => {
                  cancelZoomAnimationForViewChange();
                  setReaderMode("image-label");
                  setActiveTool("hand");
                  prefetchImageLabelsAround(pageRef.current);
                }}
                title={t.imageLabelView}
                aria-label={t.imageLabelView}
              >
                <ImageIcon size={18} />
              </button>
            </div>
            {/*
             * 「伴读」按钮：手动唤出气泡。
             *
             * 为什么必须有它：自动提示受「每页最多一条」约束（防打扰），而且气泡
             * 会被任何一次外部点击关掉 —— 关掉之后那一页**再也不会自动弹**。
             * 于是读者一旦错过，就没有任何办法把它叫回来，只能靠翻页碰运气。
             * 手动唤出不受每页配额限制：读者点按钮是显式请求，不是打扰。
             */}
            <button
              type="button"
              className={`toolbar-responsive-action ${
                activeMarginCardId !== null
                  ?"bg-content-primary text-content-inverse shadow-sm"
                  :"text-content-secondary hover:bg-surface-panel hover:text-content-primary"
              }`}
              onClick={() => {
                const focus = sampleCompanionFocus({
                  scrollRef,
                  pageRefs,
                  blocksByPageRef: readingBlocksByPageRef,
                });
                const block = focus?.block ?? firstCompanionBlockOnPage(pageRef.current);
                if (!block) {
                  showActionHint(t.companionNoBlock);
                  return;
                }
                openCompanionForBlock(block);
              }}
              disabled={!hasDoc}
              title={t.companionToolbar}
              aria-label={t.companionToolbar}
            >
              <Sparkles size={18} />
            </button>
            <button
              className={`p-1.5 rounded-md transition-colors ${isNotesOpen ?"text-content-secondary hover:bg-surface-hover" :"text-content-muted hover:bg-surface-hover"}`}
              onClick={() => {
                setIsNotesOpen((value) => !value);
              }}
              title={t.toggleNotes}
            >
              {isNotesOpen ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
            </button>
          </div>
        </div>
        <div
          ref={scrollRef}
          className={`pdf-selection-scope flex-1 overflow-auto bg-surface-sunken/50 relative z-0 ${isGestureRightDown ?"cursor-grabbing" :""}`}
        >
          {isImageLabelReader && imageLabelStatus.kind !=="idle" ? (
            <div
              className={`pointer-events-none absolute right-4 top-4 z-20 max-w-sm rounded-md border px-3 py-1.5 text-xs shadow-sm ${
                imageLabelStatus.kind ==="error"
                  ?"border-state-danger-border bg-state-danger-tint text-state-danger"
                  :"border-border-subtle bg-surface-panel/95 text-content-secondary"
              }`}
            >
              {imageLabelStatus.message}
            </div>
          ) : null}
          {!fileId ? (
            <div className="w-full h-full flex items-center justify-center text-center p-8">
              <div className="space-y-4">
                <h2 className="font-serif text-2xl text-content-primary">{t.noPdfOpened}</h2>
                <p className="text-content-muted">{t.noPdfHint}</p>
                <button
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-content-primary text-content-inverse"
                  onClick={onOpenFileDialog}
                >
                  <FolderOpen size={16} />
                  {t.openPdf}
                </button>
              </div>
            </div>
          ) : (
            <div className="min-h-full w-max min-w-full px-4 py-8 md:px-8">
              <div ref={pageFlowRef} className="mx-auto flex w-fit flex-col items-center gap-0">
                {pageNumbers.map((pageNo) => {
                  const size = pageSizes[pageNo] || DEFAULT_PAGE_SIZE;
                  const width = Math.max(1, Math.round(size.width * renderZoomScale));
                  const height = Math.max(1, Math.round(size.height * renderZoomScale));
                  const active =
                    lockedZoomPage === null
                      ? activePages.has(pageNo)
                      : Math.abs(pageNo - lockedZoomPage) <= PAGE_RENDER_OVERSCAN_WHILE_ZOOMING;
                  const pageAnnotationItems = active ? annotationsByPage.get(pageNo) || [] : [];
                  const pageDraftRect = active && draftAnnotation?.page === pageNo ? draftRect : null;
                  const pageSize = pageSizes[pageNo] || DEFAULT_PAGE_SIZE;
                  // Keep image hit targets available in every PDF view. They are
                  // visually transparent outside image-label mode, so text
                  // selection remains native while image context actions work.
                  const visiblePageImages = active ? getVisibleImagesForPage(pageNo) : [];
                  const structuredPageBlocks = active ? readingBlocksByPageRef.current.get(pageNo) || [] : [];
                  // AI 波浪线由 PageCanvas 画在 text layer 内部（跟着每个片段的基线），
                  // 这里只把清单交给它，不在标注层再画一遍 div 覆盖层 ——
                  // 两处同时画会出现「一条波浪线两个位置」的鬼影。
                  //
                  // ⚠️ 走visibleCompanionMarkersOnPage 而不是裸 filter：
                  // canAddCompanionMarker 只在**新增那一刻**数预算，而标注跨会话累积，
                  // 于是旧数据能攒到满页（2026-10-08 实测）。截断在渲染层补这一刀。
                  //
                  // 传的是 `companionMarkerIntensity`（留痕档位）本身，不是
                  // `companionAutoAnnotate ? … : "off"`：总开关管「要不要再新增」，
                  // 档位管「留多少」，关掉总开关不该顺手清空读者已经看到的线。
                  const derivedWavyAnnotations = active
                    ? visibleCompanionMarkersOnPage(pageAnnotationItems, {
                        page: pageNo,
                        intensity: companionMarkerIntensity,
                        // 行级 bbox 住在块上，所以由这里接进来 ——
                        // 纯函数不该反过来依赖块的仓库（见参数注释）。
                        // 没有它就会退回单行，句子被腰斩（2026-10-08 反馈）。
                        linesForBlock: (blockId) =>
                          (readingBlocksByPageRef.current.get(pageNo) || []).find(
                            (item) => item.id === blockId
                          )?.lines,
                        // 存量非正文标注的渲染侧兜底：isNonProseRegion 只在**新增**时
                        // 生效，规则上线前留在页眉/页脚/页码上的波浪线会一直画着
                        // （2026-10-08 实测「页眉还有波浪线」）。与预算截断同理：
                        // 写入侧把关，渲染侧也要兜存量。查不到块时不拦 ——
                        // 判据缺失不等于该拦，误杀正文标注更难解释。
                        isNonProseBlock: (blockId) => {
                          const block = (readingBlocksByPageRef.current.get(pageNo) || []).find(
                            (item) => item.id === blockId
                          );
                          return block ? isNonProseRegion(block) : false;
                        },
                      })
                    : EMPTY_ANNOTATIONS;
                  // ⚠️ 空结果必须换回**共享常量**，不能留着上面那两种分支各自产出的新数组 ——
                  // 见 EMPTY_ANNOTATIONS 的注释：数组身份变化会让每个活跃页的波浪线 effect
                  // 在父组件每次渲染时重跑一遍，而它要逐 span 量 rect（WebKit 上这一步就是全部顿挫）。
                  const pageWavyAnnotations =
                    derivedWavyAnnotations.length === 0 ? EMPTY_ANNOTATIONS : derivedWavyAnnotations;
                  // 伴读锚点：只挂在 AI 留的波浪线旁。
                  //
                  // ⚠️ 输入用 `pageWavyAnnotations`（已按预算截断），不是 `pageAnnotationItems` ——
                  // 否则会出现「锚点悬在一段没有波浪线的文字旁边」，点开还是别处的解释。
                  //
                  // 位置优先取 marker 里**实际命中的文字片段**的包围盒，而不是标注 rect：
                  // rect 若是整块并集框，其右上角落进版心空白，锚点挂上去会飘到段落外侧
                  // （表现为「点星星弹出的是别处的解释」）。拿不到 marker 时才退回 rect。
                  const pageMarker = markersByPage.get(pageNo) ?? null;
                  const companionAnchorItems = active
                    ? companionAnchorsOnPage(pageWavyAnnotations, pageNo)
                        .map((annotation) => {
                          const pageElement = pageRefs.current.get(pageNo);
                          const pageRect = pageElement?.getBoundingClientRect();
                          const hitRect = pageMarker && pageRect
                            ? clientRectFromRanges(
                                pageMarker,
                                rangesFromNormalizedRect(pageMarker, annotation.rect, pageRect),
                              )
                            : null;
                          // hitRect 是屏幕坐标，要换算回页面元素的归一化坐标，
                          // 因为锚点按钮是按百分比定位在页面元素内的。
                          const position = hitRect && pageRect
                            ? { x: (hitRect.right - pageRect.left) / pageRect.width, y: (hitRect.top - pageRect.top) / pageRect.height }
                            : annotation.rect
                              ? companionAnchorPosition({ rect: annotation.rect, pageSize })
                              : null;
                          return position ? { annotation, position } : null;
                        })
                        .filter((item): item is { annotation: (typeof pageAnnotationItems)[number]; position: { x: number; y: number } } => item !== null)
                    : [];

                  // 批注栏宽度 =（pane 宽 − 页宽）/ 2 的钳制值；栏不够宽时卡片
                  // 向页边内溢（right:0 / left:0 + 固定宽，溢出部分盖在页边）。
                  const gutterWidth = Math.max(0, Math.min(320, (paneWidth - width) / 2 - 24));
                  // 摆放是纯函数：输入锚点 top（归一化 rect × 渲染高度），输出每张卡的侧别与 top。
                  const marginCardPlacements = active
                    ? placeCompanionMarginCards(
                        pageWavyAnnotations.map((annotation) => ({
                          id: annotation.id,
                          top: (annotation.rect?.y ?? 0) * height,
                        })),
                        height,
                      )
                    : [];
                  const marginCardById = new Map(pageWavyAnnotations.map((annotation) => [annotation.id, annotation]));
                  const renderMarginCard = (placement: (typeof marginCardPlacements)[number]) => {
                    const annotation = marginCardById.get(placement.id);
                    if (!annotation) return null;
                    const block = annotation.blockId
                      ? structuredPageBlocks.find((item) => item.id === annotation.blockId)
                      : undefined;
                    return (
                      <CompanionMarginCard
                        key={annotation.id}
                        annotation={annotation}
                        blockText={block?.text ?? annotation.content ?? ""}
                        active={activeMarginCardId === annotation.id}
                        modelConfig={aiModelConfig}
                        language={language}
                        style={{
                          top: placement.top,
                          width: MARGIN_CARD_WIDTH,
                          ...(placement.side === "right" ? { right: 0 } : { left: 0 }),
                          /**
                           * 抵消缩放预览时的变形原点，必须与卡片「贴页」的那条边对齐
                           * （右侧卡贴页左缘 → `top right`，左侧卡贴栏左缘 → `top left`）。
                           *
                           * 为什么：卡片靠 `right:0 / left:0` 贴在批注栏边缘，
                           * 而那正是不该移动的那条边。若从另一侧缩放，卡片会从贴边处
                           * 整体滑开一个 `(1 − 1/v) × 卡片宽` 的距离 —— 缩放越大偏得越多，
                           * 松手提交后又弹回，比不抵消更难看出原因。
                           * 变形本身由 CSS 的 `.pdf-flow-ui-chrome` 负责（见 PDFViewer.css）。
                           */
                          transformOrigin: placement.side === "right" ? "top right" : "top left",
                        }}
                        onDismissCompanion={handleMarginCardDismiss}
                        onAnswer={handleMarginCardAnswer}
                      />
                    );
                  };
                  return (
                    <div key={pageNo} className="flex items-start justify-center">
                      {/* 左批注栏：宽度恒与右栏相等，页面保持居中；右侧放不下的卡落这里。 */}
                      <div className="relative shrink-0" style={{ width: gutterWidth, height }}>
                        {marginCardPlacements
                          .filter((placement) => placement.side === "left")
                          .map((placement) => renderMarginCard(placement))}
                      </div>
                    <div
                      ref={(node) => {
                        if (node) pageRefs.current.set(pageNo, node);
                        else pageRefs.current.delete(pageNo);
                      }}
                      data-pdf-page={pageNo}
                      // ⚠️ 这里【不能】挂 dark:invert —— 深色反色已下沉到
                      // PDFViewer.css 的 .pdf-page-canvas。挂在本层会把文本层、
                      // 标注层、锚点一起反色（深色下波浪线会消失）。
                      className={`pdf-page-block relative overflow-hidden bg-surface-paper-veil border origin-top ${isGestureRightDown ?"cursor-grabbing" : activeTool ==="select" || isLineAnnotationTool(activeTool) ?"cursor-text" : isAnnotationTool(activeTool) ?"cursor-crosshair" :"cursor-default"} ${visiblePage === pageNo ?"pdf-page-block--focused" :"border-transparent"}`}
                      style={{
                        width,
                        height,
                        contentVisibility: active ?"visible" :"auto",
                        containIntrinsicSize:`${height}px ${width}px`,
                        visibility:
                          isGestureRightDown && lockedZoomPage !== null && pageNo !== lockedZoomPage
                            ?"hidden"
                            : undefined,
                      }}
                      onPointerDown={(event) => handleViewerPointerDown(pageNo, event)}
                      onPointerMove={handleViewerPointerMove}
                      onPointerUp={(event) => handleViewerPointerUp(pageNo, event)}
                      onPointerCancel={(event) => handleViewerPointerCancel(pageNo, event)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (suppressNextContextMenuRef.current) {
                          return;
                        }
                        setPage(clampPage(pageNo, totalPages));
                        contextPointRef.current = { pageNo, x: event.clientX, y: event.clientY };
                        const imageTarget = imageTargetAtPointRef.current(pageNo, event.clientX, event.clientY);
                        setSelectedImageKey(imageTargetKey(imageTarget));
                        setContextMenu({
                          x: event.clientX,
                          y: event.clientY,
                          isOpen: true,
                          pageNo: clampPage(pageNo, totalPages),
                          imageTarget,
                        });
                        void (async () => {
                          try {
                            await detectPageImagesRef.current(pageNo);
                            await loadPageReadingBlocksRef.current(pageNo).catch(() => []);
                            const target = imageTargetAtPointRef.current(pageNo, event.clientX, event.clientY);
                            setContextMenu((current) => {
                              const point = contextPointRef.current;
                              if (
                                !current.isOpen ||
                                current.pageNo !== pageNo ||
                                !point ||
                                point.x !== event.clientX ||
                                point.y !== event.clientY
                              ) {
                                return current;
                              }
                              setSelectedImageKey(imageTargetKey(target));
                              return { ...current, imageTarget: target };
                            });
                          } catch {
                            // Keep page export actions available if indexing fails.
                          }
                        })();
                      }}
                    >
                      {active ? (
                        <>
                          <PageCanvas
                            doc={pdfDoc}
                            pageNo={pageNo}
                            renderZoomScale={renderZoomScale}
                            active={active}
                            enableTextLayer={textSelectionEnabled}
                            enableAssistBlocks={isTranslationReader}
                            linksEnabled={!isTranslationReader}
                            onSize={updatePageSize}
                            onError={setRenderError}
                            renderingLabel={t.rendering}
                            onOpenExternal={onOpenExternal}
                            onOpenLinkInApp={onOpenLinkInApp}
                            // PDF 内部链接（章节/参考文献跳转）的落点。PageCanvas 内部用 ref
                            // 持有这个回调、不把它写进渲染 effect 的依赖，所以这里传内联箭头
                            // 函数是安全的（不会引发每渲染重绘）。
                            onNavigateToPage={(target) => goToPage(target,"smooth", { source:"control" })}
                            onAssistSelection={isTranslationReader ? handleAssistSelection : undefined}
                            onReadingBlocks={updateReadingBlocks}
                            structuredBlocks={structuredPageBlocks}
                            structuredBlocksVersion={readingBlocksVersion}
                            onPageLinks={updatePageLinks}
                            onPageRendered={handlePageRendered}
                            onFirstPagePainted={handleFirstPagePainted}
                            onTextLayerMarker={handleTextLayerMarker}
                            wavyAnnotations={pageWavyAnnotations}
                            wavyAnnotationsVersion={annotationsVersion}
                          />
                          <div
                            className="absolute inset-0"
                            style={{
                              // ⚠️ z-index 必须**高于 .page-text-overlay 的 9**
                              // （PDFViewer.css:77），否则这一整层压在文本层下面。
                              //
                              // 2026-10-08 实测「只看到波浪线，看不到其他类型的划线」，
                              // 成因就是这里：这一层没写 z-index（= auto = 0 级），
                              // 而文本层是 9，于是 highlight/underline/strike/text
                              // 全都画在了文字的**下面** —— 被纸面文字完全遮住。
                              // AI 波浪线不受影响，因为它由 PageCanvas 画在
                              // 文本层**内部**（text-decoration），天然在上。
                              //
                              // 取 10 而不是 11：`.page-link-overlay` 也是 10，
                              // 同级时**后出现的元素在上面**，内部链接的命中框
                              // 就在这一层之下 —— 取 11 会把链接盖住，点不动。
                              zIndex: 10,
                              pointerEvents:
                                textSelectionEnabled && !isGestureRightDown
                                  ?"none"
                                  :"auto",
                            }}
                          >
                            {/*
                              AI 波浪线**不在这一层画**。
                              它由 PageCanvas 画在 text layer 内部（text-decoration: wavy，
                              跟着每个文字片段自己的基线走）。这里若再画一次矩形覆盖层，
                              就会出现「一条波浪线两个位置」的鬼影 —— 而且覆盖层画的是
                              段落并集框，线会贴在整段底部，正是要修的那个 bug。

                              data-* 属性仍然保留：E2E 与现场排查靠它们区分
                              「AI 自动留的」和「我自己画的」（只有 origin 能区分）。
                            */}
                            {pageAnnotationItems
                              .filter((annotation) => !(annotation.kind === "wavy" && annotation.origin === "ai"))
                              .map((annotation) => (
                              <button
                                key={annotation.id}
                                type="button"
                                data-annotation-id={annotation.id}
                                data-annotation-kind={annotation.kind}
                                data-annotation-origin={annotation.origin ?? "manual"}
                                className={`absolute rounded-sm transition-all ${annotation.kind ==="text" ?"px-2 py-1 text-left overflow-hidden" :""}`}
                                style={getAnnotationOverlayStyle(annotation, selectedAnnotationId === annotation.id)}
                                title={annotation.content || annotationLabels[annotation.kind]}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedAnnotationId(annotation.id);
                                  setPage(pageNo);
                                  setIsNotesOpen(true);
                                }}
                              >
                                {annotation.kind ==="text" ? (
                                  <span className="block text-[11px] leading-4 whitespace-pre-wrap">
                                    {annotation.content}
                                  </span>
                                ) : null}
                              </button>
                            ))}
                            {pageDraftRect && draftAnnotation ? (
                              <div
                                className="absolute pointer-events-none rounded-sm"
                                style={getDraftOverlayStyle(draftAnnotation.kind, pageDraftRect)}
                              />
                            ) : null}
                          </div>
                          {/* 伴读锚点 —— 态 A 的入口，也是波浪线的唯一消歧手段。
                              刻意放在标注层「外面」：标注层为了不挡划词整块设了
                              pointer-events，靠它自己接不到点击。 */}
                          {companionAnchorItems.map(({ annotation, position }) => {
                            const block = annotation.blockId
                              ? (readingBlocksByPageRef.current.get(pageNo) || []).find(
                                  (item) => item.id === annotation.blockId
                                )
                              : undefined;
                            const isSeed =
                              companionSeedBlockId === (annotation.blockId || annotation.id);
                            // 气泡正在这块上开着时锚点必须保持可见 —— 移开鼠标就把入口
                            // 藏起来，等于让读者「关掉了一个找不到的菜单」。
                            const anchorKey = annotation.blockId || annotation.id;
                            const bubbleOpenOnThis = activeMarginCardId === annotation.id;
                            return (
                              <button
                                key={`companion-anchor-${annotation.id}`}
                                type="button"
                                data-companion-anchor="true"
                                data-anchor-block-id={anchorKey}
                                aria-label={
                                  isSeed
                                    ? t.companionOpen
                                    : annotation.content || t.companionOpen
                                }
                                title={annotation.content || t.companionOpen}
                                className="group absolute grid place-items-center rounded-full"
                                style={{
                                  // 命中区靠**透明 padding**外扩，不靠 transform: scale。
                                  //
                                  // ⚠️ 旧实现用 `transform: scale(34/18)` 想放大点击范围，
                                  // 结果把视觉圆点一起放大了 —— 而且 scale 会让命中区
                                  // 跟着偏移，边缘反而点不准。padding 只增不减布局盒，
                                  // 视觉子元素尺寸不变，两件事彻底分开。
                                  //
                                  // ⚠️ 定位必须用**百分比**而不是 px。
                                  // 页面元素是按 `pageSize × renderZoomScale` 渲染的，
                                  // 而 position 是相对页面的归一化坐标。旧实现拿未缩放的
                                  // `pageSize.width` 去算 px 落在已缩放的容器里 ——
                                  // 150% 缩放下锚点会整体偏移到段落左侧（2026-10-08 实测）。
                                  // 百分比与缩放无关，是这里唯一正确的坐标系。
                                  left: `calc(${position.x * 100}% - ${COMPANION_ANCHOR_SIZE / 2}px)`,
                                  top: `calc(${position.y * 100}% - ${COMPANION_ANCHOR_SIZE / 2}px)`,
                                  width: `${COMPANION_ANCHOR_SIZE}px`,
                                  height: `${COMPANION_ANCHOR_SIZE}px`,
                                  padding: `${COMPANION_ANCHOR_HIT_SLOP}px`,
                                  margin: `${-COMPANION_ANCHOR_HIT_SLOP}px`,
                                  background: "transparent",
                                  border: "none",
                                  cursor: "pointer",
                                  // 必须高于 .page-text-overlay 的 9，否则点击落到文本层，
                                  // 被段落命中逻辑吃掉 —— 表现为「锚点看得见、点不动」。
                                  zIndex: COMPANION_ANCHOR_Z_INDEX,
                                  // ⚠️ 这里有一个绕不开的取舍，记录下来免得后人重蹈：
                                  //
                                  // 「命中区常开」曾经是为了让 hover 淡入能触发：若用
                                  // `pointer-events: none` 关掉命中区，元素接不到
                                  // pointerenter，淡入永远不触发，锚点再也不会出现。
                                  // 代价是读者在锚点那一小片区域（约 34px 见方）点选文字时
                                  // 会点到锚点而不是选字。
                                  //
                                  // 锚点改成**常显**（见下方 span 的注释）之后，这个取舍
                                  // 的性质变了：命中区不再只服务于 hover，而是「读者看得见
                                  // 那个点就去点它」的直接入口 —— 常开的命中区现在是对的，
                                  // 不再是妥协。34px 命中区会吃掉一小块划词起点，
                                  // 属于已知的可接受代价（锚点紧贴行末，选字多从行中段起拖）。
                                }}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (!block) return;
                                  openCompanionForBlock(block);
                                }}
                              >
                                {/*
                                  视觉子元素：9px accent 实心点 + 纸色描边环。
                                  描边环是必须的 —— 深色模式下纸面被反相成深底，
                                  不加环这个点会直接沉进背景里看不见；
                                  而加了环之后它在白纸与深纸上都能读出来。
                                  种子（本次停留触发的那条）额外加一圈光晕，
                                  让「刚出现的那个」在多条里一眼可辨。

                                  ## 常显，不是 hover 才出现（2026-10-08 二次反馈）

                                  上一版按「hover 到黑点上显示伴读 bar」把视觉点改成
                                  `opacity-0` + `group-hover:opacity-100`，结果用户反馈
                                  **「找不到锚点了，看不到」**。这条反馈比上一条需求更权威 ——
                                  它说明 hover 显隐这条路在真实纸面上根本走不通：

                                  1. **没有可悬停的目标。** 锚点常态不可见，读者要悬停它
                                     才能知道它在那儿，而「找到那个看不见的东西」正是
                                     hover 显隐要解决的问题本身。这是循环依赖。
                                  2. **命中区只有 34px 见方。** 即使勉强扫到，34px 里
                                     绝大部分是透明留白，指针未必正好落在按钮上 ——
                                     上一版注释里那条「命中区不能关」的取舍在这里
                                     直接变成了「悬停命中概率不足」。
                                  3. **读者的心智是「先看到线 → 找线旁边的点」。**
                                     波浪线是常显的，锚点却是隐形的，两者节奏不一致，
                                     视觉上就成了「有一道没来由的波浪线」。

                                  所以改成**常显 + 分层强调**：静止态是低存在感的
                                  半透明小点（读得出来，但不与正文争夺注意力），
                                  hover / 气泡打开时升到不透明并加光晕。
                                  要被看见的入口不能只在悬停时存在。

                                  种子（刚触发的那个）额外加一圈光晕：它是这一轮唯一
                                  「刚出现」的点，值得比其余锚点多一层辨识度。
                                */}
                                <span
                                  aria-hidden="true"
                                  className={
                                    bubbleOpenOnThis
                                      ? "block rounded-full opacity-100 scale-110 transition-[opacity,transform] duration-base ease-out"
                                      : "block rounded-full opacity-55 scale-100 transition-[opacity,transform] duration-base ease-out hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100 group-hover:scale-125 motion-reduce:opacity-100 motion-reduce:group-hover:scale-100"
                                  }
                                  style={{
                                    width: `${COMPANION_ANCHOR_DOT_SIZE}px`,
                                    height: `${COMPANION_ANCHOR_DOT_SIZE}px`,
                                    background: "var(--reader-accent)",
                                    boxShadow: isSeed
                                      ? "0 0 0 3px color-mix(in srgb, var(--reader-accent) 26%, transparent)"
                                      : "0 0 0 2px var(--annotation-note-border)",
                                  }}
                                />
                              </button>
                            );
                          })}
                          {visiblePageImages.map(({ img, rect }, idx) => {
                            const target = { pageNo, image: img, rect };
                            const isSelected = selectedImageKey === imageTargetKey(target);
                            return (
                              <div
                                key={`img-box-${pageNo}-${idx}`}
                                className="absolute overflow-visible"
                                style={{
                                  left:`${(rect.left / pageSize.width) * 100}%`,
                                  top:`${(rect.top / pageSize.height) * 100}%`,
                                  width:`${(Math.max(1, rect.width) / pageSize.width) * 100}%`,
                                  height:`${(Math.max(1, rect.height) / pageSize.height) * 100}%`,
                                  pointerEvents: isImageLabelReader ?"auto" :"none",
                                  border:
                                    isSelected || isImageLabelReader
                                      ?"1px solid color-mix(in srgb, var(--reader-accent) 88%, transparent)"
                                      :"1px solid transparent",
                                  backgroundColor: isSelected
                                    ?"color-mix(in srgb, var(--reader-accent) 20%, transparent)"
                                    : isImageLabelReader
                                      ?"color-mix(in srgb, var(--reader-accent) 13%, transparent)"
                                      :"transparent",
                                  boxShadow: isSelected
                                    ?"0 0 0 3px color-mix(in srgb, var(--reader-accent) 24%, transparent), 0 0 18px color-mix(in srgb, var(--reader-accent) 34%, transparent)"
                                    : undefined,
                                }}
                                onPointerDown={(event) => {
                                  if (event.button === 2 || (event.buttons & 2) === 2) {
                                    event.preventDefault();
                                    event.stopPropagation();
                                  }
                                }}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setPage(clampPage(pageNo, totalPages));
                                  const imageTarget = { pageNo, image: img, rect };
                                  setSelectedImageKey(imageTargetKey(imageTarget));
                                  setContextMenu({
                                    x: event.clientX,
                                    y: event.clientY,
                                    isOpen: true,
                                    pageNo: clampPage(pageNo, totalPages),
                                    imageTarget,
                                  });
                                }}
                              >
                                {isImageLabelReader ? (
                                  <span
                                    className="absolute left-0 top-0 rounded-br-md px-1.5 py-0.5 text-[10px] font-mono"
                                    style={{
                                      backgroundColor:"var(--reader-accent)",
                                      color:"var(--reader-accent-contrast)",
                                    }}
                                  >
                                    {t.imageType}: {img.extension ||"unknown"}
                                  </span>
                                ) : null}
                              </div>
                            );
                          })}
                          {visiblePage === pageNo ? (
                            <div className="pdf-page-focus-glow pointer-events-none absolute inset-0" />
                          ) : null}
                        </>
                      ) : null}
                    </div>
                      {/* 右批注栏：默认侧。卡片 right:0 贴栏外缘，栏窄时向页边内溢。 */}
                      <div className="relative shrink-0" style={{ width: gutterWidth, height }}>
                        {marginCardPlacements
                          .filter((placement) => placement.side === "right")
                          .map((placement) => renderMarginCard(placement))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/*
           * 首屏遮罩：条件是 `loading || !firstPagePainted`，而不是原来的 `loading`。
           *
           * `loading` 只覆盖「打开文件/解析目录」那几十毫秒，canvas 渲染大页还要更久。
           * 只看 `loading` 的话，遮罩先撤、纸面后画，中间那段正好是「一片空白且无提示」。
           *
           * 用不透明的 `bg-surface-panel` 而不是 `/60` 半透明：半透明底下是白纸，
           * 而白纸上的浅色文字在浅色主题下几乎看不见 —— 有遮罩等于没遮。
           * 页面画出来的那一刻 `firstPagePainted` 变 true，遮罩整块撤掉，不留灰影。
           */}
          {loading || !firstPagePainted ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-panel text-content-muted text-sm">
              <div
                className="h-6 w-6 rounded-full border-2 border-border-subtle border-t-content-muted motion-safe:animate-spin"
                aria-hidden="true"
              />
              <span>{t.loadingPdf}</span>
            </div>
          ) : null}
          {renderError ? (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 px-3 py-1.5 rounded-md bg-state-danger-tint text-state-danger text-xs border border-state-danger-border shadow-sm">
              {renderError}
            </div>
          ) : null}
        </div>
      </div>

      <div
        className={`absolute right-0 top-0 z-40 hidden h-full w-[20rem] transform-gpu flex-col overflow-hidden border-l border-border-subtle bg-surface-panel shadow-[-18px_0_38px_rgba(15,23,42,0.08)] transition-transform duration-slow ease-out will-change-transform dark:shadow-[-18px_0_38px_rgba(0,0,0,0.32)] lg:flex ${
          isNotesOpen ?"translate-x-0" :"translate-x-full"
        }`}
        aria-hidden={!isNotesOpen}
      >
        <div className="w-[20rem] flex flex-col h-full">
          <div className="h-14 border-b border-border-subtle flex items-center justify-between px-4 shrink-0 bg-surface-app">
            <div className="flex items-center gap-2 font-semibold text-content-primary text-sm">
              {sidePanelView ==="translation" ? (
                <Languages size={16} />
              ) : sidePanelView ==="resources" ? (
                <Link2 size={16} />
              ) : sidePanelView ==="history" ? (
                <History size={16} />
              ) : (
                <MessageSquare size={16} />
              )}
              {sidePanelView ==="translation"
                ? t.translationPreview
                : sidePanelView ==="resources"
                  ? t.resources
                  : sidePanelView ==="history"
                    ? t.assistHistory
                    : t.notesAnnotations}
            </div>
            <div
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium"
              style={{ backgroundColor:"var(--reader-accent-soft)", color:"var(--reader-accent)" }}
            >
              <Sparkles size={12} /> {t.page} {page}
            </div>
          </div>

          <div className="border-b border-border-subtle bg-surface-panel px-3 py-2">
            <div className="grid grid-cols-4 gap-1 rounded-lg bg-surface-sunken p-1">
              <button
                type="button"
                className={`h-8 rounded-md text-xs font-semibold transition-colors ${sidePanelView ==="notes" ?"bg-surface-panel text-content-primary shadow-sm" :"text-content-muted hover:text-content-primary"}`}
                onClick={() => setSidePanelView("notes")}
              >
                {t.sidePanelNotes}
              </button>
              <button
                type="button"
                className={`h-8 rounded-md text-xs font-semibold transition-colors ${sidePanelView ==="translation" ?"bg-surface-panel text-content-primary shadow-sm" :"text-content-muted hover:text-content-primary"}`}
                onClick={() => setSidePanelView("translation")}
              >
                {t.sidePanelTranslation}
              </button>
              <button
                type="button"
                className={`h-8 rounded-md text-xs font-semibold transition-colors ${sidePanelView ==="resources" ?"bg-surface-panel text-content-primary shadow-sm" :"text-content-muted hover:text-content-primary"}`}
                onClick={() => setSidePanelView("resources")}
              >
                {t.sidePanelResources}
              </button>
              <button
                type="button"
                className={`h-8 rounded-md text-xs font-semibold transition-colors ${sidePanelView ==="history" ?"bg-surface-panel text-content-primary shadow-sm" :"text-content-muted hover:text-content-primary"}`}
                onClick={() => setSidePanelView("history")}
              >
                {t.sidePanelHistory}
              </button>
            </div>
          </div>

          {sidePanelView ==="history" ? (
            <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-surface-panel">
              <div>
                <div className="font-serif text-2xl font-bold text-content-primary leading-tight">
                  {t.assistHistory}
                </div>
                <p className="text-sm text-content-muted mt-2">{t.assistHistoryIntro}</p>
              </div>
              {assistHistory.length > 0 ? (
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs font-medium text-content-muted hover:text-content-primary hover:bg-surface-hover"
                    onClick={handleClearAssistHistory}
                  >
                    <Trash2 size={12} className="inline mr-1" />
                    {t.assistHistoryClear}
                  </button>
                </div>
              ) : null}
              {assistHistory.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border-default px-3 py-10 text-center text-sm text-content-muted">
                  {t.assistHistoryEmpty}
                </div>
              ) : (
                assistHistory.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-xl border border-border-subtle bg-surface-app p-3 space-y-2"
                    style={{ contentVisibility:"auto", containIntrinsicSize:"160px" }}
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px] text-content-muted">
                      <span className="rounded-full px-2 py-0.5 font-medium shrink-0" style={{ backgroundColor:"var(--reader-accent-soft)", color:"var(--reader-accent)" }}>
                        {entry.kind ==="translate"
                          ? t.historyKindTranslate
                          : entry.kind ==="explain"
                            ? t.historyKindExplain
                            : entry.kind ==="full-translation"
                              ? t.historyKindFullTranslation
                              : t.historyKindAsk}
                      </span>
                      <span className="truncate">{entry.reference}</span>
                      <span className="shrink-0">{new Date(entry.createdAt).toLocaleString()}</span>
                    </div>
                    {entry.excerpt ? (
                      <div className="rounded-lg bg-surface-sunken p-2 text-[11px] leading-5 text-content-secondary whitespace-pre-wrap">
                        {entry.excerpt}
                      </div>
                    ) : null}
                    {entry.question ? (
                      <div className="text-xs font-medium text-content-primary">Q：{entry.question}</div>
                    ) : null}
                    {entry.kind ==="translate" || entry.kind ==="full-translation" ? (
                      <div className="text-xs leading-6 text-content-primary whitespace-pre-wrap">{entry.result}</div>
                    ) : (
                      <div
                        className="text-xs leading-6 text-content-primary"
                        dangerouslySetInnerHTML={{ __html: renderAssistantMarkdown(entry.result) }}
                      />
                    )}
                  </div>
                ))
              )}
            </div>
          ) : sidePanelView ==="translation" ? (
            <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-surface-panel">
              <div>
                <div className="font-serif text-2xl font-bold text-content-primary leading-tight">
                  {t.translationPreview}
                </div>
                <p className="text-sm text-content-muted mt-2">
                  {fullTranslation.status || translationPanel?.selection.reference || t.translationEmpty}
                </p>
              </div>
              <div className="rounded-xl border border-border-subtle bg-surface-app p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-content-primary truncate">
                      {aiModelConfig.model ||"model"}
                    </div>
                    <div className="text-[11px] text-content-muted truncate">
                      {aiModelConfig.baseUrl ||"LiteLLM / OpenAI-compatible"}
                    </div>
                  </div>
                  {fullTranslation.isLoading ? (
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-xs font-medium bg-surface-hover text-content-primary"
                      onClick={() => fullTranslationAbortRef.current?.abort()}
                    >
                      {t.cancel}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-xs font-medium"
                      style={{ backgroundColor:"var(--reader-accent)", color:"var(--reader-accent-contrast)" }}
                      onClick={startFullTranslation}
                    >
                      {t.fullTranslation}
                    </button>
                  )}
                </div>
                {fullTranslation.total > 0 ? (
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
                    <div
                      className="h-full rounded-full transition-[width]"
                      style={{
                        width:`${Math.min(100, Math.round((fullTranslation.completed / Math.max(1, fullTranslation.total)) * 100))}%`,
                        backgroundColor:"var(--reader-accent)",
                      }}
                    />
                  </div>
                ) : null}
              </div>
              {translationPanel ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-border-subtle bg-surface-app p-3">
                    <div className="mb-2 text-[11px] uppercase tracking-wide text-content-muted">
                      {translationPanel.selection.sourceTitle}
                    </div>
                    <div className="max-h-48 overflow-auto text-xs leading-5 text-content-secondary">
                      {translationPanel.selection.text}
                    </div>
                  </div>
                  <div className="min-h-48 rounded-xl border border-border-subtle bg-surface-app p-4 text-sm leading-6 text-content-primary whitespace-pre-wrap">
                    {translationPanel.status || translationPanel.answer}
                  </div>
                </div>
              ) : null}
              {fullTranslation.results.length > 0 ? (
                <div className="translation-results space-y-3">
                  <div className="text-xs uppercase tracking-wide text-content-muted">
                    {language ==="zh-CN" ?"全文分块翻译" :"Full Translation Blocks"}
                  </div>
                  {fullTranslation.results.map((item) => (
                    <div
                      key={item.block.id}
                      className="translation-result-item rounded-xl border border-border-subtle bg-surface-panel p-3 space-y-2"
                      style={{ contentVisibility:"auto", containIntrinsicSize:"220px" }}
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px] text-content-muted">
                        <span>
                          {t.page} {item.block.page}
                        </span>
                        <span>{item.block.kind}</span>
                      </div>
                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                        <div className="min-w-0 rounded-lg bg-surface-sunken p-3 text-[11px] leading-5 text-content-secondary">
                          <div className="mb-1 text-[10px] uppercase tracking-wide text-content-muted">
                            {language ==="zh-CN" ?"原文" :"Source"}
                          </div>
                          {item.block.text}
                        </div>
                        <div className="min-w-0 rounded-lg border border-[var(--reader-accent)]/20 bg-[var(--reader-accent-soft)] p-3 text-sm leading-6 text-content-primary whitespace-pre-wrap">
                          <div
                            className="mb-1 text-[10px] uppercase tracking-wide"
                            style={{ color:"var(--reader-accent)" }}
                          >
                            {language ==="zh-CN" ?"译文" :"Translation"}
                          </div>
                          {item.error ? (
                            <div className="space-y-2 text-state-danger">
                              <div>{item.error}</div>
                              <button
                                type="button"
                                onClick={() => void retryFullTranslationBlock(item.block)}
                                className="rounded border border-state-danger-border px-2 py-1 text-xs"
                              >
                                {language ==="zh-CN" ?"重试此段" :"Retry block"}
                              </button>
                            </div>
                          ) : (
                            item.translation
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : !translationPanel ? (
                <div className="rounded-xl border border-dashed border-border-default px-3 py-10 text-center text-sm text-content-muted">
                  {t.translationEmpty}
                </div>
              ) : null}
            </div>
          ) : sidePanelView ==="resources" ? (
            <div className="flex-1 overflow-y-auto space-y-5 bg-surface-panel p-5">
              <div>
                <div className="font-serif text-2xl font-bold leading-tight text-content-primary">
                  {t.resources}
                </div>
                <p className="mt-2 text-sm text-content-muted">{t.resourcesIntro}</p>
                {resourceScan.status ==="scanning" ? (
                  <div className="mt-3 flex items-center gap-2 text-xs text-content-muted">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width:`${Math.round((resourceScan.completed / Math.max(1, resourceScan.total)) * 100)}%`,
                          backgroundColor:"var(--reader-accent)",
                        }}
                      />
                    </span>
                    <span className="shrink-0 font-mono">
                      {resourceScan.completed}/{resourceScan.total}
                    </span>
                  </div>
                ) : null}
                {resourceScan.failedPages.length > 0 ? (
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-state-warn">
                    <span>
                      {language ==="zh-CN"
                        ?`有 ${resourceScan.failedPages.length} 页资源扫描失败`
                        :`${resourceScan.failedPages.length} pages failed to scan`}
                    </span>
                    <button
                      type="button"
                      className="rounded border border-state-warn-border px-2 py-1 font-medium hover:bg-state-warn-tint"
                      onClick={() => setResourceScanAttempt((value) => value + 1)}
                    >
                      {language ==="zh-CN" ?"重试" :"Retry"}
                    </button>
                  </div>
                ) : null}
              </div>
              <section className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-content-muted">
                  <ImageIcon size={14} /> {t.resourceImages}{""}
                  <span className="ml-auto font-mono">{documentImages.length}</span>
                </div>
                {documentImages.length > 0 ? (
                  documentImages.map(({ page: imagePage, image }, index) => (
                    <button
                      key={`resource-image-${imagePage}-${image.xref}-${index}`}
                      type="button"
                      className="flex w-full items-center gap-3 rounded-lg border border-border-subtle bg-surface-app p-2 text-left transition-colors hover:border-[var(--reader-accent)]"
                      onClick={() => {
                        goToPage(imagePage,"auto");
                        setReaderMode("image-label");
                      }}
                    >
                      <ImageIcon size={16} style={{ color:"var(--reader-accent)" }} />
                      <span className="min-w-0 flex-1 truncate text-xs text-content-secondary">
                        {image.extension ||"image"} · {image.width} x {image.height}
                      </span>
                      <span className="text-[11px] text-content-muted">
                        {t.page} {imagePage}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed border-border-default px-3 py-4 text-center text-xs text-content-muted">
                    {resourceScan.status ==="ready" ? t.noPdfImages : t.resourcesLoading}
                  </div>
                )}
              </section>
              <section className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-content-muted">
                  <Link2 size={14} /> {t.resourceLinks}{""}
                  <span className="ml-auto font-mono">{documentLinks.length}</span>
                </div>
                {documentLinks.length > 0 ? (
                  documentLinks.map((link) => (
                    <button
                      key={link.url}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-surface-app p-2 text-left text-xs text-content-secondary hover:border-[var(--reader-accent)]"
                      onClick={() => (onOpenLinkInApp || onOpenExternal)?.(link.url)}
                    >
                      <ExternalLink size={14} />
                      <span className="min-w-0 flex-1 truncate">{link.url}</span>
                      <span className="text-[11px] text-content-muted">
                        {t.page} {link.page}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed border-border-default px-3 py-4 text-center text-xs text-content-muted">
                    {t.resourcesLoading}
                  </div>
                )}
              </section>
              <section className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-content-muted">
                  <ExternalLink size={14} /> DOI <span className="ml-auto font-mono">{documentDois.length}</span>
                </div>
                {documentDois.length > 0 ? (
                  documentDois.map((resource) => (
                    <button
                      key={resource.resourceId}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-surface-app p-2 text-left text-xs text-content-secondary hover:border-[var(--reader-accent)]"
                      onClick={() => (onOpenLinkInApp || onOpenExternal)?.(`https://doi.org/${resource.doi}`)}
                    >
                      <ExternalLink size={14} />
                      <span className="truncate">{resource.doi}</span>
                    </button>
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed border-border-default px-3 py-4 text-center text-xs text-content-muted">
                    {t.resourcesLoading}
                  </div>
                )}
              </section>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-5 space-y-5 bg-surface-panel">
              <div>
                <div className="font-serif text-2xl font-bold text-content-primary leading-tight">
                  {title}
                </div>
                <p className="text-sm text-content-muted mt-2">{t.notesIntro}</p>
              </div>

              <div className="rounded-2xl border border-border-subtle bg-surface-app p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-content-muted mb-1">
                      {t.annotationTool}
                    </div>
                    <div className="text-sm font-medium text-content-primary">
                      {isAnnotationTool(activeTool) ? annotationLabels[activeTool] : t.switchToAnnotationTool}
                    </div>
                  </div>
                  <div
                    className="rounded-full px-2.5 py-1 text-[11px] font-medium"
                    style={{ backgroundColor:"var(--reader-accent-soft)", color:"var(--reader-accent)" }}
                  >
                    {pageAnnotations.length} {t.annotationsCount}
                  </div>
                </div>
                <p className="text-xs leading-5 text-content-muted">{t.dragToAnnotate}</p>
              </div>

              <div className="rounded-2xl border border-border-subtle bg-surface-app p-4">
                <div className="text-xs uppercase tracking-wide text-content-muted mb-2">
                  {t.addNoteBtn}
                </div>
                <textarea
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  placeholder={t.addNotePlaceholder}
                  className="w-full min-h-[96px] bg-surface-panel border border-border-subtle rounded-xl p-3 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-border-strong"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-xs text-content-muted">{t.storedWithPage.replace("{page}", String(page))}</span>
                  <button
                    onClick={submitNote}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium"
                    style={{ backgroundColor:"var(--reader-accent)", color:"var(--reader-accent-contrast)" }}
                  >
                    <MessageSquare size={14} />
                    {t.addNoteTitle}
                  </button>
                </div>
              </div>
              <div className="space-y-3">
                <div className="text-xs uppercase tracking-wide text-content-muted">
                  {t.pageAnnotations}
                </div>
                {pageAnnotations.length > 0 ? (
                  pageAnnotations.map(renderAnnotationCard)
                ) : (
                  <div className="rounded-2xl border border-dashed border-border-default px-4 py-6 text-sm text-content-muted text-center">
                    {t.noAnnotations}
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="text-xs uppercase tracking-wide text-content-muted">{t.pageNotes}</div>
                {pageNotes.length > 0 ? (
                  pageNotes.map((note) => (
                    <div
                      key={note.id}
                      className="group relative cursor-pointer rounded-2xl border border-border-subtle bg-surface-app p-4"
                      onClick={() => goToSource(note.page, note.sourceRect)}
                    >
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide text-content-muted">
                          <span
                            className="px-2 py-0.5 rounded-full"
                            style={{
                              backgroundColor:
                                note.kind ==="highlight" ?"rgba(250, 204, 21, 0.18)" :"var(--reader-accent-soft)",
                              color: note.kind ==="highlight" ?"#a16207" :"var(--reader-accent)",
                            }}
                          >
                            {note.kind ==="highlight" ? t.highlight : t.addNoteTitle}
                          </span>
                          {t.page} {note.page}
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {onUpdateNote ? (
                            <button
                              className="p-1.5 rounded-md text-content-muted hover:text-content-primary"
                              onClick={(event) => {
                                event.stopPropagation();
                                setEditingNoteId(note.id);
                                setEditingNoteDraft(note.content);
                              }}
                              title={language ==="zh-CN" ?"编辑笔记" :"Edit note"}
                            >
                              <Pencil size={14} />
                            </button>
                          ) : null}
                          {onRemoveNote ? (
                            <button
                              className="p-1.5 rounded-md text-content-muted hover:text-state-danger hover:bg-surface-hover"
                              onClick={(event) => {
                                event.stopPropagation();
                                onRemoveNote(note.id);
                              }}
                              title={t.deleteNote}
                            >
                              <Trash2 size={14} />
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {editingNoteId === note.id ? (
                        <div className="space-y-2">
                          <textarea
                            value={editingNoteDraft}
                            onChange={(event) => setEditingNoteDraft(event.target.value)}
                            className="w-full min-h-[96px] rounded-xl border border-border-subtle bg-surface-panel p-3 text-sm leading-6 resize-none focus:outline-none focus:ring-1"
                          />
                          <div className="flex justify-end gap-2">
                            <button className="px-2.5 py-1 rounded-md text-xs" onClick={() => setEditingNoteId(null)}>
                              {t.cancel}
                            </button>
                            <button
                              className="px-2.5 py-1 rounded-md text-xs text-accent-on"
                              style={{ backgroundColor:"var(--reader-accent)" }}
                              onClick={() => {
                                onUpdateNote?.(note.id, editingNoteDraft);
                                setEditingNoteId(null);
                              }}
                            >
                              {t.save}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm leading-6 text-content-secondary whitespace-pre-wrap">
                          {note.content}
                        </p>
                      )}
                      {note.reference ? <div className="mt-2 text-[11px] text-content-muted">{note.reference}</div> : null}
                      <div className="text-[11px] text-content-muted mt-3">{new Date(note.createdAt).toLocaleString()}</div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-border-default px-4 py-6 text-sm text-content-muted text-center">
                    {t.noNotes}
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="text-xs uppercase tracking-wide text-content-muted">{t.pdfImages}</div>
                {(() => {
                  const visibleImages = getVisibleImagesForPage(page).map((item) => item.img);
                  return visibleImages.length > 0 ? (
                    <div className="rounded-2xl border border-border-subtle bg-surface-app p-4 space-y-2">
                      {visibleImages.map((img, idx) => (
                        <div
                          key={`img-item-${page}-${idx}`}
                          className="flex items-center justify-between text-xs text-content-secondary border-b border-border-subtle pb-1.5 last:border-0 last:pb-0"
                        >
                          <span className="font-mono">image-{idx + 1}</span>
                          <span className="font-mono">{img.extension}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border-default px-4 py-4 text-sm text-content-muted text-center">
                      {t.noPdfImages}
                    </div>
                  );
                })()}
              </div>

              {selectedAnnotation ? (
                <div className="rounded-2xl border border-border-subtle bg-surface-app p-4">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="text-xs uppercase tracking-wide text-content-muted">
                      {t.selectedAnnotation}
                    </div>
                    {onRemoveAnnotation ? (
                      <button
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-state-danger hover:bg-state-danger-tint"
                        onClick={() => {
                          onRemoveAnnotation(selectedAnnotation.id);
                          setSelectedAnnotationId(null);
                          showActionHint(t.annotationDeleted);
                        }}
                        title={t.deleteAnnotation}
                      >
                        <Trash2 size={12} /> {t.delete}
                      </button>
                    ) : null}
                  </div>
                  <div className="text-sm font-medium text-content-primary mb-1">
                    {annotationLabels[selectedAnnotation.kind]}
                  </div>
                  <p className="text-sm text-content-secondary whitespace-pre-wrap">
                    {selectedAnnotation.content || t.overlayWithoutText}
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <ContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        isOpen={contextMenu.isOpen}
        title={t.pageActions}
        actions={buildViewerContextActions({
          onCopyPageLabel: async () => {
            try {
              await navigator.clipboard.writeText(`${title} - ${t.pageRefLabel.replace("{page}", String(page))}`);
              showActionHint(t.copyPageRefSuccess);
            } catch {
              showActionHint(t.clipboardUnavailable);
            }
          },
          onAddNote: () => {
            setIsNotesOpen(true);
            showActionHint(t.addNotePanelHint);
          },
          onExportPng: () => {
            const hasOriginal = contextMenu.imageTarget?.image.source ==="xref";
            void exportPng({
              pageNo: contextMenu.pageNo,
              imageTarget: contextMenu.imageTarget,
              mode: contextMenu.imageTarget ? (hasOriginal ?"original" :"crop") :"page",
            });
          },
          onExportImageCrop:
            contextMenu.imageTarget?.image.source ==="xref"
              ? () => {
                  void exportPng({ pageNo: contextMenu.pageNo, imageTarget: contextMenu.imageTarget, mode:"crop" });
                }
              : undefined,
          onExportSvg:
            contextMenu.imageTarget?.image.source ==="vector" || !contextMenu.imageTarget
              ? () => {
                  void exportSvg({ pageNo: contextMenu.pageNo, imageTarget: contextMenu.imageTarget });
                }
              : undefined,
          onClose: () => {
            setSelectedImageKey(null);
            setContextMenu((state) => ({ ...state, isOpen: false, imageTarget: null }));
          },
          labels: {
            copyPageReference: t.copyPageReference,
            addNoteHere: t.addNoteHere,
            exportCurrentPng: t.exportCurrentPng,
            exportCurrentSvg: t.exportCurrentSvg,
            exportImagePng: contextMenu.imageTarget?.image.source ==="xref" ? t.exportImagePng : t.exportImageCropPng,
            exportImageCropPng: t.exportImageCropPng,
            exportImageSvg: t.exportImageSvg,
            cancel: t.cancel,
          },
          imageTarget: Boolean(contextMenu.imageTarget),
        })}
        onClose={() => {
          setSelectedImageKey(null);
          setContextMenu((state) => ({ ...state, isOpen: false, imageTarget: null }));
        }}
      />
    </div>
  );
}
