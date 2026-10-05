/**
 * 差分归并报告：按 状态 × 属性 × 取值变化 聚合，并给出一个样本路径。
 * 目的：把「同一类改动」压成一行，先看清有哪几类，再逐类判定是噪声/预期/回归。
 * 直接输出几百条逐节点差异是没有用的 —— 一份 445 节点 × 3 状态的快照，
 * 一次迁移能产生 1600+ 条差异，其中真正的回归可能只有 9 条。
 *
 * 用法：node scripts/design-diff/diff.mjs <before.json> <after.json>
 *       （两个输入都应是 normalize.mjs 的输出，否则颜色噪声会淹没真回归）
 *
 * 判定须知（本轮实测积累）：
 *   - `display: inline-flex → flex` 是 flex/grid 子项的**容器块级化**，新旧等价，
 *     已由 IGNORE 单独计数，不要当回归。
 *   - 一个容器的 `color` 变化会通过 `currentColor` 传染给所有后代节点的
 *     `color` / `outlineColor` / `borderTopColor`，所以「×94 处」常常只有 1 个源头。
 *     判读时先看样本路径的层级，别被乘数吓到。
 *   - 小于 5px 的 `width` 变化通常来自**兄弟节点**的 padding 微调引起的重新分配，
 *     要顺着同一行找源头，而不是逐个改。
 */
import fs from "node:fs";

const before = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const after = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));

const SKIP = new Set(["_sel", "_text"]);
const IGNORE = new Set(["display"]); // 容器块级化误报，单独统计
let total = 0;
let totalIgnored = 0;

for (const state of Object.keys(before)) {
  const a = before[state]?.nodes || {};
  const b = after[state]?.nodes || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const bucket = new Map();
  let stateTotal = 0;

  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (!x || !y) {
      const key = (x ? "仅前版有" : "仅后版有") + "  " + (y || x)._sel;
      bucket.set(key, { n: (bucket.get(key)?.n || 0) + 1, sample: k });
      stateTotal += 1;
      total += 1;
      continue;
    }
    for (const p of Object.keys(x)) {
      if (SKIP.has(p) || x[p] === y[p]) continue;
      if (IGNORE.has(p)) {
        totalIgnored += 1;
        continue;
      }
      stateTotal += 1;
      total += 1;
      const key = p + "   " + String(x[p]).slice(0, 60) + "  =>  " + String(y[p]).slice(0, 60);
      const cur = bucket.get(key) || { n: 0, sample: k, sel: y._sel };
      cur.n += 1;
      bucket.set(key, cur);
    }
  }

  console.log("\n########## " + state + "   计 " + stateTotal + " 处 ##########");
  [...bucket]
    .sort((m, n) => n[1].n - m[1].n)
    .forEach(([k, v]) => console.log(String(v.n).padStart(5) + "  " + k + "     [样本 " + v.sample + " " + (v.sel || "").slice(0, 34) + "]"));
}

console.log("\n\n合计 " + total + " 处（另忽略 display 类容器块级化 " + totalIgnored + " 处）");
