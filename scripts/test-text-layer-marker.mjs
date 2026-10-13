/**
 * `TextLayerMarker` 的行为断言。
 *
 * 覆盖三件事，每件都对应一个实测过的 bug：
 *
 * 1. **行级 bbox 能把一段切成两段**（`splitSpansIntoParagraphsByLines`）
 *    —— 此前用几何启发式，实测「点一下选了两段」。
 * 2. **区间落在正确的 div 上**（`convertMatches` / `rangesFromSpans`）
 *    —— 错位就是「波浪线跑到别的段落」。
 * 3. **CSS class 成对**：切出来的片段必须同时拿到 `${className} appended`
 *    与首/中/尾修饰类。少任一条都会让波浪线在跨行处断开或首尾多出方角
 *    —— 前者像渲染坏了，后者像贴歪的便签。
 */
import assert from "node:assert/strict";
import { TextLayerMarker } from "../src/components/pdfReader/textLayerMarker.ts";

/**
 * 极简 DOM。marker 只用到 createElement / createTextNode / append /
 * before / textContent / className / nodeType，够用即可。
 */
class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.childNodes = [];
    this.className = "";
  }
  append(node) {
    this.childNodes.push(node);
    return node;
  }
  before() {}
  get textContent() {
    if (this.nodeType === 3) return this._text ?? "";
    return this.childNodes.map((child) => child.textContent).join("");
  }
  /**
   * 元素节点赋值 = 清空子节点并塞一个文本子节点（与 DOM 一致）。
   * 文本节点赋值 = 直接改 `_text`（没有子节点）。
   */
  set textContent(value) {
    if (this.nodeType === 3) {
      this._text = value;
      return;
    }
    this.childNodes = [];
    if (value !== "") {
      const node = new FakeNode(3);
      node._text = value;
      this.childNodes.push(node);
    }
  }
}

class FakeTextDiv extends FakeNode {
  constructor(text) {
    super(1);
    this.textContent = text;
  }
}

// ⚠️ 必须补上这个常量：marker's `#append` 用 `div.nodeType === Node.TEXT_NODE`
// 判断「div 已退化成文本节点」，缺了它判断恒为 false，桩的行为就和真实 DOM 不一致了。
FakeNode.TEXT_NODE = 3;

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: () => new FakeNode(1),
  createTextNode: (content) => {
    const node = new FakeNode(3);
    node._text = content;
    return node;
  },
};

function makeMapping(items) {
  const divs = items.map((text) => new FakeTextDiv(text));
  const texts = [...items];
  return { divs, texts };
}

/** 收集某个 div 当前的 class 序列（含 appended 片段）。 */
function classTree(div) {
  const out = [];
  const walk = (node) => {
    if (node.className) out.push(node.className);
    for (const child of node.childNodes) walk(child);
  };
  walk(div);
  return out;
}

function textOf(div) {
  return div.textContent;
}

// ── 1. convertMatches：字符下标 → 区间 ────────────────────────────────────
{
  const { divs, texts } = makeMapping(["Hello ", "world ", "again"]);
  const marker = new TextLayerMarker();
  marker.setTextMapping(divs, texts);

  // "world again" = 从 6 开始、长度 11。
  const ranges = marker.convertMatches([6], [11]);
  assert.equal(ranges.length, 1, "应产出一个区间");
  assert.deepEqual(ranges[0].begin, { divIdx: 1, offset: 0 }, "起点应在第 2 个 div 的偏移 0");
  assert.deepEqual(ranges[0].end, { divIdx: 2, offset: 5 }, "终点应落在第 3 个 div 的偏移 5");

  // 越界不得抛错，也不得产出无效区间。
  assert.deepEqual(marker.convertMatches([9999], [10]), [], "越界应返回空数组而不是崩");
  assert.deepEqual(marker.convertMatches([], []), [], "空输入返回空数组");
}

// ── 2. rangesFromSpans：几何 → 区间 ───────────────────────────────────────
{
  const { divs, texts } = makeMapping(["one", "two", "three"]);
  const marker = new TextLayerMarker();
  marker.setTextMapping(divs, texts);
  assert.equal(marker.indexOf(divs[1]), 1, "span 应能反查到自己的下标");
  assert.equal(marker.indexOf(new FakeTextDiv("x")), -1, "陌生节点应返回 -1");
}

