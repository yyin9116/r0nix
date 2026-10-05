/**
 * 规则级样式探针（rules probe）
 * ---------------------------------------------------------------------------
 * 解决的问题：整页快照（snapshot.mjs）只能采到**当前挂载视图**的节点。
 * 而设计系统里大量规则属于「样式已定义、但此刻不在 DOM 里」—— 首页卡片、
 * PDF 状态栏、快照浮层、白板调色板…… 改这些规则时，快照给你的是「零差异」，
 * 一个假的安全感。
 *
 * 做法：起 dist 静态服务器 → 用真实应用加载真实 CSS/令牌 → 在页面里注入一批
 * 只带目标 class 的最小元素 → 读计算样式 → 与 JSON 里的期望值逐项比对。
 *
 * 为什么元素要注入到真实应用里、而不是自己拼一个 HTML：设计令牌（--surface-*、
 * --content-*、--reader-accent）全部定义在 :root 上、其中一部分由 App 在运行时写入
 * documentElement。离线拼的 HTML 拿不到这些变量，量到的会是兜底值。
 *
 * 用法：
 *   node scripts/design-diff/probe.mjs <cases.json>
 *   node scripts/design-diff/probe.mjs --dump <cases.json>     # 只打印实测值，不判定
 *
 * cases.json 结构（两种模式可同时存在）：
 * {
 *   "props": ["backgroundColor", "color", "borderTopColor"],
 *
 *   // 模式 A —— 断言：某个 class 的实际值必须等于期望值
 *   "targets": [
 *     { "label": "首页主卡片", "class": "home-hero-card",
 *       "expect": { "light": { "backgroundColor": "rgb(255, 255, 255)" },
 *                   "dark":  { "backgroundColor": "rgb(24, 24, 27)" } } },
 *     { "label": "地址栏按钮", "html": "<div class=\"home-address-bar\"><button>x</button></div>",
 *       "pick": "button", "expect": { ... } }               // 后代选择器类目标
 *   ],
 *
 *   // 模式 B —— 等价性：把「a → b 这处迁移是否等价」变成可执行断言
 *   "comparisons": [
 *     { "label": "菜单面板描边",
 *       "before": "border border-zinc-200 dark:border-zinc-800",
 *       "after":  "border border-border-subtle",
 *       "props": ["borderTopColor"] }
 *   ]
 * }
 * expect 里没写的状态/属性不判定，只打印。
 * comparisons 会做颜色归一化（Tailwind v4 出 oklch、令牌出 rgb，同色异写会造成假 DRIFT）。
 * 伪类（hover: / focus:）不覆盖 —— getComputedStyle 读不到未激活的伪类。
 * 但这不构成盲区：伪类只加「激活条件」、不改声明值，所以比较**去掉伪类前缀**的等价类
 * （用 `bg-surface-hover` 对 `bg-zinc-200 dark:bg-zinc-800`）就能证明 `hover:` 那处等价。
 *
 * ★ acceptedDrift —— 「已审阅位移」
 * 收敛中间档（zinc-400/500/600/800 这些令牌层没有对应值的档位）必然产生位移。
 * 这类位移一旦经人确认，就在用例里标记 acceptedDrift：探针**照样把它打印成 Δ**，
 * 只是不再让门禁失败。为什么要打印而不是删掉 —— 它记录了「这里视觉变过、变多少、
 * 是哪个决定造成的」，这个信息在半年后比「测试是绿的」值钱得多。
 * 反过来，**没标记的 DRIFT 一律视为回归**，门禁必须红。
 *
 * 前置：需要先 `npx vite build`；本机需有 Chrome。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const DIST = path.resolve("dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const argv = process.argv.slice(2);
const dumpOnly = argv.includes("--dump");
const casesPath = argv.find((a) => !a.startsWith("--"));
if (!casesPath) {
  console.error("用法：node scripts/design-diff/probe.mjs [--dump] <cases.json>");
  process.exit(2);
}
// 用例文件先自己校验一次 JSON。
// 为什么：JSON.parse 的异常会让进程直接崩掉，栈里的最后一行永远是
// 「Node.js v22.x」—— 被 probe-all 摘出来当摘要时，真正的原因
// （第几行缺逗号）反而看不见了。自己接住，只打一行。
let cases;
try {
  cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
} catch (err) {
  console.error(`探针失败：用例不是合法 JSON — ${path.relative(process.cwd(), casesPath)}`);
  console.error(`  ${err.message}`);
  process.exit(2);
}
const PROPS = cases.props ?? ["backgroundColor", "color", "borderTopColor", "borderTopWidth"];
const COMPARISONS = cases.comparisons ?? [];

/**
 * 全部 CSS chunk 的内容。
 * ---------------------------------------------------------------------------
 * 为什么必须全量注入：vite 按组件做了 code splitting，`PDFViewer.css` 之类的样式表
 * 是**懒加载 chunk**（产物形如 `assets/PDFViewer-<hash>.css`），只有对应组件被渲染时
 * 才会插入页面。探针注的是游离元素，不会触发任何组件的加载 —— 于是目标 class
 * 一条规则都命中不了，量到的全是 `rgba(0, 0, 0, 0)` 这种「看起来像没生效」的噪声，
 * 而它其实是「CSS 压根不在页面上」。
 * （第一次跑就是这样：10 个目标全部 FAIL 且值都是透明黑。）
 */
