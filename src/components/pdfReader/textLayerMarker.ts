/**
 * text layer 内的标注渲染器 —— 复用 pdf.js 官方 `TextHighlighter` 的算法。
 *
 * ## 为什么必须走库，而不是自己画 div
 *
 * 之前的实现是「按段落矩形画若干个绝对定位的覆盖 div」。它在版面上有三种必然的错：
 *
 * 1. **波浪线贴在整段底部**。段落 rect 是并集框，画出来的线自然落在最后一行下面，
 *    读者看不出它标的是哪一句。
 * 2. **选中一段会带入邻段**。段落边界靠几何启发式猜，猜错就把相邻两段一起框进来。
 * 3. **双栏被连成一片**。并集框横跨两栏时，覆盖 div 直接糊满整个上半页。
 *
 * pdf.js 5.4 自带的 `TextHighlighter`（`web/pdf_viewer.mjs`）解决的不是「矩形」，
 * 而是「**字符区间**」：它拿到的是 `textDivs`（每个文本 item 对应的 span）与
 * `textContentItemsStr`（每个 item 的原文），把匹配拆成
 * `{ begin: {divIdx, offset}, end: {divIdx, offset} }`，然后在 span **内部**切分文本节点，
 * 给片段套 CSS class。行内的波浪线因此天然贴着每个片段自己的基线，
 * 跨行时首/中/尾自动拿到 `begin` / `middle` / `end` 三个修饰类做接角处理。
 *
 * ## 借的是哪一段、怎么借
 *
 * 官方 `TextHighlighter` 与 `FindController` / `EventBus` 深度绑定（构造函数就要
 * `findController`，渲染时读 `findController.selected` / `state.highlightAll`），
 * 直接 new 它就得伪造一整套查找控制器 —— 那比自己写还脏。
 *
 * 但它**预留了宿主扩展点**：`TextLayerBuilder` 的构造参数里有 `highlighter`，
 * `render()` 内部会 `this.highlighter?.setTextMapping(textDivs, textContentItemsStr)`
 * 再 `enable()`。也就是说：**只要实现 `setTextMapping` / `enable` / `disable` 三个方法，
 * 就能拿到官方算好的 DOM 映射，再套用官方那段切分算法** —— 这正是本文件做的事。
 *
 * 与官方实现的三处有意差异：
 *
 * - **匹配来源**：官方从 `findController.pageMatches` 取正则命中；本类由调用方
 *   直接给区间（`setRanges`），因为标注来自解析器的行级 bbox 与用户的真实选区，
 *   不是全文正则。
 * - **不做滚动跟随**：`scrollMatchIntoView` 依赖 `findController`，交由调用方处理。
 * - **多组独立样式**：官方只有 highlight / selected 两态；本类支持一组 range 一个
 *   class 前缀，才能让「段落激活底色」与「AI 波浪线」同时存在于同一段文字上。
 *
 * ⚠️ 切分是**破坏性**的：官方同样会把 `textDivs[i].textContent` 清空再重建。
 * 因此 `clear()` 必须把文本原样写回（`_updateMatches(reset)` 的做法），
 * 否则下一次渲染会丢字。文本层的重建由 `TextLayerBuilder.update()` 负责，
 * 本类不碰它。
 */

/** 一段字符区间。语义与官方 `_convertMatches` 的产物完全一致。 */
export interface TextRange {
  begin: { divIdx: number; offset: number };
  end: { divIdx: number; offset: number };
}

/** 一组区间 + 它们的样式前缀。 */
export interface TextRangeGroup {
  /** 会被拼进 class 名：`${className}`、`${className} begin` …… */
  className: string;
  ranges: TextRange[];
}

export type TextRangeGroupInput = string | TextRangeGroup;

/**
 * `TextLayerBuilder` 只要求 highlighter 有这三个方法（见 `pdf_viewer.mjs` 的
 * `render()`：`setTextMapping` → `await render()` → `enable()`；`hide()` 调 `disable()`，
 * `cancel()` 也调 `disable()`）。
 */
export interface TextLayerHighlighterLike {
  setTextMapping(divs: HTMLElement[], texts: string[]): void;
  enable(): void;
  disable(): void;
}

