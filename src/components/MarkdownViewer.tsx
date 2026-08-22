import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  List,
  PencilLine,
  SplitSquareHorizontal,
  Languages,
  MessageSquare,
  Pencil,
  Trash2,
} from "lucide-react";
import { marked } from "marked";
import type { AppLanguage } from "../services/userSettings";
import { translateReadingBlock, translateReadingBlocks, type LlmServiceConfig, type TranslationBlockResult } from "../services/readingAssistant";
import { loadTranslationCache, saveTranslationCache } from "../services/translationCache";
import { parseMarkdownBlocks } from "../services/markdownBlocks";
import { normalizeHttpUrl } from "../services/urlPolicy";
import type { ReaderNote } from "../types";
import { ReadingAssistMenu, type ReadingAssistSelection } from "./ReadingAssistMenu";

type HeadingItem = {
  id: string;
  level: number;
  text: string;
};

type ViewMode = "preview" | "edit" | "split" | "compare";

interface MarkdownViewerProps {
  title: string;
  filePath?: string;
  content: string;
  language: AppLanguage;
  onOpenExternal?: (url: string) => void;
  onContentChange?: (next: string) => void;
  onSave?: (next: string) => Promise<void> | void;
  aiModelConfig: LlmServiceConfig;
  notes: ReaderNote[];
  onAddNote?: (page: number, content: string, kind: ReaderNote["kind"], reference?: string, source?: { documentId?: string; blockId?: string; sourceRect?: ReaderNote["sourceRect"] }) => void;
  onUpdateNote?: (noteId: string, content: string) => void;
  onRemoveNote?: (noteId: string) => void;
}

const I18N = {
  "zh-CN": {
    outline: "大纲",
    noOutline: "当前文档没有标题大纲。",
    hideOutline: "收起大纲",
    showOutline: "展开大纲",
    empty: "Markdown 内容为空。",
    preview: "预览",
    edit: "编辑",
    split: "分栏",
    compare: "对照翻译",
    translate: "翻译当前文档",
    translating: "正在分块翻译...",
    translationReady: "对照翻译已完成",
    translationEmpty: "点击“翻译当前文档”生成原文与译文对照。",
    notes: "笔记",
    cancel: "取消",
    addNote: "添加笔记",
    noNotes: "暂无笔记。",
    save: "保存",
    saved: "已保存",
    saving: "保存中...",
    words: "字数",
    file: "文件",
  },
  "en-US": {
    outline: "Outline",
    noOutline: "No heading outline found in this markdown file.",
    hideOutline: "Hide outline",
    showOutline: "Show outline",
    empty: "Markdown content is empty.",
    preview: "Preview",
    edit: "Edit",
    split: "Split",
    compare: "Compare",
    translate: "Translate document",
    translating: "Translating blocks...",
    translationReady: "Comparison ready",
    translationEmpty: "Click Translate document to generate a source/translation comparison.",
    notes: "Notes",
    cancel: "Cancel",
    addNote: "Add note",
    noNotes: "No notes yet.",
    save: "Save",
    saved: "Saved",
    saving: "Saving...",
    words: "Words",
    file: "File",
  },
} as const;

type AssistBlockKind = "heading" | "paragraph" | "list" | "code";

function normalizeAssistText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function slugify(value: string, index: number) {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base ? `${base}-${index}` : `heading-${index}`;
}

function extractHeadings(markdown: string): HeadingItem[] {
  const lines = markdown.split(/\r?\n/);
  const items: HeadingItem[] = [];
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    items.push({
      id: slugify(match[2], items.length + 1),
      level: match[1].length,
      text: match[2],
    });
  }
  return items;
}

type InlineToken = Record<string, unknown>;

function inlineTokenText(token: InlineToken) {
  return typeof token.text === "string" ? token.text : typeof token.raw === "string" ? token.raw : "";
}

function inlineTokens(token: InlineToken) {
  return Array.isArray(token.tokens)
    ? token.tokens.filter((item): item is InlineToken => Boolean(item) && typeof item === "object")
    : [];
}

