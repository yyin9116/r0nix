/**
 * self-test-pdf-scroll-guards —— 证明「滚动卡顿」那三条契约**真的会红**
 * ---------------------------------------------------------------------------
 * 为什么需要它，而不是一次性手工改文件看它红一下：
 * 本轮（2026-10-10）加进 `check-pdf-virtualization.mjs` 的三条断言，拦的都是
 * **静默**错误 —— 波浪线照画、悬停照亮、图片照能识别，只是每帧多做几百次
 * 强制同步布局。这类断言唯一的失败模式不是「太严」，而是**它其实拦不住**
 * （针写歪了、被注释喂饱了、锚点指向了一个早就改名的地方），而那种情况下
 * 它照样打印 `ok`。
 *
 * 本仓已经真实发生过一次：`hasPdfTextLayerGeometryChanged` 那条旧断言钉的是
 * 「某个标识符出现过」，而标识符一直在（函数早已无人调用），于是它红了三年、
 * 却和功能毫无关系。所以每条新断言都必须能被一个**具体的坏写法**证否。
 *
 * 做法：对每个用例，把源码改成「坏写法」→ 跑守卫 → 要求它变红且错误信息对得上
 * → 无论如何（包括中途抛错、Ctrl-C）都把源码还原，并核对哈希。
 *
 * 用法：`npm run test:scroll-guards`（或 `node scripts/self-test-pdf-scroll-guards.mjs`）
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GUARD = "scripts/check-pdf-virtualization.mjs";

/**
 * 每个用例：把 `file` 里的 `from` 换成 `to`，`command` 必须变红，且错误信息含 `expect`。
 *
 * ⚠️ `from` 必须在该文件里**唯一**。若不再唯一，本脚本会直接报「变异未生效」，
 * 而不是悄悄改错一处然后宣称守卫可用 —— 那正是它要防的失败形态。
 * （本脚本第一次跑就靠这条抓到过一个锚点已重复的用例。）
 */
const DEFAULT_COMMAND = [GUARD];
const SPAN_CACHE_TEST = ["--experimental-strip-types", "scripts/test-text-layer-span-cache.mjs"];

