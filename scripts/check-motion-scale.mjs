/**
 * motion-scale-contract
 * ---------------------------------------------------------------------------
 * 钉住动效刻度：`--duration-fast / base / slow` 与 `--ease-standard / out`。
 *
 * 背景（为什么这条守卫现在才出现，以及它防的是什么）：
 *   Tailwind v4 的 `duration-*` 是**数字型**内置工具 —— `duration-200` 直接产出
 *   `transition-duration: 200ms`，是一个**固定值**。它既不读 `--duration-*` 令牌，
 *   也不受 `prefers-reduced-motion` 归零影响。结果就是：
 *     ① 刻度外多出一批 150 / 200 / 220 / 300ms，没人拦得着；
 *     ② reduce 用户照样看完整动画 —— 令牌归零只管得住走 var() 的那些。
 *   所以补守卫的同时必须先把桥接补上（tokens.css 的 @utility duration-fast/base/slow），
 *   否则「只能用刻度」是一句做不到的要求。
 *
 * 规则：
 *   1. 禁止刻度外的时长字面量（`80ms` / `110ms` / `170ms` …）。允许 `0ms`
 *      —— 那是 reduced-motion 的归零值。
 *   2. 禁止数字型 duration 类（`duration-150` / `duration-200` …），理由同上。
 *      允许 `duration-fast|base|slow`，以及 `duration-[var(--duration-*)]`。
 *   3. 禁止 `ease-in` / `ease-in-out` / `ease-linear` —— 刻度只有 standard 与 out。
 *   4. 豁免 `src/tokens.css`：它是刻度的**定义处**，字面量是它的本职
 *      （与 design-tokens 豁免唯一色源同理：豁免面越窄，盲区越小）。
 *
 * ★ 只在**剥过注释**的文本上匹配。本仓真实教训（§14）：在原始文本上匹配会把注释里的
 *   数值算成违规，逼着人删掉解释原因的注释 —— 本守卫试运行时就抓到 3 处纯注释命中
 *   （`500ms` 捏合探测窗口、`250ms` 停留计时步长），它们根本不是动画时长。
 *   ★ 注意：`view()` **不剥注释**，它只解决「空白被压缩导致 includes 失效」。
 *   剥注释是 `stripComments()`，本仓此前没有这个工具，本守卫是第一个使用者。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/source-view.mjs";

// `new URL(..).pathname` is not a filesystem path: on Windows it yields
// "/D:/a/...", which win32 path helpers then mangle into "D:\D:\a\...".
// `fileURLToPath` is the platform-correct conversion.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(REPO_ROOT, "src");
const EXEMPT = new Set(["src/tokens.css"]);

/** `relative()` gives backslashes on Windows; every comparison below is POSIX. */
const toPosix = (path) => path.split(sep).join("/");

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (/\.(ts|tsx|css)$/.test(entry)) out.push(full);
  }
  return out;
}

// 刻度内的写法：令牌变量 / 语义工具类 / 走 var() 的任意值
const TOKEN_DURATION = /var\(--duration-(fast|base|slow)\)/;
const UTILITY_DURATION = /duration-(fast|base|slow)\b/;
const ARBITRARY_DURATION = /duration-\[var\(--duration-(fast|base|slow)\)\]/;

const violations = [];
const files = collect(ROOT).sort();

for (const file of files) {
  const rel = toPosix(relative(REPO_ROOT, file));
  if (EXEMPT.has(rel)) continue;
  const text = stripComments(readFileSync(file, "utf8"));
  if (!text) continue;

  for (const [index, line] of text.split("\n").entries()) {
    const lineNo = index + 1;
    const where = `${rel}:${lineNo}`;

    // 规则 1 + 2：先剔除所有合规写法，剩下的 duration / ms 都是违规
    let residue = line
      .replace(TOKEN_DURATION, "")
      .replace(ARBITRARY_DURATION, "")
      .replace(UTILITY_DURATION, "");

    // 规则 1：刻度外的时长字面量（0ms 是 reduce 归零，合法）
    for (const m of residue.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)ms\b/g)) {
      if (m[1] === "0") continue;
      violations.push(`${where} 刻度外时长 ${m[0]} — 用 var(--duration-*) 或 duration-fast|base|slow`);
    }

    // 规则 2：数字型 duration 类
    for (const m of residue.matchAll(/\bduration-(\d+)\b/g)) {
      violations.push(`${where} 数字型 duration-${m[1]} — 它是固定值，不归零也不进刻度`);
    }

    // 规则 3：刻度外的缓动
    for (const m of line.matchAll(/\bease-(in|in-out|linear)\b/g)) {
      violations.push(`${where} 刻度外缓动 ease-${m[1]} — 刻度只有 ease-standard 与 ease-out`);
    }
  }
}

assert.equal(
  violations.length,
  0,
  `动效刻度违规 ${violations.length} 处：\n  - ${violations.join("\n  - ")}`,
);

// ---- 规则 5（正断言）：刻度的工具类定义必须走 var() ----
// 这条不能靠规则 1–3 —— tokens.css 是规则 1 的豁免文件。而它的失效形态最坏：
// 写成固定值后动画照常播，只是 reduce 用户也跟着看完整动画，**没有任何报错**。
// 同时它也钉住「@theme 不产出 duration-* 类」这件事：哪天 Tailwind 改了行为、
// 这两个 @utility 被删，这里会立刻红，而不是让所有 duration-slow 静默退化成 0s。
const tokensText = readFileSync(join(ROOT, "tokens.css"), "utf8");
for (const name of ["fast", "base", "slow"]) {
  const block = tokensText.match(new RegExp(`@utility\\s+duration-${name}\\s*\\{([^}]*)\\}`));
  assert(
    block,
    `tokens.css 必须定义 @utility duration-${name} —— v4 的 duration-* 是数字型内置工具，@theme 里的 --duration-* 不会产出类（已实测）`,
  );
  assert(
    /var\(--duration-(fast|base|slow)\)/.test(block[1]),
    `@utility duration-${name} 必须走 var() —— 写成固定值会让 prefers-reduced-motion 归零失效，且失效是静默的`,
  );
}

console.log(`motion-scale: ok（扫描 ${files.length} 个文件，刻度外 0 处）`);
