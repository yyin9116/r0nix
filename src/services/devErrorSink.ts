/**
 * dev-only：未捕获异常兜底转发到终端。
 *
 * 为什么必须是一个**被最先 import** 的模块：ESM 会先深度优先求值整张依赖图，
 * 之后才执行导入方自己的语句。把注册写在 `main.tsx` 的函数体里，一旦 `./App`
 * 的依赖图在求值期抛错，注册代码根本没机会执行 —— 而那种失败在终端里零痕迹
 * （WebView 的 console 不进终端），症状与「什么都没发生」完全同形。
 * 放在这条首个 import 里，注册发生在 `./App` 求值之前，才兜得住。
 *
 * 转发的通道与项目既有做法一致：`frontend_log` → Rust `eprintln!`。
 */
import { debugError, debugLog } from "./debugLogger";

if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  const describe = (value: unknown): string =>
    value instanceof Error ? value.message : String(value);
  const stackOf = (value: unknown): string | undefined =>
    value instanceof Error ? value.stack?.split("\n").slice(0, 10).join("\n") : undefined;

  // 分诊锚点：能打出这一条，说明本模块求值成功、Tauri 转发通道可用。
  debugLog("devErrorSink", "registered");

  window.addEventListener("error", (event) => {
    debugError("window.error", describe(event.error ?? event.message), {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: stackOf(event.error),
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    debugError("window.unhandledrejection", describe(event.reason), {
      stack: stackOf(event.reason),
    });
  });

  // DOM 探针：延迟上报首屏是否真的挂载。窗口截图之外，这是唯一能区分
  // 「React 没渲染」与「渲染了但 effect 没跑」的证据。
  window.setTimeout(() => {
    const root = document.getElementById("root");
    debugLog(
      "domProbe",
      `rootChildren=${root ? root.childElementCount : "null"} ` +
        `splash=${Boolean(document.getElementById("app-splash"))} ` +
        `bodyLen=${document.body.innerText.length}`,
    );
  }, 4000);
}
