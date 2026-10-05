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
