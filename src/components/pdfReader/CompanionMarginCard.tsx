import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Send, Sparkles, Square } from "lucide-react";
import {
  READING_ASSIST_MAX_QUESTION_CHARS,
  askReadingAssistant,
  isModelEndpointConfigured,
  type LlmServiceConfig,
} from "../../services/readingAssistant";
import type { ReaderAnnotation } from "../../types";

/**
 * 伴读批注卡（margin note 形态，2026-10-09）。
 *
 * ## 为什么不再是浮动气泡
 *
 * 浮动气泡一次只能有一个、要靠滚动跟随逻辑才能不与所指段落脱开，
 * 而跟随链路的每一步（scroll 监听 → state → 派生定位 → 视口钳制）都是
 * 脱锚的候选故障点（实测「侧栏开合后气泡钉在旧坐标」）。批注卡直接挂在
 * 页面两侧的批注栏里，随文档自然滚动 —— **不存在跟随问题，因为不需要跟随**。
 * 多个块各挂各的卡，天然可同时存在。
 *
 * ## 自包含的边界
 *
 * 卡片自带提问流（展开解释 = 直接把模型给的疑问问出去；追问 = 开输入框），
 * 不依赖全局的单例气泡状态。代价是这段 ask 逻辑与 ReadingAssistMenu 的
 * handleAsk 形似 —— 但两者的生命周期完全不同（卡随标注生灭、菜单随划词
 * 生灭），强行抽公共 hook 会让两套状态机互相拖拽，不合算。
 */

const STRINGS = {
  "zh-CN": {
    title: "伴读",
    expand: "展开解释",
    followUp: "追问",
    dismiss: "暂不提示",
    yourQuestion: "你的追问",
    ask: "提问",
    stop: "停止",
    asking: "正在思考…",
    askFailed: "提问失败",
    cancelled: "已取消",
    timedOut: "请求超时",
    emptyQuestion: "先写下一个问题",
    expandSeed: "请展开解释这段话：它的含义、依据与论证逻辑。",
    continuePlaceholder: "继续追问…",
  },
  "en-US": {
    title: "Companion",
    expand: "Explain more",
    followUp: "Follow up",
    dismiss: "Not now",
    yourQuestion: "Your question",
    ask: "Ask",
    stop: "Stop",
    asking: "Thinking…",
    askFailed: "Ask failed",
    cancelled: "Cancelled",
    timedOut: "Timed out",
    emptyQuestion: "Write a question first",
    expandSeed: "Explain this passage in depth: its meaning, evidence, and reasoning.",
    continuePlaceholder: "Keep asking…",
  },
} as const;

export interface CompanionMarginCardProps {
  annotation: ReaderAnnotation;
  /** 标注所指块的正文的完整文本，作为提问的 excerpt。 */
  blockText: string;
  /** 外部唤出（锚点 / 工具栏）命中的那张卡：展开并自动发问一次。 */
  active: boolean;
  modelConfig: LlmServiceConfig;
  language: "zh-CN" | "en-US";
  /** 批注栏内的绝对定位（top / left / right / width），由摆放层算好传入。 */
  style?: CSSProperties;
  onDismissCompanion: (annotation: ReaderAnnotation) => void;
  onAnswer: (annotation: ReaderAnnotation, question: string, answer: string) => void;
}