const CASES = [
  {
    name: "① 绕过缓存裸调 getPdfTextSpans",
    file: "src/components/pdfReader/PageCanvas.tsx",
    // 锚点带上前一行的 `}`，因为 `const spans = readTextSpans(textLayer);` 本身出现两次
    // （悬停命中路径与波浪线 effect 各一次，正是要同时守住的两条消费路径）。
    from: "}\n    const spans = readTextSpans(textLayer);",
    to: "}\n    const spans = getPdfTextSpans(textLayer);",
    expect: "绕过了缓存",
  },
  {
    name: "① 缓存失效判据退回「连视口坐标一起比」",
    file: "src/components/pdfReader/PageCanvas.tsx",
    from: "hasPdfTextLayerGeometryResized(previous, geometry)",
    to: "hasPdfTextLayerGeometryChanged(previous, geometry)",
    expect: "尺寸变才重量",
  },
  {
    name: "② 空标注清单退回每次渲染新建的数组字面量",
    file: "src/components/PDFViewer.tsx",
    from: "derivedWavyAnnotations.length === 0 ? EMPTY_ANNOTATIONS : derivedWavyAnnotations",
    to: "derivedWavyAnnotations.length === 0 ? [] : derivedWavyAnnotations",
    expect: "共享常量",
  },
  {
    name: "③ 图像元数据预取退回「换页即扫」",
    file: "src/components/PDFViewer.tsx",
    from: "}, PAGE_METADATA_IDLE_MS);",
    to: "}, 0);",
    expect: "PAGE_METADATA_IDLE_MS",
  },
  {
    name: "负断言：视口坐标判据被重新引入",
    file: "src/components/pdfReader/readerCore.ts",
    from: "export function shiftPdfTextSpans(",
    to: "export const __legacyPredicate = hasPdfTextLayerGeometryChanged;\n\nexport function shiftPdfTextSpans(",
    expect: "绝不能参与文本层几何缓存的失效判据",
  },
  {
    // 结构守卫（check-pdf-virtualization）拦不住这一种：函数名、调用点、缓存入口
    // 全都还在，只是判据自己又变宽了。只有靠「滚动平移不得判为需要重量」这条
    // 行为断言才能证否 —— 这正是 test-text-layer-span-cache.mjs 存在的理由。
    name: "缓存失效判据又去看视口坐标（结构守卫看不出来）",
    file: "src/components/pdfReader/readerCore.ts",
    from: "    Math.abs(previous.width - next.width) > epsilon ||",
    to: "    previous.left !== next.left ||\n    previous.top !== next.top ||\n    Math.abs(previous.width - next.width) > epsilon ||",
    expect: "向上滚动只是平移",
    command: SPAN_CACHE_TEST,
  },
  {
    name: "平移搬运把垂直方向写反（波浪线会整体漂移）",
    file: "src/components/pdfReader/readerCore.ts",
    from: "    centerY: span.centerY + dy,",
    to: "    centerY: span.centerY - dy,",
    expect: "垂直中心",
    command: SPAN_CACHE_TEST,
  },

  /* ── 第二批（2026-10-10）：右键缩放把浮层一起放大 / 缩放误弹菜单 ────────── */

  {
    name: "④ 逆比例变量只改了 TS 侧的名字（CSS 侧失联）",
    file: "src/components/PDFViewer.css",
    from: "scale(var(--reader-zoom-preview-inv, 1))",
    to: "scale(var(--reader-zoom-preview-inv-renamed, 1))",
    expect: "PDFViewer.css 必须用",
  },
  {
    name: "④ 伴读批注卡没挂抵消类（会被缩放预览抻大）",
    file: "src/components/pdfReader/CompanionMarginCard.tsx",
    from: " pdf-flow-ui-chrome",
    to: "",
    expect: "必须挂上 .pdf-flow-ui-chrome",
  },
  {
    name: "④ 抵消的变形原点挂反（卡片会从贴边处滑开）",
    file: "src/components/PDFViewer.tsx",
    from: 'placement.side === "right" ? "top right" : "top left"',
    to: 'placement.side === "right" ? "top left" : "top right"',
    expect: "抵消的变形原点必须与被钉住的那条边对齐",
  },
  {
    // 这一种最容易漏：函数名还在、调用点也还在，只是**预览路径里又裸写了一次**
    // transform —— 单看两边都合法，拼起来才失效（逆比例不会被更新）。
    // （把调用整个删掉是另一种坏写法，由「原点必须来自锚点」那条断言接住。）
    name: "④ 预览路径额外裸写一次 flow.style.transform",
    file: "src/components/PDFViewer.tsx",
    from: "applyZoomPreviewScale(flow, visualScale, anchor.originX, anchor.originY);",
    to: "flow.style.transform = `scale(${visualScale})`;\n      applyZoomPreviewScale(flow, visualScale, anchor.originX, anchor.originY);",
    expect: "不允许再裸写",
  },
  {
    name: "⑤ 松手判据只看 moved（缩放必弹菜单）",
    file: "src/components/PDFViewer.tsx",
    from: "const shouldOpenMenu = Boolean(options?.openMenuIfClick) && !right.moved && !zoomChangedDuringGesture;",
    to: "const shouldOpenMenu = Boolean(options?.openMenuIfClick) && !right.moved;",
    expect: "松手是否弹右键菜单",
  },
  {
    name: "⑤ 缩放基线不进手势状态（判据恒为 null，等于没修）",
    file: "src/components/PDFViewer.tsx",
    from: "zoomAtStart: zoomTargetRef.current,",
    to: "zoomAtStart: null,",
    expect: "缩放基线（zoomAtStart）必须在 pointerdown 时记录",
  },
  {
    name: "⑥ 波浪线早退分支被改成永假（结构上还在，实际不生效）",
    file: "src/components/pdfReader/PageCanvas.tsx",
    from: "if (wavyItems.length === 0 && activeAssistRangesRef.current.length === 0) {",
    to: "if (false) {",
    expect: "早退分支",
  },
  {
    name: "⑥ 渲染路径又预先测了一遍整层 span",
    file: "src/components/pdfReader/PageCanvas.tsx",
    // ⚠️ 锚点不能从 `builder.show();` 起头：那与目标语句之间隔着一整段说明注释，
    // 换行拼不上。改用「渲染完成之后那一小段」的结尾三行定位（`domBlocks` 那行唯一）。
    from: "          textSpanGeometryRef.current = null;\n          paragraphCacheRef.current = new WeakMap();\n          const domBlocks = buildDomPdfReadingBlocks(builder.div, pageNo);",
    to: "          textSpanGeometryRef.current = null;\n          paragraphCacheRef.current = new WeakMap();\n          textSpanCacheRef.current = getPdfTextSpans(builder.div);\n          const domBlocks = buildDomPdfReadingBlocks(builder.div, pageNo);",
    // 它会被上面「只允许一处」的计数断言先接住 —— 那句文案里点明了这第二种失败模式。
    expect: "只允许在 readTextSpans 的兜底取值处出现一次",
  },

  /* ── 第三批（2026-10-10）：侧栏 200 个常驻缩略图 canvas ─────────────────
   *
   * 这一批的坏写法有一个共同点：**全都看不出来**。缩略图照显示、点击照跳页、
   * 一次采样全都「非空白」，只是慢帧悄悄从 1% 回到 12%。
   * 唯一能区分的是「滚远 → 卸载 → 滚回来还会不会重画」这条路径，
   * 而那条由 `probe-pdf-blank.mjs` 的 ⑩/⑪ 段在浏览器里守（已做过变异验证）。
   */

  {
    name: "⑦ 挂载开关退化成恒真（等于 200 个 canvas 全部常驻）",
    file: "src/components/pdfReader/PageThumbnail.tsx",
    from: "const showCanvas = nearView || active;",
    to: "const showCanvas = true;",
    expect: "缩略图 canvas 的挂载开关",
  },
  {
    // 最容易写成「看起来对」的坏写法：把 canvas 留在 DOM 里、只改样式。
    // 那样后备缓冲还在，性能一点没省，但结构上「有 showCanvas、有 canvas」。
    name: "⑦ canvas 从不卸载，只靠条件恒真留在 DOM 里",
    file: "src/components/pdfReader/PageThumbnail.tsx",
    from: "{showCanvas ? (",
    to: "{true ? (",
    expect: "条件挂载",
  },
  {
    name: "⑦ 卸载时不撤 ready（重进瞬间露出空白框）",
    file: "src/components/pdfReader/PageThumbnail.tsx",
    from: "if (!showCanvas) {",
    to: "if (false) {",
    expect: "撤掉 ready",
  },
  {
    // 这条对应本轮真实踩到的 bug：守卫退回 `canvas.width > 1`。
    // 新建 canvas 的默认 width 恰好是 300，于是「重挂载」的新 canvas 会被误判为已渲染。
    name: "⑦ 已渲染守卫退回 canvas.width 判据（重挂载后空白缩略图）",
    file: "src/components/pdfReader/PageThumbnail.tsx",
    from: "renderedKeyRef.current === renderedKey && renderedCanvasRef.current === canvas",
    to: "renderedKeyRef.current === renderedKey && canvas.width > 1",
    expect: "节点身份",
  },
  {
    // 节点身份还在、只是**额外**又加了一条 width 判据 —— 负断言专治这一种。
    name: "⑦ 节点身份之外又补一条 canvas.width 判据",
    file: "src/components/pdfReader/PageThumbnail.tsx",
    from: "renderedKeyRef.current === renderedKey && renderedCanvasRef.current === canvas",
    to: "renderedKeyRef.current === renderedKey && renderedCanvasRef.current === canvas && canvas.width > 1",
    expect: "不能作为「已渲染」判据",
  },
  {
    name: "⑦ 可见性只上报「进入」（canvas 只进不出，回到常驻）",
    file: "src/components/PDFViewer.tsx",
    from: "thumbnailVisibilityHandlersRef.current.get(pageNo)?.(entry.isIntersecting)",
    to: "if (entry.isIntersecting) thumbnailVisibilityHandlersRef.current.get(pageNo)?.(true);",
    expect: "双向",
  },
  {
    name: "⑦ 可见性回调表签名丢掉 visible 参数",
    file: "src/components/PDFViewer.tsx",
    from: "useRef<Map<number, (visible: boolean) => void>>",
    to: "useRef<Map<number, () => void>>",
    expect: "签名必须带",
  },
  {
    name: "⑦ PageThumbnail 把可见性回调接成只置真",
    file: "src/components/pdfReader/PageThumbnail.tsx",
    from: "const onVisibility = (visible: boolean) => setNearView(visible);",
    to: "const onVisibility = () => setNearView(true);",
    expect: "setNearView(visible)",
  },
];

