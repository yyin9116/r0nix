import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Copy, Languages, MessageSquare, Quote, Send, Sparkles, Square, X } from "lucide-react";
import {
  READING_ASSIST_MAX_EXCERPT_CHARS,
  READING_ASSIST_MAX_QUESTION_CHARS,
  askReadingAssistant,
  isModelEndpointConfigured,
  type LlmServiceConfig,
} from "../services/readingAssistant";
import type { AppLanguage } from "../services/userSettings";
import type { ReaderAnnotationRect } from "../types";
import "./ReadingAssistMenu.css";

export interface ReadingAssistSelection {
  id: string;
  text: string;
  reference: string;
  sourceTitle: string;
  x: number;
  y: number;
  blockId?: string;
  sourceRect?: ReaderAnnotationRect;
}

interface ReadingAssistMenuProps {
  selection: ReadingAssistSelection | null;
  language: AppLanguage;
  modelConfig: LlmServiceConfig;
  onClose: () => void;
  onHint?: (message: string) => void;
  onTranslate?: (selection: ReadingAssistSelection) => void;
  onSaveQuote?: (selection: ReadingAssistSelection, quote: string) => void;
  variant?: "panel" | "inline-toolbar";
}

const I18N = {
  "zh-CN": {
    title: "阅读辅助",
    copy: "复制",
    quote: "引用",
    ask: "提问",
    askAi: "问问 AI",
    translate: "翻译",
    close: "关闭",
    questionPlaceholder: "针对选中段落提问...",
    copied: "已复制段落",
    quoted: "引用已复制",
    askReady: "配置模型服务后可直接提问",
    endpointMissing: "请在设置中填写 HTTP(S) 模型服务地址",
    asking: "正在提问...",
    askFailed: "提问失败",
    stop: "停止",
    copyAnswer: "复制回答",
    answerCopied: "回答已复制",
    presetSummary: "概括",
    presetTerms: "术语",
    presetQuestion: "延伸问题",
    emptyQuestion: "请输入问题",
    cancelled: "提问已取消",
    timedOut: "模型服务请求超时",
    privacyHint: "提问会发送选中段落、引用位置和问题到已配置的模型服务。",
    truncated: `摘录会限制在 ${READING_ASSIST_MAX_EXCERPT_CHARS} 个字符内。`,
  },
  "en-US": {
    title: "Reading Assist",
    copy: "Copy",
    quote: "Quote",
    ask: "Ask",
    askAi: "Ask AI",
    translate: "Translate",
    close: "Close",
    questionPlaceholder: "Ask about the selected paragraph...",
    copied: "Paragraph copied",
    quoted: "Citation copied",
    askReady: "Configure a model endpoint to ask directly",
    endpointMissing: "Configure an HTTP(S) model endpoint in Settings",
    asking: "Asking...",
    askFailed: "Ask failed",
    stop: "Stop",
    copyAnswer: "Copy answer",
    answerCopied: "Answer copied",
    presetSummary: "Summarize",
    presetTerms: "Terms",
    presetQuestion: "Follow-ups",
    emptyQuestion: "Enter a question",
    cancelled: "Ask cancelled",
    timedOut: "Model service request timed out",
    privacyHint: "Asking sends the selected paragraph, reference, and question to your configured model service.",
    truncated: `Excerpt is capped at ${READING_ASSIST_MAX_EXCERPT_CHARS} characters.`,
  },
} as const;

function clampMenuPosition(x: number, y: number) {
  if (typeof window === "undefined") return { left: x, top: y };
  return {
    left: Math.max(12, Math.min(window.innerWidth - 372, x)),
    top: Math.max(12, Math.min(window.innerHeight - 420, y)),
  };
}

function clampToolbarPosition(x: number, y: number, expanded: boolean) {
  if (typeof window === "undefined") return { left: x, top: y };
  const width = expanded ? 390 : 300;
  const height = expanded ? 260 : 48;
  return {
    left: Math.max(12, Math.min(window.innerWidth - width - 12, x - width / 2)),
    top: Math.max(12, Math.min(window.innerHeight - height - 12, y)),
  };
}

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