function renderInlineTokens(
  tokens: InlineToken[],
  keyPrefix: string,
  onOpenExternal?: (url: string) => void
): ReactNode[] {
  return tokens.reduce<ReactNode[]>((result, token, index) => {
    const key = `${keyPrefix}-${index}`;
    const children = () => renderInlineTokens(inlineTokens(token), key, onOpenExternal);
    let rendered: ReactNode | ReactNode[];
    switch (token.type) {
      case "strong":
        rendered = <strong key={key}>{children()}</strong>;
        break;
      case "em":
        rendered = <em key={key}>{children()}</em>;
        break;
      case "del":
        rendered = <del key={key}>{children()}</del>;
        break;
      case "codespan":
        rendered = <code key={key} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[0.9em] dark:bg-gray-800">{inlineTokenText(token)}</code>;
        break;
      case "br":
        rendered = <br key={key} />;
        break;
      case "image": {
        const url = normalizeHttpUrl(typeof token.href === "string" ? token.href : "");
        rendered = url
          ? <img key={key} src={url} alt={typeof token.text === "string" ? token.text : ""} loading="lazy" className="my-2 max-h-[28rem] max-w-full rounded-lg object-contain" />
          : <span key={key}>{typeof token.text === "string" ? token.text : ""}</span>;
        break;
      }
      case "link": {
        const url = normalizeHttpUrl(typeof token.href === "string" ? token.href : "");
        const label = children();
        if (!url) {
          rendered = label;
          break;
        }
        if (onOpenExternal) {
          rendered = <button key={key} type="button" className="underline underline-offset-2 transition-colors hover:opacity-85" style={{ color: "var(--reader-accent)" }} onClick={(event) => { event.stopPropagation(); onOpenExternal(url); }} title={url}>{label}</button>;
          break;
        }
        rendered = <a key={key} href={url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 transition-colors hover:opacity-85" style={{ color: "var(--reader-accent)" }} title={url}>{label}</a>;
        break;
      }
      case "html":
        rendered = <span key={key}>{inlineTokenText(token)}</span>;
        break;
      default: {
        const value = inlineTokenText(token);
        rendered = value.split(/(\n)/).map((part, partIndex) => part === "\n" ? <br key={`${key}-br-${partIndex}`} /> : <span key={`${key}-text-${partIndex}`}>{part}</span>);
      }
    }
    result.push(...(Array.isArray(rendered) ? rendered : [rendered]));
    return result;
  }, []);
}

function renderInline(text: string, keyPrefix: string, onOpenExternal?: (url: string) => void) {
  try {
    const block = marked.lexer(text)[0] as unknown as InlineToken | undefined;
    const tokens = block && Array.isArray(block.tokens)
      ? block.tokens.filter((item): item is InlineToken => Boolean(item) && typeof item === "object")
      : [{ type: "text", text }];
    return renderInlineTokens(tokens, keyPrefix, onOpenExternal);
  } catch {
    return [<span key={`${keyPrefix}-fallback`}>{text}</span>];
  }
}

export function MarkdownViewer({
  title,
  filePath,
  content,
  language,
  onOpenExternal,
  onContentChange,
  onSave,
  aiModelConfig,
  notes,
  onAddNote,
  onUpdateNote,
  onRemoveNote,
}: MarkdownViewerProps) {
  const [isOutlineOpen, setIsOutlineOpen] = useState(true);
  const [mode, setMode] = useState<ViewMode>("split");
  const [draft, setDraft] = useState(content);
  const [savedContent, setSavedContent] = useState(content);
  const [isSaving, setIsSaving] = useState(false);
  const [statusHint, setStatusHint] = useState("");
  const [assistSelection, setAssistSelection] = useState<ReadingAssistSelection | null>(null);
  const [translationResults, setTranslationResults] = useState<TranslationBlockResult[]>([]);
  const [translationStatus, setTranslationStatus] = useState("");
  const [isTranslating, setIsTranslating] = useState(false);
  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteDraft, setEditingNoteDraft] = useState("");
  const translationAbortRef = useRef<AbortController | null>(null);
  const retryAbortRef = useRef<AbortController | null>(null);
  const headingRefMap = useRef<Map<string, HTMLHeadingElement>>(new Map());
  const currentPathRef = useRef<string | undefined>(filePath);
  const t = I18N[language];

  useEffect(() => {
    const changedFile = currentPathRef.current !== filePath;
    if (changedFile) {
      translationAbortRef.current?.abort();
      retryAbortRef.current?.abort();
      translationAbortRef.current = null;
      retryAbortRef.current = null;
      currentPathRef.current = filePath;
      setDraft(content);
      setSavedContent(content);
      setTranslationResults([]);
      setTranslationStatus("");
      setStatusHint("");
      return;
    }

    if (content !== draft && content !== savedContent) {
      setDraft(content);
      setSavedContent(content);
    }
  }, [content, draft, filePath, savedContent]);

  useEffect(() => {
    if (!statusHint) return;
    const timer = window.setTimeout(() => setStatusHint(""), 1600);
    return () => window.clearTimeout(timer);
  }, [statusHint]);

  const headings = useMemo(() => extractHeadings(draft), [draft]);
  const wordCount = useMemo(() => {
    const trimmed = draft.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }, [draft]);

  const isDirty = draft !== savedContent;
  const translationDocumentId = filePath || title;

  const translationBlocks = useMemo(
    () => parseMarkdownBlocks(draft, translationDocumentId),
    [draft, translationDocumentId]
  );

  useEffect(() => {
    const cached = loadTranslationCache("markdown", translationDocumentId, aiModelConfig, translationBlocks);
    setTranslationResults(cached?.results || []);
    setTranslationStatus(cached ? t.translationReady : "");
  }, [aiModelConfig, t.translationReady, title, translationBlocks, translationDocumentId]);

  useEffect(() => {
    translationAbortRef.current?.abort();
    retryAbortRef.current?.abort();
    translationAbortRef.current = null;
    retryAbortRef.current = null;
  }, [translationBlocks]);

  useEffect(() => {
    if (translationResults.length > 0) {
      saveTranslationCache("markdown", translationDocumentId, aiModelConfig, translationBlocks, translationResults);
    }
  }, [aiModelConfig, translationBlocks, translationDocumentId, translationResults]);

  useEffect(() => () => {
    translationAbortRef.current?.abort();
    retryAbortRef.current?.abort();
  }, []);

  const runTranslation = async () => {
    if (isTranslating) return;
    const controller = new AbortController();
    translationAbortRef.current = controller;
    setIsTranslating(true);
    setTranslationResults([]);
    setTranslationStatus(t.translating);
    try {
      const results = await translateReadingBlocks({ config: aiModelConfig, blocks: translationBlocks, sourceTitle: title, signal: controller.signal });
      if (controller.signal.aborted || translationAbortRef.current !== controller) return;
      setTranslationResults(results);
      setTranslationStatus(t.translationReady);
    } catch (error) {
      if (controller.signal.aborted || translationAbortRef.current !== controller) return;
      setTranslationStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTranslating(false);
      if (translationAbortRef.current === controller) translationAbortRef.current = null;
    }
  };

  const retryTranslationBlock = async (blockId: string) => {
    const block = translationBlocks.find((item) => item.id === blockId);
    if (!block) return;
    retryAbortRef.current?.abort();
    const controller = new AbortController();
    retryAbortRef.current = controller;
    setTranslationStatus(t.translating);
    try {
      const result = await translateReadingBlock({ config: aiModelConfig, block, sourceTitle: title, signal: controller.signal });
      setTranslationResults((prev) => [...prev.filter((item) => item.block.id !== blockId), result].sort((a, b) => a.block.id.localeCompare(b.block.id)));
      setTranslationStatus(t.translationReady);
    } catch (error) {
      if (controller.signal.aborted) return;
      setTranslationResults((prev) => prev.map((item) => item.block.id === blockId ? { ...item, error: error instanceof Error ? error.message : String(error) } : item));
    } finally {
      if (retryAbortRef.current === controller) retryAbortRef.current = null;
    }
  };

  const openAssistSelection = (
    kind: AssistBlockKind,
    index: number,
    text: string,
    event: ReactMouseEvent<HTMLElement>
  ) => {
    const clean = normalizeAssistText(text);
    if (!clean) return;
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setAssistSelection({
      id: `md-${kind}-${index}-${clean.slice(0, 24)}`,
      text: clean,
      reference: `${kind} ${index + 1}`,
      sourceTitle: title,
      x: Math.min(event.clientX, rect.right + 10),
      y: Math.max(12, rect.top - 8),
    });
  };

  const assistProps = (kind: AssistBlockKind, index: number, text: string) => ({
    onClick: (event: ReactMouseEvent<HTMLElement>) => openAssistSelection(kind, index, text, event),
    title: language === "zh-CN" ? "点击打开阅读辅助" : "Click for reading assist",
  });

  const blocks = useMemo(() => translationBlocks.map((block, index) => {
    const text = block.text;
    const assistKind: AssistBlockKind = block.kind === "title" ? "heading" : block.kind === "list" ? "list" : block.kind === "code" ? "code" : "paragraph";
    const assist = { ...assistProps(assistKind, index, text), "data-reading-block-id": block.id };
    if (block.kind === "code") {
      return <pre key={block.id} {...assist} className="reading-assist-block rounded-2xl border border-gray-200 bg-gray-50 p-4 font-mono text-sm leading-6 text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200"><code>{text}</code></pre>;
    }
    if (block.kind === "title") {
      const id = slugify(text, index + 1);
      return <h2 key={block.id} id={id} ref={(node) => { if (node) headingRefMap.current.set(id, node); else headingRefMap.current.delete(id); }} {...assist} className="reading-assist-block mt-5 text-xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">{renderInline(text, block.id, onOpenExternal)}</h2>;
    }
    if (block.kind === "quote") {
      return <blockquote key={block.id} {...assist} className="reading-assist-block border-l-2 border-[var(--reader-accent)] bg-gray-50 px-4 py-2 leading-7 text-gray-700 dark:bg-gray-900 dark:text-gray-300">{renderInline(text, block.id, onOpenExternal)}</blockquote>;
    }
    if (block.kind === "equation") {
      return <div key={block.id} {...assist} className="reading-assist-block overflow-x-auto rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 font-mono text-sm leading-7 text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200">{text}</div>;
    }
    if (block.kind === "auxiliary") {
      return <aside key={block.id} {...assist} className="reading-assist-block border-l-2 border-gray-300 bg-gray-50 px-4 py-2 text-sm leading-6 text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">{renderInline(text, block.id, onOpenExternal)}</aside>;
    }
    if (block.kind === "table") {
      const rows = text.split("\n").map((row) => row.replace(/^\s*\|?\s*|\s*\|?\s*$/g, "").split("|").map((cell) => cell.trim())).filter((row) => row.length > 1 && !row.every((cell) => /^:?-{3,}:?$/.test(cell)));
      return <div key={block.id} {...assist} className="reading-assist-block overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800"><table className="min-w-full border-collapse text-sm leading-6"><thead><tr>{(rows[0] || []).map((cell, cellIndex) => <th key={`${block.id}-h-${cellIndex}`} style={{ textAlign: block.tableAlign?.[cellIndex] || "left" }} className="border-b border-gray-200 bg-gray-50 px-3 py-2 font-semibold dark:border-gray-800 dark:bg-gray-900">{renderInline(cell, `${block.id}-h-${cellIndex}`, onOpenExternal)}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, rowIndex) => <tr key={`${block.id}-r-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${block.id}-c-${rowIndex}-${cellIndex}`} style={{ textAlign: block.tableAlign?.[cellIndex] || "left" }} className="border-b border-gray-100 px-3 py-2 align-top dark:border-gray-800">{renderInline(cell, `${block.id}-c-${rowIndex}-${cellIndex}`, onOpenExternal)}</td>)}</tr>)}</tbody></table></div>;
    }
    if (block.kind === "list") {
      const task = /^\[([ xX])\]\s+(.+)$/.exec(text);
      const listStyle = { marginLeft: `${Math.min(8, block.depth || 0) * 1.25}rem` };
      return task ? <label key={block.id} {...assist} style={listStyle} className="reading-assist-block flex items-start gap-2 leading-7 text-gray-700 dark:text-gray-300"><input type="checkbox" checked={task[1].toLowerCase() === "x"} readOnly className="mt-2" />{renderInline(task[2], block.id, onOpenExternal)}</label> : <li key={block.id} {...assist} style={listStyle} className="reading-assist-block list-disc leading-7 text-gray-700 dark:text-gray-300">{renderInline(text, block.id, onOpenExternal)}</li>;
    }
    return <p key={block.id} {...assist} className="reading-assist-block leading-7 text-gray-700 dark:text-gray-300">{renderInline(text, block.id, onOpenExternal)}</p>;
  }), [assistProps, onOpenExternal, translationBlocks]);

  const handleSave = async () => {
    if (!onSave || isSaving || !isDirty) return;
    setIsSaving(true);
    try {
      await onSave(draft);
      setSavedContent(draft);
      setStatusHint(t.saved);
    } finally {
      setIsSaving(false);
    }
  };

  const renderPreviewPane = () => (
    <div className="h-full overflow-auto bg-zinc-50 dark:bg-[var(--chrome-surface-1)]">
      <article className="mx-auto w-full max-w-4xl px-6 py-8 space-y-1">
        {draft.trim().length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-8 text-center text-sm text-gray-500 dark:text-gray-400">
            {t.empty}
          </div>
        ) : (
          blocks
        )}
      </article>
    </div>
  );

  const renderComparePane = () => (
    <div className="h-full overflow-auto bg-zinc-50 dark:bg-[var(--chrome-surface-1)]">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-4">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 dark:border-[var(--chrome-border)] pb-3">
          <div><div className="text-sm font-semibold">{t.compare}</div><div className="text-xs text-gray-500 dark:text-gray-400">{translationStatus || t.translationEmpty}</div></div>
          <div className="flex gap-2">
            {isTranslating ? <button type="button" onClick={() => translationAbortRef.current?.abort()} className="rounded-lg border px-3 py-1.5 text-xs">{language === "zh-CN" ? "取消" : "Cancel"}</button> : <button type="button" onClick={() => void runTranslation()} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-white" style={{ backgroundColor: "var(--reader-accent)" }}><Languages className="h-3.5 w-3.5" />{t.translate}</button>}
          </div>
        </div>
        {translationResults.length === 0 ? <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 px-5 py-12 text-center text-sm text-gray-500 dark:text-gray-400">{t.translationEmpty}</div> : translationResults.map((item) => (
          <div key={item.block.id} className={`grid grid-cols-1 gap-3 rounded-xl border border-gray-200 dark:border-[var(--chrome-border)] bg-white dark:bg-[var(--chrome-surface-2)] p-4 lg:grid-cols-2 ${item.block.kind === "code" ? "font-mono" : ""}`}>
            <div className={`min-w-0 text-sm leading-7 whitespace-pre-wrap ${item.block.kind === "title" ? "font-semibold text-gray-900 dark:text-gray-100" : "text-gray-700 dark:text-gray-300"}`}>{item.block.text}</div>
            <div className={`min-w-0 border-t border-gray-100 pt-3 text-sm leading-7 text-gray-900 dark:border-gray-800 dark:text-gray-100 whitespace-pre-wrap lg:border-l lg:border-t-0 lg:pl-4 ${item.block.kind === "code" ? "text-gray-500 dark:text-gray-400" : ""}`}>{item.error ? <div className="space-y-2 text-red-600 dark:text-red-400"><div>{item.error}</div><button type="button" onClick={() => void retryTranslationBlock(item.block.id)} className="rounded border border-red-300 px-2 py-1 text-xs">{language === "zh-CN" ? "重试此段" : "Retry block"}</button></div> : item.translation}</div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderNotesPane = () => (
    <aside className="absolute right-4 top-16 z-20 flex max-h-[calc(100%-5rem)] w-80 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-[var(--chrome-border)] dark:bg-[var(--chrome-surface-2)]">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-[var(--chrome-border)]"><div className="inline-flex items-center gap-2 text-sm font-semibold"><MessageSquare className="h-4 w-4" />{t.notes}</div><button type="button" onClick={() => setIsNotesOpen(false)} className="text-xs text-gray-500">{language === "zh-CN" ? "关闭" : "Close"}</button></div>
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {notes.length === 0 ? <div className="py-8 text-center text-sm text-gray-500">{t.noNotes}</div> : notes.map((note) => <div key={note.id} className="group cursor-pointer rounded-lg border border-gray-200 p-3 dark:border-gray-800" onClick={() => {
          if (!note.blockId) return;
          document.querySelector<HTMLElement>(`[data-reading-block-id="${CSS.escape(note.blockId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}>
          {editingNoteId === note.id ? <><textarea value={editingNoteDraft} onChange={(event) => { event.stopPropagation(); setEditingNoteDraft(event.currentTarget.value); }} className="min-h-24 w-full resize-none rounded border p-2 text-sm dark:bg-gray-900" /><div className="mt-2 flex justify-end gap-2"><button type="button" className="text-xs" onClick={(event) => { event.stopPropagation(); setEditingNoteId(null); }}>{t.cancel}</button><button type="button" className="rounded px-2 py-1 text-xs text-white" style={{ backgroundColor: "var(--reader-accent)" }} onClick={(event) => { event.stopPropagation(); onUpdateNote?.(note.id, editingNoteDraft); setEditingNoteId(null); }}>{t.save}</button></div></> : <><div className="mb-2 flex items-center justify-between text-[11px] text-gray-500"><span>{note.reference || `${t.file} · ${note.page}`}</span><span className="flex gap-1 opacity-0 group-hover:opacity-100"><button type="button" onClick={(event) => { event.stopPropagation(); setEditingNoteId(note.id); setEditingNoteDraft(note.content); }} title={language === "zh-CN" ? "编辑" : "Edit"}><Pencil className="h-3.5 w-3.5" /></button><button type="button" onClick={(event) => { event.stopPropagation(); onRemoveNote?.(note.id); }} title={language === "zh-CN" ? "删除" : "Delete"}><Trash2 className="h-3.5 w-3.5" /></button></span></div><p className="whitespace-pre-wrap text-sm leading-6">{note.content}</p></>}</div>)}
      </div>
    </aside>
  );

  const renderEditorPane = () => (
    <div className="h-full p-4 bg-zinc-50 dark:bg-[var(--chrome-surface-1)]">
      <textarea
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          onContentChange?.(next);
        }}
        className="h-full w-full rounded-2xl border border-gray-200 dark:border-[var(--chrome-border)] bg-white dark:bg-[var(--chrome-surface-2)] p-4 text-sm leading-6 font-mono text-gray-800 dark:text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--reader-accent)]"
        spellCheck={false}
      />
    </div>
  );

  return (
    <div className="flex h-full bg-zinc-50 dark:bg-[var(--chrome-surface-1)] text-gray-900 dark:text-gray-100 overflow-hidden">
      <ReadingAssistMenu
        selection={assistSelection}
        language={language}
        modelConfig={aiModelConfig}
        onClose={() => setAssistSelection(null)}
        onHint={setStatusHint}
        onSaveQuote={(selection, quote) => onAddNote?.(1, quote, "highlight", selection.reference, { documentId: translationDocumentId, blockId: selection.blockId, sourceRect: selection.sourceRect })}
      />
      <div
        className={`${isOutlineOpen ? "w-64" : "w-0"} transition-[width] duration-200 ease-out bg-white dark:bg-[var(--chrome-surface-1)] border-r border-gray-100 dark:border-[var(--chrome-border)] hidden md:flex md:flex-col shrink-0 overflow-hidden`}
      >
        <div className="h-12 flex items-center px-4 border-b border-gray-100 dark:border-[var(--chrome-border)] text-sm font-semibold tracking-tight">
          <List className="w-4 h-4 mr-2" />
          {t.outline}
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {headings.length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">{t.noOutline}</div>
          ) : (
            headings.map((item) => (
              <button
                key={item.id}
                type="button"
                className="w-full text-left rounded-lg px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                style={{ paddingLeft: `${Math.min(24, (item.level - 1) * 10 + 8)}px` }}
                onClick={() => {
                  const node = headingRefMap.current.get(item.id);
                  node?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                {item.text}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-14 bg-white dark:bg-[var(--chrome-surface-1)] border-b border-gray-100 dark:border-[var(--chrome-border)] flex items-center justify-between px-4 shrink-0 shadow-sm">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              onClick={() => setIsOutlineOpen((value) => !value)}
              title={isOutlineOpen ? t.hideOutline : t.showOutline}
            >
              {isOutlineOpen ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
            </button>
            <div className="min-w-0">
              <div className="text-sm font-semibold tracking-tight text-gray-900 dark:text-gray-100 truncate max-w-[44vw]">
                {title}
              </div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 font-mono truncate max-w-[44vw]">
                {t.file}: {filePath || "-"}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-1 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-1">
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-colors ${
                  mode === "preview"
                    ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
                onClick={() => setMode("preview")}
              >
                <Eye className="w-3.5 h-3.5" />
                {t.preview}
              </button>
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-colors ${
                  mode === "edit"
                    ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
                onClick={() => setMode("edit")}
              >
                <PencilLine className="w-3.5 h-3.5" />
                {t.edit}
              </button>
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-colors ${
                  mode === "split"
                    ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
                onClick={() => setMode("split")}
              >
                <SplitSquareHorizontal className="w-3.5 h-3.5" />
                {t.split}
              </button>
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-colors ${mode === "compare" ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100" : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
                onClick={() => setMode("compare")}
              >
                <Languages className="w-3.5 h-3.5" />{t.compare}
              </button>
            </div>

            <div className="text-xs text-gray-500 dark:text-gray-400 font-mono hidden md:block">
              {t.words}: {wordCount}
            </div>

            {onSave ? (
              <button
                type="button"
                onClick={() => {
                  void handleSave();
                }}
                disabled={!isDirty || isSaving}
                className="inline-flex items-center gap-1.5 rounded-xl bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500"
              >
                {isSaving ? (
                  <span className="animate-pulse">{t.saving}</span>
                ) : (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    {t.save}
                  </>
                )}
              </button>
            ) : null}

            <button type="button" onClick={() => setIsNotesOpen((value) => !value)} className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-[var(--chrome-border)] dark:text-gray-300 dark:hover:bg-gray-800" title={t.notes}>
              <MessageSquare className="h-3.5 w-3.5" />{t.notes} ({notes.length})
            </button>

            {statusHint ? <span className="text-xs" style={{ color: "var(--reader-accent)" }}>{statusHint}</span> : null}
          </div>
        </div>

        <div className="flex-1 min-h-0">
          {mode === "preview" ? renderPreviewPane() : null}
          {mode === "edit" ? renderEditorPane() : null}
            {mode === "split" ? (
            <div className="h-full grid grid-cols-1 lg:grid-cols-2">
              <div className="border-b lg:border-b-0 lg:border-r border-gray-200 dark:border-[var(--chrome-border)]">{renderEditorPane()}</div>
              {renderPreviewPane()}
            </div>
          ) : null}
          {mode === "compare" ? renderComparePane() : null}
        </div>
      </div>
      {isNotesOpen ? renderNotesPane() : null}
    </div>
  );
}
