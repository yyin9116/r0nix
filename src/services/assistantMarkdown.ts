/**
 * AI 回答的最小 Markdown 渲染。
 *
 * 为什么不用 `marked.parse()` 直接出 HTML：模型输出属于**不可信输入**（提示注入
 * 可以让模型吐 `<script>` 或 `<img onerror>`），而 marked 从 v8 起不再内置消毒，
 * 项目也不打算为此引入 DOMPurify。所以这里的顺序是固定的：
 *
 *   1. 先把整段文本做 HTML 转义（所有 `< > & "` 都变成实体）；
 *   2. 再在**纯文本**之上做最小 Markdown 识别。
 *
 * 这样任何 HTML 注入在第 1 步就被打碎，第 2 步产出的标签全部由本文件生成，
 * 没有从输入直通 DOM 的路径。支持的语法刻意保持最小集 —— 回答气泡不是
 * Markdown 查看器（那套走 MarkdownViewer 的块级渲染）：标题、列表、代码、
 * 行内样式、安全链接。
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** 只接受 http(s) 链接，其余 scheme（javascript: 等）退化为纯文本。 */
function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  // 行内代码：先处理，代码内容不再参与后续替换。
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  // 粗体 / 斜体（代码之外的片段）。
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  // 链接：[text](url)。url 在转义后含 &amp; 等实体，href 原样保留实体是合法的。
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (match, label: string, url: string) =>
    isSafeUrl(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : match
  );
  return out;
}

/**
 * 把 AI 回答文本渲染成安全的 HTML 片段。
 * 纯函数、无 DOM 依赖，便于单测。
 */
export function renderAssistantMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: { lang: string; body: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${renderInline(paragraph.join("<br>"))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(list.ordered ? `<ol>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ol>` : `<ul>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
      list = null;
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      if (code) {
        html.push(`<pre><code${code.lang ? ` data-lang="${escapeHtml(code.lang)}"` : ""}>${escapeHtml(code.body.join("\n"))}</code></pre>`);
        code = null;
      } else {
        flushAll();
        code = { lang: fence[1] || "", body: [] };
      }
      continue;
    }
    if (code) {
      code.body.push(line);
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 2, 6); // 气泡里 h1 太大，从 h3 起
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushParagraph();
      const item = (bullet ? bullet[1] : ordered![1]).trim();
      if (!list || list.ordered !== Boolean(ordered)) {
        flushList();
        list = { ordered: Boolean(ordered), items: [] };
      }
      list.items.push(item);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  if (code) {
    // 未闭合的围栏：按代码块收尾，不丢内容。
    html.push(`<pre><code>${escapeHtml(code.body.join("\n"))}</code></pre>`);
  }
  flushAll();
  return html.join("");
}