/**
 * 是否具备 DOM。
 *
 * ⚠️ **必须在每次调用时求值**，不能在模块顶层固化成常量：本仓的纯函数单测
 * （`scripts/test-text-layer-marker.mjs`）在 `import` 之后才装 `globalThis.document`，
 * 顶层求值会读到 undefined，于是所有渲染调用都变成空操作 ——
 * 测试全绿但一行 DOM 都没改，是最坏的一种假绿。
 */
function domReady(): boolean {
  return typeof document !== "undefined" && typeof Node !== "undefined";
}

export class TextLayerMarker implements TextLayerHighlighterLike {
  #textDivs: HTMLElement[] = [];
  #textContentItemsStr: string[] = [];
  #index = new WeakMap<HTMLElement, number>();
  #groups: TextRangeGroup[] = [];

  /**
   * 由 `TextLayerBuilder.render()` 在文本节点建好后回调。
   *
   * ⚠️⚠️ **调用时机早于数组被填充** —— 这是本类最容易踩的坑，实测（真浏览器 +
   * 真实 pdf.js 5.4）发现：官方 `TextLayerBuilder.render()` 是这样写的：
   *
   * ```js
   * this.#textLayer = new TextLayer({ textContentSource, container, viewport });
   * const { textDivs, textContentItemsStr } = this.#textLayer;  // ← 此刻仍是 []
   * this.highlighter?.setTextMapping(textDivs, textContentItemsStr);
   * await this.#textLayer.render();                               // ← 这里才逐项 push
   * this.highlighter?.enable();
   * ```
   *
   * `TextLayer` 用 `streamTextContent()` **流式**取文本，`textDivs` 是同一个
   * 数组对象，被 `render()` 里的 `#processItems` 逐项 push 填满。所以
   * `setTextMapping` 收到的是**空数组引用**，不是最终数组的拷贝。
   *
   * 官方 `TextHighlighter` 之所以没这个问题：它只保存引用、在 `enable()`
   * （render 之后）才读数组内容。**本类必须在 `enable()` 里重建索引**，
   * 否则 `indexOf` 永远返回 -1、标注一条也画不出来 —— 而且不报错，
   * 症状是「波浪线完全不出现」，极难定位。
   */
  setTextMapping(divs: HTMLElement[], texts: string[]): void {
    this.#textDivs = Array.isArray(divs) ? divs : [];
    this.#textContentItemsStr = Array.isArray(texts) ? texts : [];
    this.#groups = [];
    this.#reindex();
  }

