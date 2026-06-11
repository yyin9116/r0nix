import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  List,
  PencilLine,
  SplitSquareHorizontal,
} from "lucide-react";
import type { AppLanguage } from "../services/userSettings";

type HeadingItem = {
  id: string;
  level: number;
  text: string;
};

type ViewMode = "preview" | "edit" | "split";

interface MarkdownViewerProps {
  title: string;
  filePath?: string;
  content: string;
  language: AppLanguage;
  onOpenExternal?: (url: string) => void;
  onContentChange?: (next: string) => void;
  onSave?: (next: string) => Promise<void> | void;
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
    save: "Save",
    saved: "Saved",
    saving: "Saving...",
    words: "Words",
    file: "File",
  },
} as const;

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

function renderInline(text: string, keyPrefix: string, onOpenExternal?: (url: string) => void) {
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    if (start > cursor) {
      nodes.push(<span key={`${keyPrefix}-txt-${cursor}`}>{text.slice(cursor, start)}</span>);
    }

    const markdownLabel = match[1];
    const markdownUrl = match[2];
    const rawUrl = match[3];
    const url = markdownUrl || rawUrl;
    const label = markdownLabel || rawUrl;

    if (url && label) {
      if (onOpenExternal) {
        nodes.push(
          <button
            key={`${keyPrefix}-link-${start}`}
            type="button"
            className="underline underline-offset-2 transition-colors hover:opacity-85"
            style={{ color: "var(--reader-accent)" }}
            onClick={() => onOpenExternal(url)}
            title={url}
          >
            {label}
          </button>
        );
      } else {
        nodes.push(
          <a
            key={`${keyPrefix}-link-${start}`}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 transition-colors hover:opacity-85"
            style={{ color: "var(--reader-accent)" }}
            title={url}
          >
            {label}
          </a>
        );
      }
    }

    cursor = start + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(<span key={`${keyPrefix}-tail`}>{text.slice(cursor)}</span>);
  }

  return nodes;
}

export function MarkdownViewer({
  title,
  filePath,
  content,
  language,
  onOpenExternal,
  onContentChange,
  onSave,
}: MarkdownViewerProps) {
  const [isOutlineOpen, setIsOutlineOpen] = useState(true);
  const [mode, setMode] = useState<ViewMode>("split");
  const [draft, setDraft] = useState(content);
  const [savedContent, setSavedContent] = useState(content);
  const [isSaving, setIsSaving] = useState(false);
  const [statusHint, setStatusHint] = useState("");
  const headingRefMap = useRef<Map<string, HTMLHeadingElement>>(new Map());
  const currentPathRef = useRef<string | undefined>(filePath);
  const t = I18N[language];

  useEffect(() => {
    const changedFile = currentPathRef.current !== filePath;
    if (changedFile) {
      currentPathRef.current = filePath;
      setDraft(content);
      setSavedContent(content);
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

  const blocks = useMemo(() => {
    const lines = draft.split(/\r?\n/);
    const rendered: ReactNode[] = [];
    let inCode = false;
    let codeLines: string[] = [];
    let headingIndex = 0;

    const flushCode = (key: string) => {
      if (codeLines.length === 0) return;
      rendered.push(
        <pre
          key={key}
          className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-4 overflow-x-auto text-sm leading-6 font-mono text-gray-700 dark:text-gray-200"
        >
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      codeLines = [];
    };

    lines.forEach((line, index) => {
      if (/^```/.test(line.trim())) {
        if (inCode) {
          flushCode(`code-${index}`);
          inCode = false;
        } else {
          inCode = true;
        }
        return;
      }

      if (inCode) {
        codeLines.push(line);
        return;
      }

      const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (heading) {
        headingIndex += 1;
        const level = Math.min(6, heading[1].length);
        const text = heading[2];
        const id = slugify(text, headingIndex);
        const className =
          level <= 2
            ? "text-2xl font-semibold tracking-tight mt-6"
            : level === 3
              ? "text-xl font-semibold tracking-tight mt-5"
              : "text-lg font-semibold tracking-tight mt-4";
        rendered.push(
          <h2
            key={`heading-${index}`}
            id={id}
            ref={(node) => {
              if (node) headingRefMap.current.set(id, node);
              else headingRefMap.current.delete(id);
            }}
            className={`text-gray-900 dark:text-gray-100 ${className}`}
          >
            {renderInline(text, `h-${index}`, onOpenExternal)}
          </h2>
        );
        return;
      }

      const list = /^\s*[-*]\s+(.+)$/.exec(line);
      if (list) {
        rendered.push(
          <li key={`li-${index}`} className="ml-5 list-disc text-gray-700 dark:text-gray-300 leading-7">
            {renderInline(list[1], `li-${index}`, onOpenExternal)}
          </li>
        );
        return;
      }

      if (!line.trim()) {
        rendered.push(<div key={`space-${index}`} className="h-2" />);
        return;
      }

      rendered.push(
        <p key={`p-${index}`} className="text-gray-700 dark:text-gray-300 leading-7">
          {renderInline(line, `p-${index}`, onOpenExternal)}
        </p>
      );
    });

    if (inCode) {
      flushCode("code-final");
    }

    return rendered;
  }, [draft, onOpenExternal]);

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
    <div className="h-full overflow-auto bg-zinc-50 dark:bg-zinc-950">
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

  const renderEditorPane = () => (
    <div className="h-full p-4 bg-zinc-50 dark:bg-zinc-950">
      <textarea
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          onContentChange?.(next);
        }}
        className="h-full w-full rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 text-sm leading-6 font-mono text-gray-800 dark:text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--reader-accent)]"
        spellCheck={false}
      />
    </div>
  );

  return (
    <div className="flex h-full bg-zinc-50 dark:bg-zinc-950 text-gray-900 dark:text-gray-100 overflow-hidden">
      <div
        className={`${isOutlineOpen ? "w-64" : "w-0"} transition-[width] duration-200 ease-out bg-white dark:bg-gray-900 border-r border-gray-100 dark:border-gray-800 hidden md:flex md:flex-col shrink-0 overflow-hidden`}
      >
        <div className="h-12 flex items-center px-4 border-b border-gray-100 dark:border-gray-800 text-sm font-semibold tracking-tight">
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
        <div className="h-14 bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between px-4 shrink-0 shadow-sm">
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
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" }}
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

            {statusHint ? <span className="text-xs" style={{ color: "var(--reader-accent)" }}>{statusHint}</span> : null}
          </div>
        </div>

        <div className="flex-1 min-h-0">
          {mode === "preview" ? renderPreviewPane() : null}
          {mode === "edit" ? renderEditorPane() : null}
          {mode === "split" ? (
            <div className="h-full grid grid-cols-1 lg:grid-cols-2">
              <div className="border-b lg:border-b-0 lg:border-r border-gray-200 dark:border-gray-800">{renderEditorPane()}</div>
              {renderPreviewPane()}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
