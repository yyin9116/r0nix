import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Copy, Languages, MessageSquare, Quote, Send, Sparkles, Square, X } from "lucide-react";import {
  READING_ASSIST_MAX_EXCERPT_CHARS,
  READING_ASSIST_MAX_QUESTION_CHARS,
  askReadingAssistant,
  isModelEndpointConfigured,
  type LlmServiceConfig,
} from "../services/readingAssistant";
import {
  clampOverlayPoint,
  resolveOverlayPoint,
  type OverlayPlacement,
  type OverlayPoint,
  type OverlaySize,
} from "../services/overlayPlacement";
import type { AppLanguage } from "../services/userSettings";
import { renderAssistantMarkdown } from "../services/assistantMarkdown";
import type { ReaderAnnotationRect } from "../types";
import "./ReadingAssistMenu.css";

export interface ReadingAssistSelection {
  id: string;
  text: string;
  reference: string;
  sourceTitle: string;
  x: number;
  y: number;
  /** 发出选区的页码。有了它 + sourceRect，气泡才能在滚动时重新锚定。 */
  page?: number;
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
  // 伴读提示卡已于 2026-10-09 迁往页侧批注卡（CompanionMarginCard）——
  // 本组件只剩划词 / 翻译流的浮层，不再承载伴读形态。
  /**
   * 提问成功后的结果上抛（问问 AI / 解释共用提问链路）。
   * 持久化在 PDFViewer 侧做 —— 本组件保持无存储职责。
   */
  onAnswer?: (payload: { question: string; answer: string }) => void;
  /**
   * 是否提供快捷提问与追问入口（settings.companionQuickAsk）。
   *
   * 关掉它**不等于关掉伴读**：提示本身还在，只是不挂提问入口。这两件事的
   * 打扰程度不同 —— 有人愿意被提示，但不想被一个输入框勾着走。
   */
  quickAskEnabled?: boolean;
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
    companionTitle: "伴读",
    companionWhy: "为什么出现",
    companionDismiss: "暂不提示",
    companionPending: "正在生成提示…",
    /** 态B 三个动作。顺序即降级梯度：主动作 → 次动作 → 纯文本。 */
    companionExpand: "展开解释",
    companionFollowUp: "追问",
    /** 脚注自报边界：主动提示必须让读者知道它不会无限出现。 */
    companionFootnote: "主动提示 · 每页最多 1 条",
    /** 点「追问」时预填的问题，让追问的起点落在模型那句疑问上。 */
    companionFollowUpSeed: "这句为什么这么说？",
    companionYourQuestion: "你的追问",
    companionAnswerLabel: "回答",
    companionContinuePlaceholder: "继续追问…",
    companionCiteFootnote: "回答可一键转为批注，保留出处",
    feedbackUseful: "有用",
    feedbackInaccurate: "不准确",
    feedbackCite: "引用到批注",
    feedbackThanks: "已记录",
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
    companionTitle: "Companion",
    companionWhy: "Why this",
    companionDismiss: "Not now",
    companionPending: "Thinking…",
    companionExpand: "Explain",
    companionFollowUp: "Ask more",
    companionFootnote: "Proactive hint · at most 1 per page",
    companionFollowUpSeed: "Why is this phrased that way?",
    companionYourQuestion: "Your question",
    companionAnswerLabel: "Answer",
    companionContinuePlaceholder: "Keep asking…",
    companionCiteFootnote: "Cite this answer as an annotation",
    feedbackUseful: "Useful",
    feedbackInaccurate: "Inaccurate",
    feedbackCite: "Cite",
    feedbackThanks: "Recorded",
  },
} as const;

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