export function ReadingAssistMenu({ selection, language, modelConfig, onClose, onHint, onTranslate, onSaveQuote, variant = "panel" }: ReadingAssistMenuProps) {
  const t = I18N[language];
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [position, setPosition] = useState(() => (selection ? clampMenuPosition(selection.x, selection.y) : { left: 0, top: 0 }));
  const menuRef = useRef<HTMLDivElement | null>(null);
  const askAbortRef = useRef<AbortController | null>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

  useEffect(() => {
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    setQuestion("");
    setAnswer("");
    setStatus("");
    setIsExpanded(false);
    if (selection) setPosition(variant === "inline-toolbar" ? clampToolbarPosition(selection.x, selection.y, false) : clampMenuPosition(selection.x, selection.y));
  }, [selection?.id, variant]);

  useEffect(() => {
    return () => askAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!selection) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        askAbortRef.current?.abort();
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      askAbortRef.current?.abort();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose, selection]);

  const canAsk = isModelEndpointConfigured(modelConfig);
  const presets =
    language === "zh-CN"
      ? [
          { label: t.presetSummary, value: "用 3 条要点概括这段内容，并指出最重要的结论。" },
          { label: t.presetTerms, value: "解释这段中的关键术语、缩写和方法名。" },
          { label: t.presetQuestion, value: "基于这段内容，列出 3 个值得继续追问的问题。" },
        ]
      : [
          { label: t.presetSummary, value: "Summarize this excerpt in 3 bullets and identify the key takeaway." },
          { label: t.presetTerms, value: "Explain the key terms, abbreviations, and method names in this excerpt." },
          { label: t.presetQuestion, value: "List 3 useful follow-up questions based on this excerpt." },
        ];

  if (!selection) return null;

  const quoteText = `> ${selection.text.replace(/\n+/g, "\n> ")}\n\n— ${selection.sourceTitle}, ${selection.reference}`;

  const closeMenu = () => {
    askAbortRef.current?.abort();
    onClose();
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - position.left,
      offsetY: event.clientY - position.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition(clampMenuPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY));
    event.preventDefault();
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleCopy = async () => {
    try {
      await copyText(selection.text);
      onHint?.(t.copied);
    } catch {
      onHint?.("Clipboard unavailable");
    }
  };

  const handleQuote = async () => {
    try {
      await copyText(quoteText);
      onSaveQuote?.(selection, quoteText);
      onHint?.(t.quoted);
    } catch {
      onHint?.("Clipboard unavailable");
    }
  };

  const expandWithQuestion = (value?: string) => {
    if (value) setQuestion(value);
    setIsExpanded(true);
    setPosition(clampToolbarPosition(selection.x, selection.y, true));
  };

  const handleAsk = async () => {
    const trimmed = question.trim();
    if (!trimmed) {
      setStatus(t.emptyQuestion);
      return;
    }
    askAbortRef.current?.abort();
    const controller = new AbortController();
    askAbortRef.current = controller;
    setIsAsking(true);
    setAnswer("");
    setStatus(t.asking);
    try {
      const result = await askReadingAssistant({
        config: modelConfig,
        excerpt: selection.text,
        question: trimmed,
        reference: `${selection.sourceTitle} / ${selection.reference}`,
        signal: controller.signal,
      });
      setAnswer(result.answer);
      setStatus("");
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        const message = reason instanceof Error ? reason.message : String(reason || "");
        setStatus(message.includes("超时") ? t.timedOut : t.cancelled);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`${t.askFailed}: ${message}`);
    } finally {
      if (askAbortRef.current === controller) {
        askAbortRef.current = null;
      }
      setIsAsking(false);
    }
  };

  if (variant === "inline-toolbar") {
    return (
      <div
        ref={menuRef}
        className={`reading-assist-toolbar ${isExpanded || answer || status ? "expanded" : ""}`}
        style={{ left: position.left, top: position.top }}
      >
        <div className="reading-assist-toolbar-row">
          <button type="button" className="reading-assist-toolbar-action" onClick={() => expandWithQuestion(presets[1]?.value)}>
            <Quote size={15} />
            {language === "zh-CN" ? "解释" : "Explain"}
          </button>
          {onTranslate ? (
            <button type="button" className="reading-assist-toolbar-action" onClick={() => onTranslate(selection)}>
              <Languages size={15} />
              {t.translate}
            </button>
          ) : null}
          <button type="button" className="reading-assist-toolbar-action" onClick={() => void handleCopy()}>
            <Copy size={15} />
            {t.copy}
          </button>
          <button type="button" className="reading-assist-toolbar-action" onClick={() => expandWithQuestion()}>
            <MessageSquare size={15} />
            {t.askAi}
          </button>
        </div>

        {isExpanded || answer || status ? (
          <div className="reading-assist-toolbar-panel">
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              className="reading-assist-question compact"
              maxLength={READING_ASSIST_MAX_QUESTION_CHARS}
              placeholder={t.questionPlaceholder}
              autoFocus
            />
            <div className="reading-assist-presets compact" aria-label={language === "zh-CN" ? "快捷问题" : "Prompt presets"}>
              {presets.map((preset) => (
                <button key={preset.label} type="button" onClick={() => setQuestion(preset.value)}>
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="reading-assist-submit-row">
              <div className="reading-assist-status">{status || (!canAsk ? t.askReady : "")}</div>
              {isAsking ? (
                <button type="button" className="reading-assist-submit secondary" onClick={() => askAbortRef.current?.abort()}>
                  <Square size={12} />
                  {t.stop}
                </button>
              ) : (
                <button type="button" className="reading-assist-submit" disabled={!canAsk} onClick={() => void handleAsk()}>
                  <Send size={13} />
                  {t.ask}
                </button>
              )}
            </div>
            {answer ? (
              <div className="reading-assist-answer compact">
                {answer}
                <button
                  type="button"
                  className="reading-assist-copy-answer compact"
                  onClick={() => {
                    void copyText(answer).then(() => onHint?.(t.answerCopied));
                  }}
                >
                  <Copy size={12} />
                  {t.copyAnswer}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={menuRef} className="reading-assist-menu" style={{ left: position.left, top: position.top }}>
      <div
        className="reading-assist-menu-header"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="min-w-0">
          <div className="reading-assist-menu-title">
            <Sparkles size={13} className="inline mr-1.5" />
            {t.title}
          </div>
          <div className="reading-assist-menu-ref">{selection.reference}</div>
        </div>
        <button
          type="button"
          className="reading-assist-close"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          title={t.close}
          aria-label={t.close}
        >
          <X size={15} />
        </button>
      </div>

      <div className="reading-assist-excerpt">{selection.text}</div>

      <div className="reading-assist-actions">
        <button type="button" className="reading-assist-action" onClick={() => void handleCopy()}>
          <Copy size={13} />
          {t.copy}
        </button>
        <button type="button" className="reading-assist-action" onClick={() => void handleQuote()}>
          <Quote size={13} />
          {t.quote}
        </button>
        {onTranslate ? (
          <button type="button" className="reading-assist-action" onClick={() => onTranslate(selection)}>
            <Languages size={13} />
            {t.translate}
          </button>
        ) : null}
      </div>

      <div className="reading-assist-ask">
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          className="reading-assist-question"
          maxLength={READING_ASSIST_MAX_QUESTION_CHARS}
          placeholder={t.questionPlaceholder}
        />
        <div className="reading-assist-privacy">
          {t.privacyHint}
          {selection.text.length > READING_ASSIST_MAX_EXCERPT_CHARS ? ` ${t.truncated}` : ""}
        </div>
        <div className="reading-assist-presets" aria-label={language === "zh-CN" ? "快捷问题" : "Prompt presets"}>
          {presets.map((preset) => (
            <button key={preset.label} type="button" onClick={() => setQuestion(preset.value)}>
              {preset.label}
            </button>
          ))}
        </div>
        <div className="reading-assist-submit-row">
          <div className="reading-assist-status">{status || (!canAsk ? t.askReady : "")}</div>
          {isAsking ? (
            <button type="button" className="reading-assist-submit secondary" onClick={() => askAbortRef.current?.abort()}>
              <Square size={12} />
              {t.stop}
            </button>
          ) : (
            <button type="button" className="reading-assist-submit" disabled={!canAsk} onClick={() => void handleAsk()}>
              <Send size={13} />
              {t.ask}
            </button>
          )}
        </div>
      </div>

      {answer ? (
        <div className="reading-assist-answer-wrap">
          <div className="reading-assist-answer">{answer}</div>
          <button
            type="button"
            className="reading-assist-copy-answer"
            onClick={() => {
              void copyText(answer).then(() => onHint?.(t.answerCopied));
            }}
          >
            <Copy size={12} />
            {t.copyAnswer}
          </button>
        </div>
      ) : null}
    </div>
  );
}
