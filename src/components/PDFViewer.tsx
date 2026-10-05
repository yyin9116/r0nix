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
  ReaderNote,
} from"../types";
import type { PDFImageInfo } from"../services/pdfApi";
import { ContextMenu, buildViewerContextActions } from"./ContextMenu";
import { ReadingAssistMenu, type ReadingAssistSelection } from"./ReadingAssistMenu";
import {
  translateReadingBlock,
  translateReadingBlocks,
  translateReadingSelection,
  type LlmServiceConfig,
  type TranslationBlockResult,
} from"../services/readingAssistant";
import { loadTranslationCache, saveTranslationCache } from"../services/translationCache";
import { loadResourceIndex, saveResourceIndex } from"../services/resourceIndexCache";
import"./PDFViewer.css";
import { PageCanvas } from"./pdfReader/PageCanvas";
import { PageThumbnail } from"./pdfReader/PageThumbnail";
import { ToolButton } from"./pdfReader/ToolButton";
import {
  ACTIVE_NEIGHBOR,
  DEFAULT_PAGE_SIZE,
  I18N,
  PAGE_RENDER_OVERSCAN_WHILE_ZOOMING,
  WHEEL_ZOOM_MIN_STEP,
  WHEEL_ZOOM_SENSITIVITY,
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
  isLikelyImageCandidate,
  normalizeImageBbox,
  normalizeRect,
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
}: PDFViewerProps) {
  const [zoom, setZoom] = useState(() => clampZoomValue(initialViewState?.zoom ?? 100));
  const [renderZoom, setRenderZoom] = useState(() => clampZoomValue(initialViewState?.zoom ?? 100));
  const [page, setPage] = useState(() => Math.max(1, Math.round(initialViewState?.page ?? 1)));
  const [totalPages, setTotalPages] = useState(1);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
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
  const [sidePanelView, setSidePanelView] = useState<"notes" |"translation" |"resources">("notes");
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
    }),
    [t.addText, t.highlight, t.strikethrough, t.underline],
  );
  const gestureStartRef = useRef<{ x: number; y: number } | null>(null);
  const rightDragRef = useRef<{ active: boolean; moved: boolean; pointerId: number | null; pageNo: number | null }>({
    active: false,
    moved: false,
    pointerId: null,
    pageNo: null,
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
  const thumbnailVisibilityHandlersRef = useRef<Map<number, () => void>>(new Map());
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
  const zoomAnchorRef = useRef<{
    pageNo: number;
    relX: number;
    relY: number;
    viewportX: number;
    viewportY: number;
  } | null>(null);
  const lockedZoomPageRef = useRef<number | null>(null);
  const readingBlocksByPageRef = useRef<Map<number, PdfReadingBlock[]>>(new Map());
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
  const detectPageImagesRef = useRef<(pageNo: number) => Promise<PDFImageInfo[] | undefined>>(async () => []);
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
  const zoomScale = useMemo(() => Math.max(0.5, zoom / 100), [zoom]);
  const renderZoomScale = useMemo(() => Math.max(0.5, renderZoom / 100), [renderZoom]);
  const visiblePage = lockedZoomPage ?? page;
  renderZoomRef.current = renderZoom;

  const registerThumbnailVisibility = useCallback((pageNo: number, onEnter: (() => void) | null) => {
    if (onEnter) thumbnailVisibilityHandlersRef.current.set(pageNo, onEnter);
    else thumbnailVisibilityHandlersRef.current.delete(pageNo);
  }, []);

  useEffect(() => {
    const root = thumbListRef.current;
    if (!root || typeof IntersectionObserver ==="undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const pageNo = Number((entry.target as HTMLElement).dataset.thumbnailPage);
          if (Number.isInteger(pageNo)) thumbnailVisibilityHandlersRef.current.get(pageNo)?.();
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
      return;
    }

    const cached = api.getPdfDocument(fileId);
    if (!cached) {
      setPdfDoc(null);
      setTotalPages(1);
      setOutlineEntries([]);
      setLoading(false);
      setRenderError(t.pdfNotLoaded);
      return;
    }

    setLoading(true);
    setPdfDoc(cached);
    setTotalPages(Math.max(1, cached.numPages || 1));

    let disposed = false;
    const loadingGuard = window.setTimeout(() => {
      if (!disposed) setLoading(false);
    }, 260);

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
  const isImageLabelReader = readerMode ==="image-label";
  const handleAssistSelection = useCallback(
    (selection: Omit<ReadingAssistSelection,"id" |"sourceTitle">) => {
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
    const lockedPage = lockedZoomPageRef.current;
    if (lockedPage !== null) {
      const node = pageRefs.current.get(lockedPage);
      if (node) {
        // The preview transform is written outside React for animation. Once
        // the committed canvas is ready, return ownership to React so a later
        // document/tab change cannot inherit a stale transform.
        node.style.transform ="";
        node.style.transformOrigin ="";
      }
    }
    lockedZoomPageRef.current = null;
    setLockedZoomPage(null);
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
      zoomRenderReadyRef.current = false;
      // A right-button wheel gesture is a visual-only phase. Committing
      // renderZoom here would resize every page while the pointer is still
      // moving, causing canvas re-renders, blank frames, and page drift.
      if (rightDragRef.current.active) return;
      zoomRenderCommitTimerRef.current = window.setTimeout(() => {
        zoomRenderCommitTimerRef.current = null;
        setRenderZoom(clampZoomValue(targetZoom));
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

  const captureZoomAnchor = useCallback(
    (pageNo: number, clientX?: number, clientY?: number) => {
      const root = scrollRef.current;
      const node = pageRefs.current.get(clampPage(pageNo, totalPages));
      if (!root || !node) return;
      const rootRect = root.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const viewportX = typeof clientX ==="number" ? clientX - rootRect.left : root.clientWidth / 2;
      const viewportY = typeof clientY ==="number" ? clientY - rootRect.top : root.clientHeight / 2;
      zoomAnchorRef.current = {
        pageNo: clampPage(pageNo, totalPages),
        relX: Math.max(0, Math.min(1, (rootRect.left + viewportX - nodeRect.left) / Math.max(1, nodeRect.width))),
        relY: Math.max(0, Math.min(1, (rootRect.top + viewportY - nodeRect.top) / Math.max(1, nodeRect.height))),
        viewportX,
        viewportY,
      };
    },
    [totalPages],
  );

  const applyZoomPreview = useCallback(
    (previewZoom: number) => {
      const anchor = zoomAnchorRef.current;
      const root = scrollRef.current;
      const lockedPage = lockedZoomPageRef.current;
      const node = lockedPage === null ? null : pageRefs.current.get(lockedPage);
      if (!anchor || !root || !node) return;

      const previewScale = Math.max(0.5, previewZoom / 100);
      const visualScale = previewScale / Math.max(0.01, renderZoomScale);
      node.style.transform = Math.abs(visualScale - 1) < 0.0001 ?"" :`scale(${visualScale})`;
      // Keep the point under the pointer fixed by the transform itself. A
      // second scroll correction causes the page to drift left and snap back.
      node.style.transformOrigin =`${anchor.relX * 100}% ${anchor.relY * 100}%`;
    },
    [renderZoomScale],
  );

  const animateZoomToTarget = useCallback(() => {
    if (zoomAnimationRef.current !== null) return;
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

  const smoothZoomBy = useCallback(
    (delta: number, options?: { pageNo?: number; clientX?: number; clientY?: number }) => {
      const anchorPage = clampPage(
        options?.pageNo ?? lockedZoomPageRef.current ?? lockedZoomPage ?? visiblePage,
        totalPages,
      );
      if (lockedZoomPageRef.current === null) {
        lockedZoomPageRef.current = anchorPage;
        setLockedZoomPage(anchorPage);
        const nextActive = new Set<number>();
        for (
          let offset = -PAGE_RENDER_OVERSCAN_WHILE_ZOOMING;
          offset <= PAGE_RENDER_OVERSCAN_WHILE_ZOOMING;
          offset += 1
        ) {
          nextActive.add(clampPage(anchorPage + offset, totalPages));
        }
        setActivePages(nextActive);
      }
      captureZoomAnchor(anchorPage, options?.clientX, options?.clientY);
      zoomTargetRef.current = clampZoomValue(zoomTargetRef.current + delta);
      zoomRenderReadyRef.current = false;
      scheduleRenderZoomCommit(zoomTargetRef.current);
      animateZoomToTarget();
    },
    [animateZoomToTarget, captureZoomAnchor, lockedZoomPage, scheduleRenderZoomCommit, totalPages, visiblePage],
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

      const rootRect = root.getBoundingClientRect();
      const centerX = rootRect.left + root.clientWidth / 2;
      const centerY = rootRect.top + root.clientHeight / 2;
      const centerPageNode = document
        .elementsFromPoint(centerX, centerY)
        .map((node) => (node instanceof HTMLElement ? node.closest<HTMLElement>("[data-pdf-page]") : null))
        .find((node): node is HTMLElement => Boolean(node));
      const nearest = centerPageNode ? Number(centerPageNode.dataset.pdfPage) : page;
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

    onAddAnnotation?.({
      blockId: findReadingBlockIdForRect(rect, readingBlocksByPageRef.current.get(targetPage) || []),
      page: targetPage,
      kind,
      rect,
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

      rightDragRef.current = { active: false, moved: false, pointerId: null, pageNo: null };
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

      const shouldOpenMenu = Boolean(options?.openMenuIfClick) && !right.moved;

      rightDragRef.current = { active: false, moved: false, pointerId: null, pageNo: null };
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
      const lockedPage = clampPage(pageNo, totalPages);
      rightDragRef.current = { active: true, moved: false, pointerId: event.pointerId, pageNo: lockedPage };
      lockedZoomPageRef.current = lockedPage;
      gestureStartRef.current = { x: event.clientX, y: event.clientY };
      setIsGestureRightDown(true);
      setLockedZoomPage(lockedPage);
      setPage(lockedPage);
      const nextActive = new Set<number>();
      for (let delta = -PAGE_RENDER_OVERSCAN_WHILE_ZOOMING; delta <= PAGE_RENDER_OVERSCAN_WHILE_ZOOMING; delta += 1) {
        nextActive.add(clampPage(lockedPage + delta, totalPages));
      }
      setActivePages(nextActive);
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
    return normalizeRect(
      draftAnnotation.startX,
      draftAnnotation.startY,
      draftAnnotation.currentX,
      draftAnnotation.currentY,
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
  }, [aiModelConfig, documentId, fileId, language, loadFullTranslationBlocks, t.translateFailed, title]);

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
    [aiModelConfig, t.translateFailed, t.translating],
  );

  useEffect(() => {
    if (!fileId || !pdfDoc) return;
    if (isImageLabelReader) {
      prefetchImageLabelsAround(page);
      return;
    }
    const controller = new AbortController();
    void detectPageImages(page, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [detectPageImages, fileId, isImageLabelReader, page, pdfDoc, prefetchImageLabelsAround]);

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
        onClose={() => setAssistSelection(null)}
        onHint={showActionHint}
        onTranslate={openTranslationPreview}
        onSaveQuote={(selection, quote) =>
          onAddNote?.(page, quote,"highlight", selection.reference, {
            documentId,
            blockId: selection.blockId,
            sourceRect: selection.sourceRect,
          })
        }
        variant={isTranslationReader ?"inline-toolbar" :"panel"}
      />

      <div
        className={`${isLeftSidebarOpen ?"w-[196px]" :"w-0"} transition-[width] duration-150 ease-out bg-surface-panel border-r border-border-subtle hidden md:flex md:flex-col shrink-0 overflow-hidden`}
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
        className={`flex-1 flex flex-col min-w-0 transition-[padding-right] duration-200 ease-out ${isNotesOpen ?"lg:pr-80" :""}`}
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
          className="pdf-selection-scope flex-1 overflow-auto bg-surface-sunken/50 relative z-0"
          onWheel={(event) => {
            if (!isGestureRightDown) return;
            event.preventDefault();
            event.stopPropagation();
            const lockedPage = lockedZoomPageRef.current ?? lockedZoomPage ?? visiblePage;
            const wheelMagnitude = Math.max(
              WHEEL_ZOOM_MIN_STEP,
              Math.min(24, Math.abs(event.deltaY) * WHEEL_ZOOM_SENSITIVITY),
            );
            const step = event.deltaY < 0 ? wheelMagnitude : -wheelMagnitude;
            smoothZoomBy(step, { pageNo: lockedPage, clientX: event.clientX, clientY: event.clientY });
          }}
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
              <div className="mx-auto flex w-fit flex-col items-center gap-0">
                {pageNumbers.map((pageNo) => {
                  const size = pageSizes[pageNo] || DEFAULT_PAGE_SIZE;
                  const width = Math.max(1, Math.round(size.width * renderZoomScale));
                  const height = Math.max(1, Math.round(size.height * renderZoomScale));
                  const active =
                    lockedZoomPage === null
                      ? activePages.has(pageNo)
                      : Math.abs(pageNo - lockedZoomPage) <= PAGE_RENDER_OVERSCAN_WHILE_ZOOMING;
                  const visualScale = lockedZoomPage === pageNo ? zoomScale / Math.max(0.01, renderZoomScale) : 1;
                  const pageAnnotationItems = active ? annotationsByPage.get(pageNo) || [] : [];
                  const pageDraftRect = active && draftAnnotation?.page === pageNo ? draftRect : null;
                  const pageSize = pageSizes[pageNo] || DEFAULT_PAGE_SIZE;
                  // Keep image hit targets available in every PDF view. They are
                  // visually transparent outside image-label mode, so text
                  // selection remains native while image context actions work.
                  const visiblePageImages = active ? getVisibleImagesForPage(pageNo) : [];
                  const structuredPageBlocks = active ? readingBlocksByPageRef.current.get(pageNo) || [] : [];

                  return (
                    <div
                      key={pageNo}
                      ref={(node) => {
                        if (node) pageRefs.current.set(pageNo, node);
                        else pageRefs.current.delete(pageNo);
                      }}
                      data-pdf-page={pageNo}
                      className={`pdf-page-block relative overflow-hidden bg-surface-panel border origin-top ${isGestureRightDown ?"cursor-ns-resize" : activeTool ==="hand" ?"cursor-grab active:cursor-grabbing" : activeTool ==="select" ?"cursor-text" :"cursor-crosshair"} dark:invert dark:hue-rotate-180 ${visiblePage === pageNo ?"pdf-page-block--focused" :"border-transparent"}`}
                      style={{
                        width,
                        height,
                        contentVisibility: active ?"visible" :"auto",
                        containIntrinsicSize:`${height}px ${width}px`,
                        visibility:
                          isGestureRightDown && lockedZoomPage !== null && pageNo !== lockedZoomPage
                            ?"hidden"
                            : undefined,
                        transform: visualScale === 1 ? undefined :`scale(${visualScale})`,
                        transformOrigin:"top left",
                        zIndex: visualScale === 1 ? undefined : 3,
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
                            enableTextLayer={activeTool ==="select" || isTranslationReader}
                            enableAssistBlocks={isTranslationReader}
                            linksEnabled={!isTranslationReader}
                            onSize={updatePageSize}
                            onError={setRenderError}
                            renderingLabel={t.rendering}
                            onOpenExternal={onOpenExternal}
                            onOpenLinkInApp={onOpenLinkInApp}
                            onAssistSelection={isTranslationReader ? handleAssistSelection : undefined}
                            onReadingBlocks={updateReadingBlocks}
                            structuredBlocks={structuredPageBlocks}
                            structuredBlocksVersion={readingBlocksVersion}
                            onPageLinks={updatePageLinks}
                            onPageRendered={handlePageRendered}
                          />
                          <div
                            className="absolute inset-0"
                            style={{
                              pointerEvents:
                                (activeTool ==="select" || isTranslationReader) && !isGestureRightDown
                                  ?"none"
                                  :"auto",
                            }}
                          >
                            {pageAnnotationItems.map((annotation) => (
                              <button
                                key={annotation.id}
                                type="button"
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
                  );
                })}
              </div>
            </div>
          )}

          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-surface-panel/60 text-content-muted text-sm">
              {t.loadingPdf}
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
        className={`absolute right-0 top-0 z-40 hidden h-full w-[20rem] transform-gpu flex-col overflow-hidden border-l border-border-subtle bg-surface-panel shadow-[-18px_0_38px_rgba(15,23,42,0.08)] transition-transform duration-200 ease-out will-change-transform dark:shadow-[-18px_0_38px_rgba(0,0,0,0.32)] lg:flex ${
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
              ) : (
                <MessageSquare size={16} />
              )}
              {sidePanelView ==="translation"
                ? t.translationPreview
                : sidePanelView ==="resources"
                  ? t.resources
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
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface-sunken p-1">
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
            </div>
          </div>

          {sidePanelView ==="translation" ? (
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