// ── 3. 切分：单 div 区间 ─────────────────────────────────────────────────
{
  const { divs, texts } = makeMapping(["abcdef"]);
  const marker = new TextLayerMarker();
  marker.setTextMapping(divs, texts);

  marker.setGroups([
    {
      className: "r0nix-marker-wavy",
      ranges: [{ begin: { divIdx: 0, offset: 1 }, end: { divIdx: 0, offset: 4 } }],
    },
  ]);

  assert.equal(textOf(divs[0]), "abcdef", "切分后原文必须完整无损");
  const classes = classTree(divs[0]);
  assert.ok(
    classes.includes("r0nix-marker-wavy appended"),
    `片段应带 class，实际：${JSON.stringify(classes)}`,
  );
}

// ── 4. 切分：跨 div 区间要拿到 begin / middle / end ─────────────────────
{
  const { divs, texts } = makeMapping(["aaaa", "bbbb", "cccc"]);
  const marker = new TextLayerMarker();
  marker.setTextMapping(divs, texts);

  marker.setGroups([
    {
      className: "r0nix-marker-wavy",
      ranges: [{ begin: { divIdx: 0, offset: 0 }, end: { divIdx: 2, offset: 4 } }],
    },
  ]);

  assert.equal(textOf(divs[0]), "aaaa");
  assert.equal(textOf(divs[1]), "bbbb");
  assert.equal(textOf(divs[2]), "cccc");
  assert.ok(
    classTree(divs[0]).some((name) => name.includes("begin")),
    "首 div 应带 begin",
  );
  assert.ok(
    classTree(divs[1]).some((name) => name.includes("middle")),
    `中间 div 应带 middle，实际：${JSON.stringify(classTree(divs[1]))}`,
  );
  assert.ok(
    classTree(divs[2]).some((name) => name.includes("end")),
    "尾 div 应带 end",
  );
}

// ── 5. 多组共存：波浪线不能被激活底色覆盖 ───────────────────────────────
{
  const { divs, texts } = makeMapping(["xxxx", "yyyy"]);
  const marker = new TextLayerMarker();
  marker.setTextMapping(divs, texts);

  marker.setGroups([
    { className: "r0nix-marker-wavy-a", ranges: [{ begin: { divIdx: 0, offset: 0 }, end: { divIdx: 0, offset: 4 } }] },
    { className: "r0nix-marker-active", ranges: [{ begin: { divIdx: 1, offset: 0 }, end: { divIdx: 1, offset: 4 } }] },
  ]);
  assert.ok(classTree(divs[0]).some((name) => name.startsWith("r0nix-marker-wavy-a")));
  assert.ok(classTree(divs[1]).some((name) => name.startsWith("r0nix-marker-active")));

  // 撤掉一组，另一组必须还在 —— 这是「鼠标扫过不带走 AI 标记」的保证。
  marker.removeClass("r0nix-marker-active");
  assert.ok(
    classTree(divs[0]).some((name) => name.startsWith("r0nix-marker-wavy-a")),
    "撤激活底色不应影响波浪线",
  );
  assert.equal(
    classTree(divs[1]).filter((name) => name.startsWith("r0nix-marker-active")).length,
    0,
    "激活底色应已撤掉",
  );
  assert.equal(textOf(divs[1]), "yyyy", "撤掉后原文必须写回");
}

// ── 6. clear() 后原文与 class 全部复原 ───────────────────────────────────
{
  const { divs, texts } = makeMapping(["hello", "world"]);
  const marker = new TextLayerMarker();
  marker.setTextMapping(divs, texts);
  marker.setGroups([
    { className: "r0nix-marker-wavy", ranges: [{ begin: { divIdx: 0, offset: 0 }, end: { divIdx: 1, offset: 5 } }] },
  ]);
  marker.clear();
  assert.equal(textOf(divs[0]), "hello");
  assert.equal(textOf(divs[1]), "world");
  assert.equal(divs[0].className, "", "clear 后不应残留 class");
  assert.equal(divs[1].className, "");
}

// ── 7. 相邻区间不得互相吞字 ─────────────────────────────────────────────
{
  const { divs, texts } = makeMapping(["abcdefgh"]);
  const marker = new TextLayerMarker();
  marker.setTextMapping(divs, texts);
  marker.setGroups([
    {
      className: "r0nix-marker-wavy",
      ranges: [
        { begin: { divIdx: 0, offset: 0 }, end: { divIdx: 0, offset: 3 } },
        { begin: { divIdx: 0, offset: 3 }, end: { divIdx: 0, offset: 6 } },
      ],
    },
  ]);
  assert.equal(textOf(divs[0]), "abcdefgh", "相邻区间拼起来仍应是完整原文");
}

