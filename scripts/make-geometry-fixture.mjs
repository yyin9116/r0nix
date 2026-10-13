/**
 * 生成真PDF 几何夹具。
 *
 * 为什么要包一层：夹具需要 **pymupdf**（只有它能给出行级 bbox），
 * 而它在系统 python 里通常没有 —— 开发机上装在 anaconda 里。
 * 直接把路径写进 package.json 会让这台机器之外的人跑不动。
 *
 * 所以这里按顺序探测：环境变量 `R0NIX_PYTHON` → anaconda → 系统 python3，
 * 逐个试「能不能 import fitz」。都找不到就**明确报错并给出安装命令** ——
 * 静默跳过更糟：那会让「段落切分在真 PDF 上对不对」这个问题永远没人回答。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const SCRIPT = "scripts/make-geometry-fixture.py";

const candidates = [
  process.env.R0NIX_PYTHON,
  "/opt/anaconda3/bin/python3",
  "/usr/local/bin/python3",
  "/opt/homebrew/bin/python3",
  "python3",
].filter(Boolean);

const failures = [];
for (const python of candidates) {
  if (python.includes("/") && !existsSync(python)) {
    failures.push(`${python}（不存在）`);
    continue;
  }
  const probe = spawnSync(python, ["-c", "import fitz"], { stdio: "ignore" });
  if (probe.status === 0) {
    const run = spawnSync(python, [SCRIPT], { stdio: "inherit" });
    process.exit(run.status ?? 1);
  }
  failures.push(`${python}（无 pymupdf）`);
}

console.error("无法生成几何夹具：找不到带 pymupdf 的 Python。");
console.error("依次尝试过：\n  " + failures.join("\n  "));
console.error("装一个即可：\n  /opt/anaconda3/bin/python3 -m pip install pymupdf");
console.error("或指定已有解释器：R0NIX_PYTHON=/path/to/python3 npm run fixture:geometry");
process.exit(1);