  /** 重建 `element → divIdx` 映射。必须在数组填充完毕之后调用。 */
  #reindex(): void {
    this.#index = new WeakMap();
    this.#textDivs.forEach((div, idx) => {
      if (div) this.#index.set(div, idx);
    });
  }

  /**
   * `TextLayerBuilder.render()` 在 `await textLayer.render()` 之后调用。
   * 这是 `textDivs` 真正被填满的第一个时机 —— 索引必须在这里重建。
   */
  enable(): void {
    this.#reindex();
    // 官方在这里 `_updateMatches()` 重画全文命中。本类的区间由调用方显式
    // `setGroups()` 驱动，没有「每次都重画」的语义，所以不自动重绘。
  }

  /** span 在 `textDivs` 里的下标；不在映射内返回 -1。 */
  indexOf(span: HTMLElement): number {
    const idx = this.#index.get(span);
    return typeof idx === "number" ? idx : -1;
  }

  /** 按下标取文本层元素。越界返回 null。 */
  divAt(divIdx: number): HTMLElement | null {
    return this.#textDivs[divIdx] ?? null;
  }

  /** 文本 item 的原文长度。越界返回 0。 */
  lengthAt(divIdx: number): number {
    return this.#textContentItemsStr[divIdx]?.length ?? 0;
  }

  /** `textDivs` 的长度。 */
  divCount(): number {
    return this.#textDivs.length;
  }

  /**
   * 官方在此处做的是「把文本原样写回、清掉所有 class」（`_updateMatches(true)`）。
   * 我们不做：`TextLayerBuilder.hide()` 会在页面滚出视区时调它，那时 DOM 还在，
   * 清空只会让读者已经看到的波浪线凭空消失。要清空请显式调 `clear()`。
   */
  disable(): void {
    // 同 enable()：清理由调用方显式发起。
  }

  /** 当前是否已拿到映射。未就绪时所有渲染调用都是空操作。 */
  get ready(): boolean {
    return this.#textDivs.length > 0 && this.#textContentItemsStr.length > 0;
  }

  /**
   * 区间字符下标 → `{divIdx, offset}`。等价于官方 `_convertMatches`。
   *
   * `offsets` 是每个区间在「整页文本拼接串」里的**起始**字符下标，
   * `lengths` 是长度 —— 与 `findController.pageMatches` 的形状一致，
   * 这样将来真要接全文查找时可以直接复用官方的匹配产物。
   *
   * ⚠️ 与官方的一处**有意偏差**：官方的两个 while 都以 `i !== end` 为条件，
   * 于是「下标超出整页文本长度」时循环会在最后一个 div 上停住，算出
   * `offset: 9987` 这种越界值（实测：本仓第一个单测就抓到它）。
   * 官方靠 `console.error` 掩盖，然后拿这个坏区间去切文本 ——
   * 结果是 `substring` 拿到空串、凭空多出一个空片段。
   * 这里改成先做无条件的累计定位，再显式判定越界并丢弃该区间。
   */
  convertMatches(offsets: number[], lengths: number[]): TextRange[] {
    const items = this.#textContentItemsStr;
    if (!items.length || !offsets.length) return [];
    const total = items.reduce((sum, item) => sum + item.length, 0);
    const result: TextRange[] = [];
    let i = 0;
    let iIndex = 0;

    for (let m = 0; m < offsets.length; m += 1) {
      let matchIdx = offsets[m];
      while (i < items.length && matchIdx >= iIndex + items[i].length) {
        iIndex += items[i].length;
        i += 1;
      }
      if (i >= items.length || matchIdx > total) break;

      const begin = { divIdx: i, offset: matchIdx - iIndex };
      matchIdx += lengths[m] ?? 0;
      while (i < items.length && matchIdx > iIndex + items[i].length) {
        iIndex += items[i].length;
        i += 1;
      }
      if (i >= items.length) {
        // 终点落在整页文本之外：钳到最后一个 div 的末尾，而不是产出越界 offset。
        const last = items.length - 1;
        result.push({ begin, end: { divIdx: last, offset: items[last].length } });
        break;
      }
      const endRange = { divIdx: i, offset: matchIdx - iIndex };
      result.push({ begin, end: endRange });
    }
    return result;
  }

  /** 设置要渲染的区间组并立即重绘。同名 className 的组会被整体替换。 */
  setGroups(groups: TextRangeGroupInput[]): void {
    if (!domReady() || !this.ready) return;
    const divCount = this.#textDivs.length;
    const next: TextRangeGroup[] = [];
    const seen = new Set<string>();
    for (const item of groups) {
      const group: TextRangeGroup = typeof item === "string" ? { className: item, ranges: [] } : item;
      if (!group.className || seen.has(group.className)) continue;
      seen.add(group.className);
      next.push({
        className: group.className,
        // 越界区间在这里被丢掉，不进渲染。渲染期对越界的处理是「静默 return」，
        // 那会让区间链的 prevEnd 状态错乱（见 isValidRange 的注释）。
        ranges: group.ranges.filter(
          (range) => isValidRange(range) && range.end.divIdx < divCount,
        ),
      });
    }
    this.#groups = next;
    this.#render();
  }

  /**
   * 只保留匹配谓词的组并重绘。用于「离开某块时撤掉它的底色」——
   * 直接全清会把别的段落一起撤掉。
   */
  retainGroups(keep: (group: TextRangeGroup) => boolean): void {
    if (!domReady() || !this.ready) return;
    this.#groups = this.#groups.filter(keep);
    this.#render();
  }

  /** 撤掉某个 className 的全部标注。 */
  removeClass(className: string): void {
    if (!domReady() || !this.ready) return;
    this.#groups = this.#groups.filter((group) => group.className !== className);
    this.#render();
  }

  /** 全部撤掉，并把文本原样写回（官方的 `_updateMatches(true)`）。 */
  clear(): void {
    if (!domReady()) return;
    this.#groups = [];
    this.#restoreText();
  }

  #restoreText(): void {
    const { length } = this.#textDivs;
    for (let n = 0; n < length; n += 1) {
      const div = this.#textDivs[n];
      if (!div) continue;
      // 只有被切分过的 div 才会多出子节点；纯文本 div 直接写回即可。
      div.textContent = this.#textContentItemsStr[n] ?? "";
      div.className = "";
    }
  }

  /**
   * 渲染。算法逐行对照官方 `_renderMatches`，包括 `prevEnd` 的跨区间续写与
   * `divIdx === end.divIdx` 的单 div 快路径。
   */
  #render(): void {
    this.#restoreText();
    if (!this.ready) return;
    for (const group of this.#groups) {
      this.#renderGroup(group);
    }
  }

  #renderGroup(group: TextRangeGroup): void {
    const ranges = [...group.ranges].sort(
      (left, right) => left.begin.divIdx - right.begin.divIdx || left.begin.offset - right.begin.offset,
    );
    if (!ranges.length) return;

    let prevEnd: { divIdx: number; offset: number } | null = null;
    let lastDivIdx = -1;
    let lastOffset = -1;

    for (const range of ranges) {
      const begin = range.begin;
      const end = range.end;
      // 与官方一致：相邻区间首尾相接时后者紧接前者，不再重开一段。
      if (begin.divIdx === lastDivIdx && begin.offset === lastOffset) continue;
      lastDivIdx = begin.divIdx;
      lastOffset = begin.offset;

      if (!prevEnd || begin.divIdx !== prevEnd.divIdx) {
        if (prevEnd) this.#append(prevEnd.divIdx, prevEnd.offset, undefined, "");
        this.#beginText(begin);
      } else {
        this.#append(prevEnd.divIdx, prevEnd.offset, begin.offset, "");
      }

      if (begin.divIdx === end.divIdx) {
        this.#append(begin.divIdx, begin.offset, end.offset, group.className);
      } else {
        this.#append(begin.divIdx, begin.offset, undefined, `${group.className} begin`);
        for (let n = begin.divIdx + 1; n < end.divIdx; n += 1) {
          const middle = this.#textDivs[n];
          if (!middle) continue;
          // 中间的 div 是整段命中，直接给整块加 class，无需切分文本节点。
          middle.className = `${group.className} middle`;
        }
        this.#beginText(end, `${group.className} end`);
      }
      prevEnd = end;
    }

    if (prevEnd) this.#append(prevEnd.divIdx, prevEnd.offset, undefined, "");
  }

  /** 清空一个 div 的文本，为随后的片段让路（官方 `beginText`）。 */
  #beginText(begin: { divIdx: number; offset: number }, className = ""): void {
    const div = this.#textDivs[begin.divIdx];
    if (!div) return;
    div.textContent = "";
    if (className) div.className = className;
    this.#append(begin.divIdx, 0, begin.offset, "");
  }

  /**
   * 把 `[fromOffset, toOffset)` 的原文作为文本节点塞进 div，`className` 非空时包一层 span。
   * `toOffset` 传 `undefined` 表示「到该 item 末尾」。
   *
   * 与官方一致的一处关键处理：当 div 本身已是元素节点（被上一轮切成 span 了），
   * 直接往里 append；官方是把它包进新 span 并回写 `textDivs[divIdx]`，
   * 这里保留同样写法 —— 后续区间仍按 divIdx 索引，必须同步更新数组项。
   */
  #append(divIdx: number, fromOffset: number, toOffset: number | undefined, className: string): void {
    let div = this.#textDivs[divIdx] as HTMLElement | undefined;
    const source = this.#textContentItemsStr[divIdx];
    if (!div || source === undefined) return;
    if (div.nodeType === Node.TEXT_NODE) {
      const wrapper = document.createElement("span");
      div.before(wrapper);
      wrapper.append(div);
      this.#textDivs[divIdx] = wrapper;
      div = wrapper;
    }
    const endOffset = toOffset === undefined ? source.length : Math.min(toOffset, source.length);
    const content = source.substring(Math.min(fromOffset, source.length), endOffset);
    const node = document.createTextNode(content);
    if (className) {
      const span = document.createElement("span");
      span.className = `${className} appended`;
      span.append(node);
      div.append(span);
      return;
    }
    div.append(node);
  }
}