// ── 8. 无效区间被丢弃，不得让渲染崩 ─────────────────────────────────────
{
  const { divs, texts } = makeMapping(["ok"]);
  const marker = new TextLayerMarker();
  marker.setTextMapping(divs, texts);
  marker.setGroups([
    {
      className: "r0nix-marker-wavy",
      ranges: [
        { begin: { divIdx: 5, offset: 0 }, end: { divIdx: 5, offset: 2 } },
        { begin: { divIdx: 0, offset: 2 }, end: { divIdx: 0, offset: 0 } },
        { begin: { divIdx: 0, offset: 0 }, end: { divIdx: 0, offset: 2 } },
      ],
    },
  ]);
  assert.equal(textOf(divs[0]), "ok", "有效区间仍应生效");
  assert.ok(classTree(divs[0]).some((name) => name.includes("appended")));
}

// ── 9. 未就绪时所有调用都是空操作 ───────────────────────────────────────
{
  const marker = new TextLayerMarker();
  assert.equal(marker.ready, false);
  marker.setGroups([{ className: "x", ranges: [] }]);
  marker.removeClass("x");
  marker.clear();
  assert.equal(marker.divCount(), 0);
  assert.equal(marker.indexOf(new FakeTextDiv("a")), -1);
}

// ── 10. setTextMapping 早于数组填充；enable() 才建索引 ──────────────────
/**
 * 这是**真实浏览器里才暴露**的 bug，务必钉住。
 *
 * pdf.js 的 `TextLayerBuilder.render()`：
 *   const { textDivs } = this.#textLayer;      // 此刻是 []
 *   this.highlighter?.setTextMapping(...);      // ← 传空数组
 *   await this.#textLayer.render();             // ← 这里才逐项 push
 *   this.highlighter?.enable();
 *
 * 所以 `setTextMapping` 只拿到**同一个数组对象的空引用**。若在
 * `setTextMapping` 里就建 `element → divIdx` 索引，之后 `indexOf` 永远返回 -1，
 * 标注一条也画不出来，且**不报任何错**。
 */
{
  // 模拟官方：先传空数组，随后往同一个数组里 push。
  const shared = [];
  const texts = [];
  const marker = new TextLayerMarker();
  marker.setTextMapping(shared, texts);
  assert.equal(marker.divCount(), 0, "setTextMapping 时刻数组确实还是空的");

  const first = new FakeTextDiv("alpha");
  const second = new FakeTextDiv("beta");
  shared.push(first, second);
  texts.push("alpha", "beta");

  // enable() 之前映射还查不到 —— 这正是那条 bug 的形态。
  assert.equal(marker.indexOf(first), -1, "enable 之前索引应尚未建立");

  marker.enable();
  assert.equal(marker.divCount(), 2);
  assert.equal(marker.indexOf(first), 0, "enable 之后应能查到 divIdx");
  assert.equal(marker.indexOf(second), 1);
  assert.equal(marker.lengthAt(1), 4);

  // 建好索引后要能正常画出来。
  marker.setGroups([
    { className: "r0nix-marker-wavy", ranges: [{ begin: { divIdx: 0, offset: 0 }, end: { divIdx: 0, offset: 5 } }] },
  ]);
  assert.ok(classTree(shared[0]).some((name) => name.includes("appended")), "应能渲染出片段");
}

// ── 11. setTextMapping 重来一次必须清掉旧映射 ──────────────────────────
{
  const oldDivs = [new FakeTextDiv("old")];
  const marker = new TextLayerMarker();
  marker.setTextMapping(oldDivs, ["old"]);
  marker.enable();
  assert.equal(marker.indexOf(oldDivs[0]), 0);

  const newDivs = [new FakeTextDiv("new")];
  marker.setTextMapping(newDivs, ["new"]);
  marker.enable();
  assert.equal(marker.indexOf(newDivs[0]), 0, "新映射应生效");
  assert.equal(
    marker.indexOf(oldDivs[0]),
    -1,
    "旧文本层的元素不得再命中 —— 否则缩放重建文本层后标注会画到已废弃的节点上",
  );
}

console.log("textLayerMarker: 11 组断言全部通过");
