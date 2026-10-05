/**
 * design-tokens-contract
 * ---------------------------------------------------------------------------
 * 阻止新的「绕过设计系统」的样式进入 src/。
 *
 * 规则：
 *   1. CSS 中不允许出现字面色值（#hex / rgb() / rgba() / white / black）。
 *      只豁免 src/tokens.css —— 它是唯一色源，字面量是它的本职。
 *      src/index.css 曾一并豁免，但审计发现它只定义字体、不定义颜色，
 *      那 4 处滚动条色值（#d4d4d8 / #3f3f46 / #a1a1aa / #52525b）其实
 *      就是描边两档的浅深四值，已改走 var(--border-default) / var(--border-strong)。
 *      豁免面越窄，盲区越小 —— 「豁免了一个文件」等于「这个文件不受约束」。
 *   2. TSX 中不允许使用非 zinc 的 Tailwind 调色板类（blue-600 / slate-500 …）。
 *      zinc 是唯一中性色阶；状态色必须走 --state-* 令牌。
 *   3. src 下的每个 .css 必须真的被某个模块 import。
 *      2026-10 的审计发现 7 个样式表（3477 行）零 import、从未进过构建，
 *      却一直在被守卫扫描、也一直在误导「迁移进度」的判断。此项为硬失败。
 *   4. TSX 中不允许出现「dark: + 中性色类」的配对（dark:bg-zinc-800 / dark:text-white …）。
 *      这类配对是「令牌化的中间态」—— 同一个语义写了两份值（浅色一份 + dark: 一份），
 *      正是深色漂移的温床。正确写法是用随主题自动翻转的语义令牌，把 dark: 配对整条删掉。
 *      2026-10 存量约 468 处，用独立基线棘轮收紧：每迁完一个文件就 --update-baseline。
 *      2026-10-04 全量归零（PDFViewer 214 处是最后一批）。
 *
 *   5. TSX / TS 中不允许出现任何中性色类（zinc / white / black），无论有没有 dark: 前缀。
 *      为什么比规则 4 更严：规则 4 只抓「配对」，而「只写一份值」是同一个病的另一种形态 ——
 *      一份值意味着浅深共用，必然在某一侧不成立。实测就抓到两处真缺陷：
 *        · 缩略图骨架 `bg-zinc-100` → 深色下是一块近白（#f4f4f5）的方块；
 *        · `text-white` 坐在 var(--reader-accent) 上 → 深色下强调色是 #f4f4f5，白字看不见。
 *      中性色必须走语义令牌（surface-* / content-* / border-*）。
 *      2026-10-04 迁完 PDFViewer 后全仓归零，故【不需要基线】，直接零容忍 —— 硬失败。
 *      未来若出现「刻意不随主题翻转」的白（如 PDF 纸面），正确做法是补一个语义令牌
 *      （见 tokens.css 的 --surface-paper），而不是在这里开豁免。
 *
 * 采用基线模式，避免一次性卡死既有代码：
 *   node scripts/check-design-tokens.mjs                   按基线比对，只对「新增违规」失败
 *   node scripts/check-design-tokens.mjs --report          只打印当前分布，不判失败
 *   node scripts/check-design-tokens.mjs --update-baseline 重新冻结基线（迁移推进后使用）
 *
 * 基线分两个独立的闸门（互不影响）：
 *   literalColors    — 规则 1 / 2，字面色值与非 zinc 调色板类。当前为 0（零容忍）。
 *   darkNeutralPairs — 规则 4，待令牌化的 dark: 配对。用棘轮逐步收紧。
 *   拆开是为了让「字面色值已归零」这个事实不会被 dark: 的大数字掩盖。
 * 规则 3（孤儿样式表）与规则 5（中性色类）不进基线，直接硬失败。
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const SRC = path.join(root, "src");
const BASELINE_PATH = path.join(root, "scripts/design-tokens-baseline.json");

// 令牌定义源：这里的字面量是合法的，它们就是「唯一色源」本身。
// 刻意只有一个文件 —— 每多豁免一个，就多一片无人约束的区域。
const TOKEN_SOURCES = new Set(["src/tokens.css"]);

// 规则 3 豁免：入口样式表由 main.tsx 引入，其余必须被模块 import
const ORPHAN_EXEMPT = new Set(["src/index.css"]);

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const RGB = /\brgba?\(\s*[0-9]/g;
// 关键字字面量：#fff 会被 HEX 抓到，但 white / black 不会 —— 单独计数。
// 注意 (?![\w-])：否则 white-space / black-list 这类属性名会被误判。
const COLOR_KEYWORD = /(?:^|[\s:,(])(?:white|black)(?![\w-])/g;
const PALETTE =
  /\b(?:slate|gray|neutral|stone|blue|indigo|sky|cyan|teal|emerald|green|lime|yellow|amber|orange|red|rose|violet|purple|fuchsia|pink)-\d{2,3}\b/g;

// 规则 4：dark: 变体下的中性色类。zinc / white / black 都该改走语义令牌，
// 让「dark: 配对」整条消失（令牌自身随主题翻转，不需要两份值）。
// 允许 dark: 之后还有别的变体前缀：dark:hover:bg-zinc-800 也要抓。
// 只认颜色工具类（bg/text/border/ring/…），避免把 dark:prose-invert 之类误判。
// zinc 的档位数（zinc-900）可有可无：Tailwind v4 里 bg-zinc 也合法。
const DARK_NEUTRAL =
  /\bdark:(?:[a-z-]+:)*(?:bg|text|border|ring|divide|outline|fill|stroke|placeholder|caret|accent|decoration|shadow|from|via|to)-(?:zinc(?:-\d{1,3})?|white|black)\b/g;

// 规则 5：任何中性色工具类，不管有没有 dark: 前缀。
// 判定方式是「先摘掉规则 4 已覆盖的 dark: 配对，再看还剩什么」—— 这样两条规则不重复计数，
// 也让「配对已归零」和「单值也已归零」两个事实各算各的。
const NEUTRAL_CLASS =
  /\b(?:bg|text|border|ring|divide|outline|fill|stroke|placeholder|caret|accent|decoration|shadow|from|via|to)-(?:zinc(?:-\d{1,3})?|white|black)(?:\/\d{1,3})?\b/g;

const args = new Set(process.argv.slice(2));
const reportOnly = args.has("--report");
const updateBaseline = args.has("--update-baseline");

function walk(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.test(entry.name)) out.push(full);
  }
  return out;
}

const countMatches = (text, pattern) => (text.match(pattern) || []).length;
const rel = (file) => path.relative(root, file).split(path.sep).join("/");

/**
 * 剥掉注释再计数。
 * ---------------------------------------------------------------------------
 * 为什么必须剥：注释里的色值不参与渲染，把它计入「绕过设计系统的样式」是语义错误。
 * 代价也很具体 —— 它会逼着人删掉注释里解释原因的色值。本仓库就发生过：
 * 为了压低基线，把「实测对比度 1.08:1」这类说明改写得不那么直白。
 * 而注释恰恰是最该写清楚色值的地方（「为什么这里不能用 white」正是靠色值说清的）。
 *
 * 只剥块注释与「行首」行注释：不碰行尾 `//`，因为字符串里的
 * `"http://…"` 与行尾注释无法用正则区分，保守起见留着（宁可多算，不可漏算）。
 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

/* ---------- 规则 3：孤儿样式表 ---------- */
const cssFiles = walk(SRC, /\.css$/);
const moduleFiles = walk(SRC, /\.(tsx?|jsx?|css)$/);
const importedCss = new Set();
for (const f of moduleFiles) {
  if (f.endsWith(".css") && !f.includes(`${path.sep}node_modules${path.sep}`)) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/@import\s+(?:url\()?["']([^"')]+)["']/g)) {
      const target = path.resolve(path.dirname(f), m[1]);
      importedCss.add(target);
    }
  }
  if (!f.endsWith(".css")) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/["'`]([^"'`]*\.css)["'`]/g)) {
      importedCss.add(path.resolve(path.dirname(f), m[1]));
    }
  }
}
const orphans = cssFiles.filter((f) => !ORPHAN_EXEMPT.has(rel(f)) && !importedCss.has(path.resolve(f)));

/* ---------- 规则 1 / 2：按文件计数 ---------- */
const violations = new Map();
for (const file of walk(SRC, /\.(css|tsx)$/)) {
  const r = rel(file);
  if (TOKEN_SOURCES.has(r)) continue;
  const text = stripComments(fs.readFileSync(file, "utf8"));
  const total = file.endsWith(".css")
    ? countMatches(text, HEX) + countMatches(text, RGB) + countMatches(text, COLOR_KEYWORD)
    : countMatches(text, PALETTE);
  if (total > 0) violations.set(r, total);
}

/* ---------- 规则 4：dark: + 中性色类配对 ---------- */
const darkPairs = new Map();
/* ---------- 规则 5：单值中性色类（摘掉 dark: 配对后仍残留的） ---------- */
const themeBlind = new Map();
for (const file of walk(SRC, /\.(tsx|ts)$/)) {
  const r = rel(file);
  if (TOKEN_SOURCES.has(r)) continue;
  const text = stripComments(fs.readFileSync(file, "utf8"));
  const n = countMatches(text, DARK_NEUTRAL);
  if (n > 0) darkPairs.set(r, n);
  const rest = countMatches(text.replace(DARK_NEUTRAL, " "), NEUTRAL_CLASS);
  if (rest > 0) themeBlind.set(r, rest);
}

const sorted = [...violations.entries()].sort((a, b) => b[1] - a[1]);
const grandTotal = sorted.reduce((sum, [, n]) => sum + n, 0);
const sortedDark = [...darkPairs.entries()].sort((a, b) => b[1] - a[1]);
const darkTotal = sortedDark.reduce((sum, [, n]) => sum + n, 0);
const sortedBlind = [...themeBlind.entries()].sort((a, b) => b[1] - a[1]);
const blindTotal = sortedBlind.reduce((sum, [, n]) => sum + n, 0);

if (orphans.length > 0) {
  console.error(`design-tokens: 发现 ${orphans.length} 个孤儿样式表（无人 import，永远不会进构建）：`);
  for (const f of orphans) console.error(`  ${rel(f)}`);
  console.error("  请删除，或在入口处显式引入。注意：死样式表会让迁移进度失真。");
  process.exit(1);
}

if (sortedBlind.length > 0) {
  console.error(`design-tokens: 发现 ${blindTotal} 处中性色工具类（zinc / white / black）：`);
  for (const [f, n] of sortedBlind) console.error(`  ${String(n).padStart(4)}  ${f}`);
  console.error("  一份值意味着浅深共用，必然在某一侧不成立（深色下近白块、浅色下对比度不足）。");
  console.error("  改走语义令牌 surface-* / content-* / border-*；确需「不随主题翻转」请补语义令牌。");
  process.exit(1);
}

/**
 * 基线结构（2026-10 起）：
 *   { literalColors: {文件: 处数}, darkNeutralPairs: {文件: 处数} }
 * 旧版是扁平 {文件: 处数}，读取时自动视为 literalColors，保证向后兼容。
 * 两个闸门独立，互不遮蔽 —— 否则 dark: 的几百处会让「字面色值已归零」看不出来。
 */
function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  if (raw && typeof raw === "object" && ("literalColors" in raw || "darkNeutralPairs" in raw)) {
    return { literalColors: raw.literalColors ?? {}, darkNeutralPairs: raw.darkNeutralPairs ?? {} };
  }
  return { literalColors: raw ?? {}, darkNeutralPairs: {} };
}

if (updateBaseline) {
  const baseline = {
    literalColors: Object.fromEntries(sorted),
    darkNeutralPairs: Object.fromEntries(sortedDark),
  };
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(
    `design-tokens: 基线已冻结 — 字面色值 ${sorted.length} 文件 / ${grandTotal} 处；` +
      `dark: 配对 ${sortedDark.length} 文件 / ${darkTotal} 处`,
  );
  process.exit(0);
}

const printSection = (label, rows, total) => {
  console.log(`${label} — ${rows.length} 个文件 / ${total} 处`);
  if (rows.length > 0) console.log(rows.map(([r, n]) => `  ${String(n).padStart(4)}  ${r}`).join("\n"));
};

printSection("design-tokens: 绕过设计系统的字面色值 / 非 zinc 调色板类", sorted, grandTotal);
printSection("design-tokens: 待令牌化的 dark: 中性色配对", sortedDark, darkTotal);
printSection("design-tokens: 单值中性色类（零容忍）", sortedBlind, blindTotal);

if (reportOnly) process.exit(0);

const baseline = loadBaseline();
if (!baseline) {
  console.log("design-tokens: 未找到基线文件，先执行 --update-baseline 再纳入 verify");
  process.exit(0);
}

const regressions = [];
const collect = (label, rows, allowedMap) => {
  for (const [r, n] of rows) {
    const allowed = allowedMap[r] ?? 0;
    if (n > allowed) regressions.push(`  [${label}] ${r}: ${allowed} → ${n}`);
  }
};
collect("字面色值", sorted, baseline.literalColors);
collect("dark: 配对", sortedDark, baseline.darkNeutralPairs);

if (regressions.length > 0) {
  console.error(`design-tokens: 出现 ${regressions.length} 个新增违规，请改用语义令牌或 zinc 色阶：`);
  console.error(regressions.join("\n"));
  console.error("  可用令牌见 docs/design-system.md 与 docs/token-migration-map.md；确需放开请显式更新基线。");
  process.exit(1);
}

const improved =
  sorted.filter(([r, n]) => n < (baseline.literalColors[r] ?? 0)).length +
  sortedDark.filter(([r, n]) => n < (baseline.darkNeutralPairs[r] ?? 0)).length;
console.log(`design-tokens: ok（无新增违规${improved > 0 ? `，${improved} 个文件低于基线` : ""}）`);