const sha = (value) => createHash("sha256").update(value).digest("hex");
const failures = [];

for (const testCase of CASES) {
  const original = readFileSync(testCase.file, "utf8");
  const originalHash = sha(original);
  const hits = original.split(testCase.from).length - 1;
  if (hits !== 1) {
    failures.push([testCase.name, `变异锚点在 ${testCase.file} 里出现 ${hits} 次（要求恰好 1 次）—— 用例已失效，请更新锚点`]);
    continue;
  }

  let result;
  try {
    writeFileSync(testCase.file, original.replace(testCase.from, testCase.to));
    result = spawnSync(process.execPath, testCase.command ?? DEFAULT_COMMAND, { encoding: "utf8" });
  } finally {
    // 无条件还原：包括守卫抛错、spawn 失败、以及 Ctrl-C 之后的那次 finally
    writeFileSync(testCase.file, original);
  }

  const restored = sha(readFileSync(testCase.file, "utf8"));
  if (restored !== originalHash) {
    failures.push([testCase.name, `${testCase.file} 还原失败（哈希不一致）—— 请立刻用 git checkout 恢复`]);
    continue;
  }

  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status === 0) {
    failures.push([testCase.name, "守卫仍然通过 —— 这条断言拦不住它本该拦住的写法"]);
    continue;
  }
  if (!output.includes(testCase.expect)) {
    failures.push([
      testCase.name,
      `守卫确实红了，但错误信息里没有「${testCase.expect}」—— 红的是别处，说明锚点或断言顺序已经漂移`,
    ]);
    continue;
  }
  console.log(`ok   ${testCase.name}（红在：${testCase.expect}）`);
}

if (failures.length) {
  console.error("");
  for (const [name, reason] of failures) console.error(`FAIL ${name}\n     ${reason}`);
  console.error(`\nself-test-pdf-scroll-guards: ${failures.length}/${CASES.length} 项失败 —— 这三条滚动契约目前**不可信**`);
  process.exit(1);
}
console.log(`\nself-test-pdf-scroll-guards: ok（${CASES.length}/${CASES.length} 条断言都能被具体坏写法证否）`);
