/**
 * 跑完 cases/ 下的全部探针用例。
 * ---------------------------------------------------------------------------
 * 为什么需要它：探针必须逐个用例调用，而每批迁移都要「全部用例都绿」才算通过 ——
 * 漏跑一个用例，就等于漏掉一整块盲区（快照看不到未挂载视图的规则）。
 *
 * 用法：node scripts/design-diff/probe-all.mjs
 * 前置：npx vite build
 *
 * 退出码：任一路径的用例非零退出 → 1。
 * 注意「已审阅位移」（Δ）不算失败 —— 它们由用例里的 acceptedDrift 标记，
 * 探针本身已按 0 退出（见 probe.mjs 的输出约定）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(here, "cases");
const probe = path.join(here, "probe.mjs");

const files = fs
  .readdirSync(casesDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

if (files.length === 0) {
  console.error(`probe-all: ${path.relative(process.cwd(), casesDir)} 下没有用例`);
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [probe, path.join(casesDir, f)], { encoding: "utf8" });
  const outLines = (r.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const errLines = (r.stderr ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !/^Node\.js v/.test(s) && !s.startsWith("at "));
  // 摘要优先级：stdout 末行 → 第一句像「原因」的 stderr → stderr 首行 → 退出码。
  // 不能简单取 stderr 末行：崩栈的最后一行是「Node.js v22.x」，会把真正的错误吞掉。
  const summary =
    outLines.at(-1) ?? errLines.find((s) => /Error|错误|失败/.test(s)) ?? errLines[0] ?? `退出码 ${r.status}`;
  const ok = r.status === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? "✔" : "✘"} ${f.padEnd(24)} ${summary}`);
}

console.log(
  failed === 0
    ? `\nprobe-all: ${files.length} 个用例全部通过`
    : `\nprobe-all: ${failed}/${files.length} 个用例未通过`,
);
process.exit(failed === 0 ? 0 : 1);
