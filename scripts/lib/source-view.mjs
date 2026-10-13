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

/** `/` 前面是这个字符时，它只可能是正则字面量的开头，不可能是除号。 */
const REGEX_CAN_FOLLOW = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "~", "^", "<", ">", ""]);
/** `/` 前面是这个关键字时同理（`return /…/`、`typeof /…/`、`case /…/`）。 */
const REGEX_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else", "yield", "await", "throw"]);

/**
 * 从 `text[start]`（=== `/`）尝试读出一个正则字面量，返回它的结束偏移；不像正则则返回 -1。
 *
 * 判错的代价是**不对称**的，所以这个启发式够用：把除号误判成正则，最多是少看一小段
 * 代码里的注释（本仓这些片段里没有注释）；把正则误判成除号，则会让字符类里的引号
 * 带偏整个文件 —— 后者正是要根除的那个失效。
 */
function scanRegexLiteral(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") return -1; // 正则字面量不跨行；跨行说明这其实是除号
    if (c === "\\") { i += 2; continue; }
    if (inClass) { if (c === "]") inClass = false; i += 1; continue; }
    if (c === "[") { inClass = true; i += 1; continue; }
    if (c === "/") {
      i += 1;
      while (i < text.length && /[a-z]/i.test(text[i])) i += 1; // flags
      return i;
    }
    i += 1;
  }
  return -1;
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
 * 正则字面量、`"/*"`）。
 *
 * ★ 2026-10-10：补上**正则字面量**识别。原先的状态机不认 `/.../`，于是
 * `readerCore.ts` 的 `.replace(/[\\/:*?"<>|]/g, "-")`（**字符类里带一个双引号**）
 * 会让它从这个 `"` 进入「字符串」状态，此后整份文件被错位解析：实测
 * readerCore + App.tsx 合计 196 行注释**没有被剥掉**，以「代码」的身份留在视图里。
 * 而负断言扫的正是这个视图 —— 它命中的会是注释里的词（本仓 App.tsx 另有 2 处
 * 同类写法，`assistantMarkdown.ts` 1 处）。加文本层几何负断言时就真的被自己的
 * 注释绊红了一次，才顺藤查到根上。
 *
 * 代价是模板串里的 `${}` 未做嵌套解析 —— 本仓够用，真需要时再加深。
 */
export function stripComments(text) {
  let out = "";
  let i = 0;
  let state = "code"; // code | line | block | sq | dq | tpl
  /** 最近一个「有效」字符（跳过空白与注释），用来判断 `/` 是除号还是正则开头。 */
  let lastSignificant = "";
  /** 最近一个标识符（同上），用来识别 `return /…/` 这类关键字前缀。 */
  let lastWord = "";
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; i += 2; out += "  "; continue; }
      if (c === "/" && n === "*") { state = "block"; i += 2; out += "  "; continue; }
      if (c === "/") {
        if (REGEX_CAN_FOLLOW.has(lastSignificant) || REGEX_KEYWORDS.has(lastWord)) {
          const end = scanRegexLiteral(text, i);
          if (end > 0) {
            out += text.slice(i, end);
            lastSignificant = "/";
            lastWord = "";
            i = end;
            continue;
          }
        }
        out += c; lastSignificant = c; lastWord = ""; i += 1; continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        state = c === "'" ? "sq" : c === '"' ? "dq" : "tpl";
        out += c; lastSignificant = c; lastWord = ""; i += 1; continue;
      }
      out += c;
      if (!/\s/.test(c)) {
        lastSignificant = c;
        lastWord = /[A-Za-z0-9_$]/.test(c) ? lastWord + c : "";
      }
      i += 1; continue;
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
    // 字符串 / 模板串内部
    if (c === "\n") {
      // ★ 自愈闸：单引号与双引号字符串**不可能**跨行，走到这里就说明前面某处判错了
      // （正则里的引号、属性访问里的撇号…）。不复位的话，一次失步会污染到文件结尾，
      // 而症状是「注释变成代码」这类静默错误。复位后爆炸半径被限制在一行以内。
      // 模板串可以合法跨行，所以不在这里复位。
      if (state === "sq" || state === "dq") state = "code";
      out += c; i += 1; continue;
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

  // ---- 正则字面量：`readerCore.ts` 那条 `.replace(/[\\/:*?"<>|]/g, "-")` 的原形 ----
  // 字符类里带一个双引号 —— 不认正则的状态机会从这里进入「字符串」状态，
  // 此后整份文件错位（实测 196 行注释因此没被剥掉，以「代码」身份留在视图里）。
  const regexSrc = [
    'const s = name.replace(/[\\\\/:*?"<>|]/g, "-");',
    "// 注释里的暗号 4321",
    "const real = 7;",
  ].join("\n");
  const regexStripped = stripComments(regexSrc);
  const regexCases = [
    ["正则里的引号不再带偏状态（后面的注释仍被剥掉）", regexStripped.includes("4321"), false],
    ["正则字面量本身原样保留", regexStripped.includes('/[\\\\/:*?"<>|]/g'), true],
    ["后续代码未被吞掉", regexStripped.includes("const real = 7;"), true],
    ["行数不变", regexStripped.split("\n").length, regexSrc.split("\n").length],
  ];
  // ---- 自愈闸：一行里的未闭合引号不得污染后面所有行 ----
  const leakSrc = ['const a = "未闭合;', "// 暗号 9876", "const real = 2;"].join("\n");
  const leakStripped = stripComments(leakSrc);
  regexCases.push(
    ["失步被限制在当行（后续行注释仍被剥掉）", leakStripped.includes("9876"), false],
    ["失步不吞掉后续代码", leakStripped.includes("const real = 2;"), true],
  );
  for (const [name, got, want] of regexCases) {
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