/**
 * 区间的**格式**校验（不含是否落在 text layer 内，那要 marker 自己查）。
 *
 * 分两步是有意的：格式错的直接丢；格式对但越界的由 `setGroups` 用
 * `divIdx < divCount()` 再筛一道。不在 `isValidRange` 里查越界是因为它拿不到
 * `textDivs` 长度 —— 而**越界区间必须被丢掉**，否则 `#beginText` 静默 return、
 * `prevEnd` 状态错乱，后面那个合法区间会被追加两次（实测：原文变成 "okokok"）。
 */
function isValidRange(range: TextRange): boolean {
  if (!range || typeof range !== "object") return false;
  const { begin, end } = range;
  if (!begin || !end) return false;
  if (!Number.isInteger(begin.divIdx) || !Number.isInteger(end.divIdx)) return false;
  if (begin.divIdx < 0 || end.divIdx < begin.divIdx) return false;
  if (!Number.isFinite(begin.offset) || !Number.isFinite(end.offset)) return false;
  // 同一个 div 内也要求 offset 单调递增。反向区间会让 `substring(2, 0)`
  // 拿到一个被交换过两端的子串（JS 规范如此），切出来的片段是错乱的文本，
  // 而且不会报错 —— 表现为「某处文字莫名重复」。
  if (begin.offset < 0 || end.offset < begin.offset) return false;
  return end.offset > begin.offset || end.divIdx > begin.divIdx;
}

