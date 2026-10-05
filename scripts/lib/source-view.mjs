/**
 * source-view —— 契约守卫读源码时用的「忽略空白」视图
 * ---------------------------------------------------------------------------
 * 为什么需要：
 * 这些守卫原本一律写成 `readFileSync(...).includes("a = b")`，是**逐字符精确**匹配。
 * 只要源码被格式化器动过一处空格（`x = "y"` 压成 `x="y"`、`? "a" : "b"` 压成
 * `? "a":"b"`、`,` 后空格消失），后果是双向的、而且两边都不报错：
 *
 *   ① 正断言 `assert(src.includes(...))` → 静默失败。门禁变红，但红的原因看起来
 *      像「代码丢了功能」，而不是「匹配方式太脆」。
 *   ② 负断言 `assert(!src.includes(...))` → 静默放行。更危险：它意味着
 *      「禁止的写法」从此拦不住，而守卫仍然打印 ok。
 *
 * 本仓库已实际发生：`src/components/PDFViewer.tsx` / `App.tsx` 被压缩过空格，
 * 16 条契约里的 6 条同时失效，`npm run check:contracts` 一直红着没人敢看 ——
 * 等价于全部契约零约束。
 *
 * 解决办法：`includes` 按「去掉全部空白后比较」。这对负断言是**增强**：
 * 原先要求某个精确换行/缩进的写法，现在任何空白变体都能抓到。
 *
 * 有意保留原样的部分：
 *   - `indexOf` 按原文偏移。守卫用它做 `slice` 切区间和先后顺序比较，
 *     锚点都是标识符串（`const x = useCallback`），不受空格压缩影响。
 *   - `match` 按原文跑正则。用正则的断言自己负责写 `\s*`。
 *   - 其余方法（`split` / `replace` / `length` …）原样透传。
 *
 * 已知取舍：`includes` 容忍空白后，跨 token 的巧合命中成为可能
 * （needle `foo bar` 会命中源码里的标识符 `foobar`）。实践中针都是带标点的代码片段，
 * 这种巧合远小于「空格一变守卫就死」的代价。
 */
export const flat = (value) => String(value).replace(/\s+/g, "");

/**
 * 把源码包成断言视图。
 * @param {string} text 源码原文
 */
export function view(text) {
  const squashed = flat(text);
  return new Proxy(Object(text), {
    get(target, prop) {
      if (prop === "flat") return squashed;
      if (prop === "raw") return text;
      if (prop === "includes") {
        return (needle) => squashed.includes(flat(needle));
      }
      // 切片也返回视图，避免「切完之后又变回精确匹配」的漏网
      if (prop === "slice") {
        return (start, end) => view(text.slice(start, end));
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * 去掉源码里的注释，返回**行数不变**的文本（注释位置换成空格，换行原样保留）。
 *
 * 为什么单独有这个函数：`view()` 解决的是「空白被压缩」，它**不碰注释**。
 * 而用正则扫「禁止的写法」时，注释是必须排除的 —— §14 记载过本仓真实教训：
 * 在原始文本上匹配会把注释里的示例值算成违规，于是有人为了压低基线，
 * 把注释里「实测对比度 1.08:1」这样的证据写得含糊。**证据被守卫吃掉，
 * 比多一条违规严重得多。**
 *
 * 用状态机而不是正则：字符串里的 `//` 与 `/*` 不能当注释开（`https://…`、
 * 正则字面量、`"/*"`）。代价是模板串里的 `${}` 未做嵌套解析 —— 本仓够用，
 * 真需要时再加深。
 */
export function stripComments(text) {
  let out = "";
  let i = 0;
  let state = "code"; // code | line | block | sq | dq | tpl
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; i += 2; out += "  "; continue; }
      if (c === "/" && n === "*") { state = "block"; i += 2; out += "  "; continue; }
      if (c === "'" || c === '"' || c === "`") { state = c === "'" ? "sq" : c === '"' ? "dq" : "tpl"; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; }
      i += 1; continue;
    }
    if (state === "block") {
      if (c === "\n") { out += c; i += 1; continue; }   // 保住行号
      if (c === "*" && n === "/") { state = "code"; i += 2; out += "  "; continue; }
      i += 1; continue;
    }
    // 字符串内部：转义符后一个字符原样吞掉
    if (c === "\\") { out += c + (text[i + 1] ?? ""); i += 2; continue; }
    out += c;
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) state = "code";
    i += 1;
  }
  return out;
}

/**
 * 自检：证明 view() 既不空转（该拦的能拦），也不误判（同义写法等价）。
 * 之所以把自检写进模块本身而不是只跑一次：本文件的失败模式是**静默**的
 * ——过松会让负断言永不触发，过紧会让正断言全灭。两种都不会抛异常，
 * 只会让 16 条契约里的一部分悄悄失去意义。所以它必须有个可重复的探针。
 * 直接执行 `node scripts/lib/source-view.mjs` 即可运行。
 */
export function selfTest() {
  const v = view("const a = 1;\nif (x) { y(); }\nnode.style.transformOrigin =`${a}%`;");
  const cases = [
    ["精确写法（含空格）", v.includes("const a = 1;"), true],
    ["被压缩的写法", v.includes("const a=1;"), true],
    ["取值不同必须为假", v.includes("const a = 2;"), false],
    ["取值不同（压缩）", v.includes("const a=2;"), false],
    ["负断言：禁止写法不得命中", v.includes("if (x) { z(); }"), false],
    ["负断言：目标写法仍可命中", v.includes("if (x) { y(); }"), true],
    ["跨行与缩进无关", v.includes("if(x){y();}"), true],
    ["模板字面量（含空格）", v.includes("node.style.transformOrigin =`${a}%`;"), true],
    ["模板字面量（压缩）", v.includes("node.style.transformOrigin=`${a}%`;"), true],
  ];
  const failures = cases.filter(([, got, want]) => got !== want);

  // ---- stripComments 自检：重点在「该剥的剥、不该剥的留下、行数不变」----
  const src = [
    "const a = 1; // 说明里的 80ms 不该被算作违规",
    "/** 块注释里的 500ms 同样不该算 */",
    "const url = \"https://example.com\"; // 行尾",
    "const s = \"a//b\"; /* 尾注 */",
    "const real = 120;",
  ].join("\n");
  const stripped = stripComments(src);
  const commentCases = [
    ["行注释被剥掉", !stripped.includes("80ms"), true],
    ["块注释被剥掉", !stripped.includes("500ms"), true],
    ["代码里的真实值保留", stripped.includes("const real = 120;"), true],
    ["字符串里的 // 不是注释", stripped.includes('"https://example.com"'), true],
    ["字符串里的 a//b 保留", stripped.includes('"a//b"'), true],
    ["行数不变（保住行号）", stripped.split("\n").length, src.split("\n").length],
  ];
  for (const [name, got, want] of commentCases) {
    if (got !== want) failures.push([`stripComments · ${name}`, got, want]);
  }
  return failures;
}

if (process.argv[1] && process.argv[1].endsWith("source-view.mjs")) {
  const failures = selfTest();
  for (const [name, got, want] of failures) console.log("FAIL  " + name + "  得到 " + got + " 期望 " + want);
  if (failures.length === 0) {
    console.log("source-view: ok（既能拦住，也不误判）");
  } else {
    console.error("source-view: " + failures.length + " 项自检失败 —— 依赖 view() 的契约守卫已不可信");
    process.exit(1);
  }
}