export function ReadingAssistMenu({
  selection,
  language,
  modelConfig,
  onClose,
  onHint,
  onTranslate,
  onSaveQuote,
  variant = "panel",
  onAnswer,
  quickAskEnabled = true,
}: ReadingAssistMenuProps) {
  const t = I18N[language];
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  /** 选区锚点。位置不再由「锚点 + 写死的宽高」算出，而是等实测尺寸到手后合成。 */
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  /** 用户拖拽后的位置。为 null 表示跟随锚点。 */
  const [manual, setManual] = useState<OverlayPoint | null>(null);
  /** 实测尺寸。实测前为 null，第一帧由 useLayoutEffect 在 paint 之前补齐。 */
  const [measured, setMeasured] = useState<OverlaySize | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const askAbortRef = useRef<AbortController | null>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

  const placement: OverlayPlacement = variant === "inline-toolbar" ? "centered" : "top-left";

  // 位置是**派生值**，不是状态：尺寸一变（展开、回答流入、语言切换），钳制结果自动跟上。
  // 旧实现把位置存进 state，并在「展开之前」用常量估算钳制，尺寸真的变了就只能再算一次，
  // 因此始终落后于真实渲染尺寸 —— 而写死的高度没有任何 CSS 来源，根本无法同步。
  const position = useMemo<OverlayPoint>(() => {
    if (typeof window === "undefined") return { left: 0, top: 0 };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const size = measured ?? { width: 0, height: 0 };
    if (manual) return clampOverlayPoint(manual, size, viewport);
    return resolveOverlayPoint(anchor, size, placement, viewport);
  }, [anchor, manual, measured, placement]);

  // 尺寸只从 DOM 取。ResizeObserver 覆盖展开、回答流入、字体与语言变化等所有变形来源。
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setMeasured((previous) =>
        previous && Math.abs(previous.width - rect.width) < 0.5 && Math.abs(previous.height - rect.height) < 0.5
          ? previous
          : { width: rect.width, height: rect.height }
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selection?.id, variant]);

  useEffect(() => {
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    setIsAsking(false);
    setQuestion("");
    setAnswer("");
    setStatus("");
    setIsExpanded(false);
    setManual(null);
    setAnchor(selection ? { x: selection.x, y: selection.y } : null);
  }, [selection?.id, variant]);

  // 气泡跟着锚点走：锚点坐标是**派生自页面几何**的（见 PDFViewer 的滚动跟随），
  // 每次滚动都会变。只依赖 `selection?.id` 的话，位置会在第一次弹出时定死，
  // 一滚就与所指段落脱开。
  useEffect(() => {
    if (!selection) return;
    setAnchor({ x: selection.x, y: selection.y });
  }, [selection?.x, selection?.y]);

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
    // 只记原始落点，钳制交给派生的 position。若在这里就地钳制，
    // 越界拖拽会吃掉抓取偏移，手感变成「粘在边缘拽不动」。
    setManual({ left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY });
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
    // Saving a citation is a local product action and must not depend on the
    // platform clipboard permission succeeding in the same click.
    onSaveQuote?.(selection, quoteText);
    try {
      await copyText(quoteText);
      onHint?.(t.quoted);
    } catch {
      onHint?.(`${t.quoted}；剪贴板不可用`);
    }
  };

  const expandWithQuestion = (value?: string) => {
    if (value) setQuestion(value);
    setIsExpanded(true);
    // 回到锚点即可；变宽变高由 ResizeObserver + 派生的 position 自动处理。
    setManual(null);
  };

  const handleAsk = async (overrideQuestion?: string) => {
    // overrideQuestion：自动发起路径（「展开解释」）用的 —— setState 是异步的，
    // 调用方刚 setQuestion 的值在同一轮事件里还读不到，必须显式传入。
    const trimmed = (overrideQuestion ?? question).trim();
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
      if (controller.signal.aborted || askAbortRef.current !== controller) return;
      setAnswer(result.answer);
      setStatus("");
      onAnswer?.({ question: trimmed, answer: result.answer });
    } catch (error) {
      if (askAbortRef.current !== controller) return;
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
        setIsAsking(false);
      }
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
          {quickAskEnabled ? (
            <button type="button" className="reading-assist-toolbar-action" onClick={() => expandWithQuestion(presets[1]?.value)}>
              <Quote size={15} />
              {language === "zh-CN" ? "解释" : "Explain"}
            </button>
          ) : null}
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
          {quickAskEnabled ? (
            <button type="button" className="reading-assist-toolbar-action" onClick={() => expandWithQuestion()}>
              <MessageSquare size={15} />
              {t.askAi}
            </button>
          ) : null}
        </div>

        {/* 伴读提示卡已迁往页侧批注卡（CompanionMarginCard）；这里只剩划词工具行。 */}

        {isExpanded || answer || status ? (
          <div className="reading-assist-toolbar-panel">
            {/* 态 C 的对话区。设计稿要求「你的追问 / 回答」成对出现标签 ——
                对话卡里追问和回答在视觉上都是纯文本，没有标签时读者会分不清
                哪句是自己说的、哪句是模型回的，尤其在追问被预填了初稿之后。 */}
            <div className="reading-assist-question-block">
              <div className="reading-assist-turn-label">{t.companionYourQuestion}</div>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                className="reading-assist-question compact"
                maxLength={READING_ASSIST_MAX_QUESTION_CHARS}
                placeholder={t.questionPlaceholder}
                autoFocus
              />
            </div>
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
                <div className="reading-assist-turn-label">{t.companionAnswerLabel}</div>
                {/* renderAssistantMarkdown 先转义再识别语法，模型输出不可直通DOM（见服务内注释）。 */}
                <div className="reading-assist-answer-body" dangerouslySetInnerHTML={{ __html: renderAssistantMarkdown(answer) }} />
                {/* 反馈三项：伴读是主动行为，没有质量信号它就不知道自己该不该继续。
                    「引用到批注」把这次问答沉淀成正式批注，出处跟随 selection.reference ——
                    读者不必自己回忆这段话在哪一页。 */}
                <div className="reading-assist-feedback">
                  <button
                    type="button"
                    className="reading-assist-feedback-item"
                    onClick={() => onHint?.(t.feedbackThanks)}
                  >
                    {t.feedbackUseful}
                  </button>
                  <span className="reading-assist-feedback-sep" aria-hidden="true">·</span>
                  <button
                    type="button"
                    className="reading-assist-feedback-item"
                    onClick={() => onHint?.(t.feedbackThanks)}
                  >
                    {t.feedbackInaccurate}
                  </button>
                  <span className="reading-assist-feedback-sep" aria-hidden="true">·</span>
                  <button
                    type="button"
                    className="reading-assist-feedback-item"
                    onClick={() => onSaveQuote?.(selection, answer)}
                  >
                    {t.feedbackCite}
                  </button>
                </div>
                <div className="reading-assist-answer-footnote">{t.companionCiteFootnote}</div>
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
          <div className="reading-assist-answer">
            <div className="reading-assist-answer-body" dangerouslySetInnerHTML={{ __html: renderAssistantMarkdown(answer) }} />
          </div>
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