export function CompanionMarginCard({
  annotation,
  blockText,
  active,
  modelConfig,
  language,
  style,
  onDismissCompanion,
  onAnswer,
}: CompanionMarginCardProps) {
  const t = STRINGS[language];
  const [expanded, setExpanded] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const askAbortRef = useRef<AbortController | null>(null);
  /** 每次外部激活只自动发问一次；读者手动追问不受此限。 */
  const autoAskedRef = useRef(false);

  const canAsk = isModelEndpointConfigured(modelConfig);
  const seedQuestion = annotation.content || t.expandSeed;

  const handleAsk = async (overrideQuestion?: string) => {
    // overrideQuestion：自动发起路径用的 —— setState 异步，同轮读不到刚 set 的值。
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
        excerpt: blockText,
        question: trimmed,
        reference: `${t.title} / page ${annotation.page}`,
        signal: controller.signal,
      });
      if (controller.signal.aborted || askAbortRef.current !== controller) return;
      setAnswer(result.answer);
      setStatus("");
      onAnswer(annotation, trimmed, result.answer);
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

  // 外部唤出（点锚点 / 工具栏）：展开 + 自动把模型的疑问问出去。
  // 与浮动气泡时代的语义一致 —— 显式请求不该让读者再点一次。
  useEffect(() => {
    if (!active || autoAskedRef.current) return;
    autoAskedRef.current = true;
    setExpanded(true);
    setQuestion(seedQuestion);
    if (canAsk) void handleAsk(seedQuestion);
    // 只响应 active 的到来；handleAsk/canAsk 变化不应重触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // 卸载时收掉在途请求（卡随标注删除而卸载，「暂不提示」后不应还有 setState）。
  useEffect(() => () => askAbortRef.current?.abort(), []);

  return (
    <div
      data-margin-card-id={annotation.id}
      data-companion-margin-card="true"
      data-active={active ? "true" : "false"}
      style={style}
      className={`companion-margin-card pdf-flow-ui-chrome absolute z-30 rounded-xl border px-3 py-2.5 shadow-sm backdrop-blur-sm transition-colors ${
        active
          ? "border-accent/60 bg-surface-panel"
          : "border-border-subtle bg-surface-panel/95 hover:border-accent/40"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-content-secondary">
          <Sparkles size={13} className="text-accent" />
          {t.title}
        </span>
        {/* 主动行为自报理由：title 承载全文，悬停展开（与旧气泡同一权重设计）。 */}
        {annotation.reason ? (
          <span
            data-margin-card-why="true"
            className="cursor-help text-[11px] text-content-muted underline decoration-dotted underline-offset-2"
            title={annotation.reason}
          >
            为什么出现
          </span>
        ) : null}
      </div>
      <p data-margin-card-question={annotation.id} className="mt-1.5 line-clamp-4 text-[12.5px] leading-relaxed text-content-primary">{seedQuestion}</p>
      {expanded ? (
        <div className="mt-2 border-t border-border-subtle pt-2">
          <div className="text-[11px] font-medium text-content-muted">{t.yourQuestion}</div>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            className="reading-assist-question compact mt-1 text-[12px]"
            maxLength={READING_ASSIST_MAX_QUESTION_CHARS}
            placeholder={t.continuePlaceholder}
            rows={2}
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1 truncate text-[11px] text-content-muted">{status}</div>
            {isAsking ? (
              <button
                type="button"
                className="reading-assist-submit secondary shrink-0"
                onClick={() => askAbortRef.current?.abort()}
              >
                <Square size={11} />
                {t.stop}
              </button>
            ) : (
              <button
                type="button"
                className="reading-assist-submit shrink-0"
                disabled={!canAsk}
                onClick={() => void handleAsk()}
              >
                <Send size={11} />
                {t.ask}
              </button>
            )}
            {/* 展开态也要保留「暂不提示」—— 读者看完解释后同样可能决定不再被打扰。 */}
            <button
              type="button"
              className="shrink-0 text-[11px] text-content-muted transition-colors hover:text-content-secondary"
              onClick={() => onDismissCompanion(annotation)}
            >
              {t.dismiss}
            </button>
          </div>
          {answer ? (
            <div className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-content-secondary">
              {answer}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            className="rounded-md bg-content-primary px-2 py-1 text-[11px] font-semibold text-content-inverse transition-colors hover:opacity-85"
            onClick={() => {
              // 展开解释 = 把模型的疑问直接问出去（与旧气泡同一分工：
              // 一个给答案，一个给话筒）。
              setExpanded(true);
              setQuestion(seedQuestion);
              if (canAsk) void handleAsk(seedQuestion);
            }}
          >
            {t.expand}
          </button>
          <button
            type="button"
            className="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-content-secondary transition-colors hover:bg-surface-hover"
            onClick={() => {
              setExpanded(true);
              setQuestion((current) => current || "");
            }}
          >
            {t.followUp}
          </button>
          <button
            type="button"
            className="ml-auto text-[11px] text-content-muted transition-colors hover:text-content-secondary"
            onClick={() => onDismissCompanion(annotation)}
          >
            {t.dismiss}
          </button>
        </div>
      )}
    </div>
  );
}