/** 一个矩形。用结构化类型而非 `DOMRect`，好让纯几何路径能在无 DOM 环境测。 */
export interface BoxRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

/** 一行文本的几何（与 readerCore 的 `PdfTextSpan` 同形，但不引入 DOM 类型）。 */
export interface TextSpanGeometry {
  node: HTMLElement;
  rect: BoxRect;
}

/**
 * 把「落在某个矩形内的一批 span」转成区间组。
 *
 * 判定用**中心点命中**而非「相交即命中」：相交判定会把紧邻下一段首行的 span 也算进来
 * （行间距小到两个矩形必然相交），这正是「选中一段带入邻段」的成因。
 * 中心点唯一归属，行与行之间不会互相吞并。
 */
export function rangesFromSpans(
  marker: TextLayerMarker,
  spans: Iterable<TextSpanGeometry>,
  rect: { left: number; top: number; right: number; bottom: number },
  className: string,
): TextRangeGroup {
  const ranges: TextRange[] = [];
  for (const { node, rect: spanRect } of spans) {
    if (spanRect.width <= 0 || spanRect.height <= 0) continue;
    const centerX = spanRect.left + spanRect.width / 2;
    const centerY = spanRect.top + spanRect.height / 2;
    if (centerX < rect.left || centerX > rect.right) continue;
    if (centerY < rect.top || centerY > rect.bottom) continue;
    const divIdx = marker.indexOf(node);
    if (divIdx < 0) continue;
    const length = node.textContent?.length ?? 0;
    if (length <= 0) continue;
    ranges.push({ begin: { divIdx, offset: 0 }, end: { divIdx, offset: length } });
  }
  return { className, ranges };
}

/**
 * 给一组区间求并集矩形（客户端坐标）。供锚点定位与卡片锚定使用。
 *
 * 为什么不用 `rect` 直接算：标注的 `rect` 是整块并集框，右上角落在版心之外的空白处，
 * 锚点挂在那个坐标上就会飘到段落外侧。取实际命中片段的包围盒，锚点才贴着字。
 */
