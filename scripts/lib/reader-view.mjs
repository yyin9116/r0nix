/**
 * reader-view —— 「阅读器模块」的统一源码视图
 * ---------------------------------------------------------------------------
 * 为什么需要这个模块：
 * `src/components/PDFViewer.tsx` 原是 5509 行单文件，2026-10-04 按
 * 「共享内核 / 画布 / 缩略图 / 工具按钮 / 主体」拆成 1 + 4 个文件：
 *
 *     src/components/PDFViewer.tsx          ← 主体（保留原名，仍是入口）
 *     src/components/pdfReader/readerCore.ts       共享类型与纯函数
 *     src/components/pdfReader/PageCanvas.tsx      逐页画布
 *     src/components/pdfReader/PageThumbnail.tsx   缩略图
 *     src/components/pdfReader/ToolButton.tsx      工具条按钮
 *
 * 有 4 条契约守卫断言的对象都在这个模块里（image-index / reading-assist /
 * translation-race / pdf-virtualization）。**拆分只是搬运，没有跨文件重排逻辑**，
 * 所以对守卫而言最忠实的读法是「把模块当一个整体看」—— 否则每拆一次文件，
 * 就有几十条断言因为「目标换了文件」而变红，与功能是否回归完全无关。
 *
 * ★ 自动发现，不写死清单
 * 这里刻意不维护一份文件名单：pdfReader/ 目录下所有 .ts/.tsx 自动并入。
 * 理由是本仓库反复踩过「同一事实抄两份然后漂移」—— 文件清单一旦写死，
 * 下次再拆一个文件时，有人会忘记登记，而症状是**正断言静默变红、负断言静默变弱**。
 * 自动发现让「新增拆分文件」这件事零维护。
 *
 * 只在需要**相对顺序**（indexOf 先后比较）或逐文件语义的断言上，才用
 * `fileView()` 点名具体文件 —— 并集会让这类断言无法表达「在同一个文件内」。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { view } from "./source-view.mjs";

const READER_ENTRY = "src/components/PDFViewer.tsx";
const READER_DIR = "src/components/pdfReader";

/**
 * 阅读器模块的源文件清单（入口在前，其余按文件名排序，保证顺序稳定）。
 */
export const READER_FILES = [
  READER_ENTRY,
  ...readdirSync(READER_DIR)
    .filter((f) => /\.tsx?$/.test(f))
    .sort()
    .map((f) => `${READER_DIR}/${f}`),
];

/** 读单个源文件的断言视图。 */
export function fileView(relPath) {
  return view(readFileSync(relPath, "utf8"));
}

/**
 * 把阅读器模块当成一个整体读。
 * 用 `\n` 连接而不是 `""`：万一将来有人写跨文件的 `indexOf` 比较，
 * 换行能让「上一文件结尾 + 下一文件开头」的意外拼接不成立。
 */
export function readerView() {
  return view(READER_FILES.map((f) => readFileSync(f, "utf8")).join("\n"));
}

/**
 * 自检：证明这个模块没在读空气。
 * 失败模式同样是**静默**的 —— 目录改名会让 readdirSync 抛错（响亮），
 * 但文件被搬走却仍能读到旧路径时，并集会悄悄少一块。
 * 直接执行 `node scripts/lib/reader-view.mjs` 运行。
 */
export function selfTest() {
  const failures = [];
  for (const f of READER_FILES) {
    try {
      const size = statSync(f).size;
      if (size < 200) failures.push(`${f} 只有 ${size} 字节，疑似被清空`);
    } catch {
      failures.push(`${f} 不存在`);
    }
  }
  // 入口必须真的在清单里，且并集必须能读到入口里的东西
  if (!READER_FILES.includes(READER_ENTRY)) failures.push("入口文件未登记");
  const union = readerView();
  if (!union.includes("PDFViewer")) failures.push("并集里读不到 PDFViewer 的迹象");
  if (failures.length === 0) {
    console.log(`reader-view: ok（${READER_FILES.length} 个文件，${union.raw.length} 字符）`);
  }
  return failures;
}

if (process.argv[1] && process.argv[1].endsWith("reader-view.mjs")) {
  const failures = selfTest();
  if (failures.length) {
    for (const f of failures) console.error("FAIL  " + f);
    console.error(`reader-view: ${failures.length} 项自检失败 —— 依赖它的 4 条契约守卫已不可信`);
    process.exit(1);
  }
}