const ASSETS = path.join(DIST, "assets");
const ALL_CSS = fs
  .readdirSync(ASSETS)
  .filter((f) => f.endsWith(".css"))
  .sort()
  .map((f) => fs.readFileSync(path.join(ASSETS, f), "utf8"))
  .join("\n");

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(DIST, p);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
// 端口交给系统分配，不写死。
// 为什么：probe-all.mjs 会串行调用多个用例，上一个进程刚退出时它的监听端口
// 还没被内核释放，写死端口会在下一个用例上撞 EADDRINUSE —— 表现为
// 「单独跑是绿的、串起来跑就崩」，极难定位。临时端口从根上消除这类竞态。
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const measured = {};
let failures = 0;
let drift = 0;
let accepted = 0;

for (const theme of ["light", "dark"]) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.addInitScript((mode) => {
    localStorage.setItem(
      "pdf_reader_user_settings_v2",
      JSON.stringify({
        version: 3,
        updatedAt: new Date().toISOString(),
        data: { themeMode: mode, themeAccent: "zinc", language: "zh-CN" },
      }),
    );
  }, theme);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
  await page.waitForTimeout(2200);
  // 补齐懒加载的 CSS chunk（见上方 ALL_CSS 的说明）
  await page.addStyleTag({ content: ALL_CSS });

  // 确认应用真的落在目标主题上，否则后面的判定全部无效
  const applied = await page.evaluate(() => ({
    dataTheme: document.documentElement.dataset.theme ?? null,
    darkClass: document.documentElement.classList.contains("dark"),
    panel: getComputedStyle(document.documentElement).getPropertyValue("--surface-panel").trim(),
  }));
  if (theme === "dark" && applied.dataTheme !== "dark" && !applied.darkClass) {
    console.error(`探针失败：期望深色主题，实际 data-theme=${applied.dataTheme} dark=${applied.darkClass}`);
    process.exit(1);
  }

  const rows = await page.evaluate(
    ({ targets, comparisons, props }) => {
      const host = document.createElement("div");
      host.setAttribute("data-probe-host", "");
      host.style.cssText = "position:fixed;left:-9999px;top:0;width:240px;pointer-events:none;display:flex;flex-direction:column;";
      document.body.appendChild(host);
      const out = [];
      /**
       * 颜色归一化。
       * Tailwind v4 的工具类产出 `oklch(...)` / `oklab(...)`，设计令牌产出 `rgb(...)` ——
       * 同一个颜色两种写法，直接比较会被假差异淹没。
       * 实测：第一次跑 9 处 DRIFT 里 8 处是这种噪声（`oklch(0.985 0 0)` 就是 `rgb(250,250,250)`，
       * 即 zinc-50 = --surface-app）。塞进 1×1 canvas 读回 sRGB 字节即可归一。
       * 只对颜色属性生效 —— `boxShadow` 这类复合值喂给 fillStyle 会静默失败。
       */
      const COLOR_PROPS = new Set([
        "backgroundColor", "color", "borderTopColor", "borderRightColor", "borderBottomColor",
        "borderLeftColor", "outlineColor", "fill", "stroke", "caretColor", "textDecorationColor",
      ]);
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const norm = (prop, value) => {
        if (!COLOR_PROPS.has(prop) || typeof value !== "string" || !value) return value;
        if (!/^(rgb|rgba|oklch|oklab|lab|lch|hsl|hsla|color|#)/i.test(value)) return value;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        // 输出保持与 getComputedStyle 同形的 rgb()/rgba() 写法，便于阅读与书写期望值
        return d[3] === 255
          ? `rgb(${d[0]}, ${d[1]}, ${d[2]})`
          : `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${(d[3] / 255).toFixed(3)})`;
      };
      const readNorm = (el, list) => {
        const cs = getComputedStyle(el);
        const vals = {};
        for (const p of list) vals[p] = norm(p, cs[p]);
        return vals;
      };
      for (const t of targets) {
        let el = null;
        if (t.html) {
          // 后代选择器类目标（如 `.home-address-bar button`）需要真实结构才命中
          host.innerHTML = t.html;
          el = t.pick ? host.querySelector(t.pick) : host.firstElementChild;
        } else {
          el = document.createElement("div");
          el.className = t.class;
          host.appendChild(el);
        }
        if (!el) {
          out.push({ kind: "target", label: t.label, source: t.html ?? t.class, values: null, missing: true });
          host.innerHTML = "";
          continue;
        }
        out.push({ kind: "target", label: t.label, source: t.html ?? t.class, values: readNorm(el, props) });
        host.innerHTML = "";
      }
      // 映射等价性：同一个属性在 before / after 两套 class 下的计算值。
      // 用途是把「a → b 这处迁移是否等价」变成可执行断言，而不是靠读代码推断。
      // 注意：伪类（hover: / focus:）不在此覆盖 —— getComputedStyle 读不到未激活的伪类。
      for (const c of comparisons) {
        host.innerHTML = "";
        const a = document.createElement("div");
        a.className = c.before ?? "";
        const b = document.createElement("div");
        b.className = c.after ?? "";
        host.append(a, b);
        const list = c.props ?? props;
        out.push({
          kind: "cmp",
          label: c.label,
          props: list,
          acceptedDrift: !!c.acceptedDrift,
          before: readNorm(a, list),
          after: readNorm(b, list),
        });
      }
      host.remove();
      return out;
    },
    { targets: cases.targets ?? [], comparisons: COMPARISONS, props: PROPS },
  );

  measured[theme] = rows;
  await context.close();
}

await browser.close();
server.close();

/* ---------- 输出 ---------- */
/**
 * 颜色的等价判定必须带容差，不能精确比对。
 * 原因：Tailwind v4 的 zinc 用 oklch 定义，转成 sRGB 后与令牌里手写的 hex 会差 1~2/255 ——
 * 实测 `oklch(0.37 0.013 285.805)` → `rgb(63,63,71)`，而令牌写死 `#3f3f46` = `rgb(63,63,70)`。
 * 两者是同一个「zinc-700」，差值来自 oklch 端点的舍入。
 * 判据：**单通道 ≤2/255、alpha ≤0.01 一律视为等价**（与 snapshot 管线的归一化结论一致）。
 */
const parseRgba = (v) => {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(String(v));
  return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
};
const sameValue = (x, y) => {
  if (x === y) return true;
  const a = parseRgba(x);
  const b = parseRgba(y);
  if (!a || !b) return false;
  return Math.abs(a.r - b.r) <= 2 && Math.abs(a.g - b.g) <= 2 && Math.abs(a.b - b.b) <= 2 && Math.abs(a.a - b.a) <= 0.01;
};

for (const theme of ["light", "dark"]) {
  console.log(`\n=== ${theme} ===`);
  for (const row of measured[theme]) {
    if (row.kind === "cmp") {
      const bad = row.props.filter((p) => !sameValue(row.before[p], row.after[p]));
      const detail = bad.length
        ? bad.map((p) => `${p}: ${row.before[p]} → ${row.after[p]}`).join("  ")
        : "等价";
      const mark = bad.length ? (row.acceptedDrift ? "Δ  " : "DRIFT") : " eq  ";
      if (bad.length) {
        if (row.acceptedDrift) accepted += 1;
        else drift += bad.length;
      }
      console.log(`  [${mark}] ${row.label.padEnd(22)} ${detail}`);
      continue;
    }
    if (row.missing) {
      console.log(`  [FAIL] ${row.label.padEnd(22)} 选择器未命中：${row.source}`);
      failures += 1;
      continue;
    }
    const expected = cases.targets.find((t) => t.label === row.label)?.expect?.[theme] ?? {};
    const diffs = [];
    for (const p of PROPS) {
      const want = expected[p];
      const got = row.values[p];
      if (want === undefined) {
        diffs.push(`${p}=${got}`);
      } else if (!sameValue(want, got)) {
        diffs.push(`${p}: 期望 ${want} / 实际 ${got}`);
        failures += 1;
      }
    }
    const mark = diffs.some((d) => d.includes("期望")) ? "FAIL" : " ok ";
    console.log(`  [${mark}] ${row.label.padEnd(22)} ${diffs.join("  ")}`);
  }
}

if (dumpOnly) {
  console.log("\n（--dump 模式，不做判定）");
  process.exit(0);
}
const parts = [];
if (failures) parts.push(`${failures} 项与期望不符`);
if (drift) parts.push(`${drift} 处未审阅的映射位移`);
if (accepted) parts.push(`${accepted} 处已审阅位移（Δ 标记，见用例 acceptedDrift）`);
console.log(parts.length ? `\nprobe: ${parts.join("，")}` : "\nprobe: 全部命中期望值，映射逐项等价");
process.exit(failures === 0 && drift === 0 ? 0 : 1);