export function clientRectFromRanges(
  marker: TextLayerMarker,
  ranges: TextRange[],
): DOMRect | null {
  const rects: DOMRect[] = [];
  for (const range of ranges) {
    for (let n = range.begin.divIdx; n <= range.end.divIdx; n += 1) {
      const div = marker.divAt(n);
      const rect = div?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) rects.push(rect);
    }
  }
  if (!rects.length) return null;
  const left = Math.min(...rects.map((item) => item.left));
  const top = Math.min(...rects.map((item) => item.top));
  const right = Math.max(...rects.map((item) => item.right));
  const bottom = Math.max(...rects.map((item) => item.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * 按归一化矩形（页面坐标）收集命中的区间。
 *
 * 与 `rangesFromSpans` 的区别只在于矩形的来源：这里的矩形来自**标注数据**
 * （`ReaderAnnotation.rect`，归一化到 0–1），而不是当前指针所在的那一段。
 * 用途是「这条 AI 标注到底盖住了哪些文字」—— 波浪线与锚点定位都靠它。
 */
export function rangesFromNormalizedRect(
  marker: TextLayerMarker,
  rect: { x: number; y: number; width: number; height: number } | undefined,
  layerRect: BoxRect,
): TextRange[] {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return [];
  const left = layerRect.left + rect.x * layerRect.width;
  const top = layerRect.top + rect.y * layerRect.height;
  const right = left + rect.width * layerRect.width;
  const bottom = top + rect.height * layerRect.height;
  const ranges: TextRange[] = [];
  for (let divIdx = 0; divIdx < marker.divCount(); divIdx += 1) {
    const div = marker.divAt(divIdx);
    const spanRect = div?.getBoundingClientRect();
    if (!spanRect || spanRect.width <= 0 || spanRect.height <= 0) continue;
    const centerX = spanRect.left + spanRect.width / 2;
    const centerY = spanRect.top + spanRect.height / 2;
    if (centerX < left || centerX > right || centerY < top || centerY > bottom) continue;
    const length = marker.lengthAt(divIdx);
    if (length <= 0) continue;
    ranges.push({ begin: { divIdx, offset: 0 }, end: { divIdx, offset: length } });
  }
  return ranges;
}

/**
 * 用**解析器给的行级 bbox**把一个块的 span 切成若干自然段。
 *
 * ## 为什么这是根治「整段误选」的一手
 *
 * 此前段落边界完全靠 DOM 几何启发式（`collectPdfParagraphSpansFromTarget`）：
 * 量行距、量缩进、猜句号、看左右边界。启发式在双栏、图表混排、脚注齐全的论文上
 * 必然出错，而且错了没有任何提示 —— 表现就是「点一下选了两段」。
 *
 * pymupdf `get_text("dict")` 的 `blocks[].lines[].bbox` 是**排版引擎给出的行几何**：
 * 哪几行属于同一段、跨了哪一栏，它比我们清楚。所以这里反过来用它：
 * 拿每一行的 bbox 去文本层里认领 span。
 *
 * ⚠️ **段落 = 一个 block，行只是它的成员**。实测
 * （`scripts/verify-text-layer-geometry.mjs`）：pymupdf 对一段连续正文给出的
 * block **本身就是自然段**（三段 → 三个 block，每个 block 三行）。
 * 所以本函数把一个 block 的全部 `lines` 合起来认领，返回**恰好一组** span ——
 * 那就是这一个段落。跨 block 才是跨段落。
 *
 * 「逐行分组」曾经是这里的语义，那是错的：它把「一行」当成了「一段」，
 * 于是一次划词只选中一行（比误选两段更糟，因为它看起来像"就这一行"）。
 * 逐行的 span 仍然逐行认领（判定用中心点），只是不再逐行成组。
 *
 * 判定用**中心点命中**：行 bbox 高度贴合该行字形，中心点几乎不会跨界，
 * 因此跨行不会互相吞并 —— 这是启发式做不到的稳定性。
 *
 * @param lines 行级矩形，归一化坐标（与 `PdfReadingBlock.lines` 同一坐标系）。
 * @returns 该 block（即该段落）的 span 列表，按阅读顺序排列。
 */
export function collectBlockSpansByLines(
  spans: TextSpanGeometry[],
  lines: ReadonlyArray<{ rect: { x: number; y: number; width: number; height: number } }>,
  layerRect: BoxRect,
): TextSpanGeometry[] {
  if (!lines.length) return [];
  const seen = new Set<HTMLElement>();
  const members: TextSpanGeometry[] = [];

  for (const line of lines) {
    const box = {
      left: layerRect.left + line.rect.x * layerRect.width,
      top: layerRect.top + line.rect.y * layerRect.height,
      right: layerRect.left + (line.rect.x + line.rect.width) * layerRect.width,
      bottom: layerRect.top + (line.rect.y + line.rect.height) * layerRect.height,
    };
    // 行高退化（bbox 缺失或被压成一条）时无法用中心点判定，放宽到相交。
    const degenerate = box.bottom - box.top <= 0.5;
    for (const span of spans) {
      const rect = span.rect;
      if (rect.width <= 0 || rect.height <= 0) continue;
      const hit = degenerate
        ? rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom
        : (() => {
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            return (
              centerX >= box.left && centerX <= box.right && centerY >= box.top && centerY <= box.bottom
            );
          })();
      if (!hit) continue;
      // 相邻两行命中同一个 span（长 span 横跨两行 bbox）时只收一次，
      // 否则该 span 会被追加两次，划词文本里同一个词出现两遍。
      if (seen.has(span.node)) continue;
      seen.add(span.node);
      members.push(span);
    }
  }

  return members;
}
