// 必须排在 `./App` 之前：ESM 会先深度优先求值整张依赖图，之后才执行本模块的语句。
// 见 devErrorSink 的说明 —— 依赖图求值期抛错时，写在函数体里的注册根本不会执行。
import "./services/devErrorSink";
import "./services/devRuntimeCensus";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import packageMeta from "../package.json";

const SPLASH_MIN_DURATION_MS = 1000;
/**
 * 字体就绪后再等多久才淡出启动屏。
 *
 * 为什么必须等：App 的正文用 Inter / Noto Sans SC（index.css 的 Google Fonts
 * @import 异步加载）。启动屏若在字体到位前淡出，读者会看到整屏文字
 * 「由系统字体跳成 Inter」—— 2026-10-08 实测的启动页字体变化就是这个。
 * 等 fonts.ready 把这一次跳变藏在启动屏背后，代价只是启动屏多停留几百毫秒。
 *
 * 上限必须存在：Google Fonts 是网络请求，离线 / 被墙 / 请求失败时
 * fonts.ready 可能很晚才 settle（甚至不 settle）。启动屏是**第一眼**的东西，
 * 不能让它挂在屏幕上等一个第三方 CDN。
 */
const SPLASH_FONTS_GRACE_MS = 1200;
const splashStartedAt =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <App />
);

/**
 * 版本号只有一个来源：Vite 的 transformIndexHtml 把 `%APP_VERSION%` 换成
 * package.json 的 version（见 vite.config.ts）。
 *
 * 旧实现在这里再写一次 `v${packageMeta.version}`，两处各自为政 ——
 * 改版本号的方式一变（比如从 package.json 换成构建期注入），
 * 启动屏就会显示一个值、App 里显示另一个值。这里退成兜底：
 * 只在占位符**没被替换**时才写，正常路径下一行都不执行。
 */
const splashVersionEl = document.getElementById("app-splash-version");
if (splashVersionEl && splashVersionEl.textContent?.includes("%APP_VERSION%")) {
  splashVersionEl.textContent = `v${packageMeta.version}`;
}

const splashEl = document.getElementById("app-splash");
if (splashEl) {
  const now = () =>
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const hideSplash = () => {
    if (!splashEl.isConnected) return;
    splashEl.classList.add("hide");
    window.setTimeout(() => {
      if (splashEl.isConnected) {
        splashEl.remove();
      }
    }, 260);
  };

  // In hidden/paused WebView (e.g. embedded preview), rAF may never fire.
  const scheduleHide = (extraDelayMs: number) => {
    const waitMs = Math.max(0, SPLASH_MIN_DURATION_MS + extraDelayMs - (now() - splashStartedAt));
    window.setTimeout(hideSplash, waitMs);
    // 二次保险：即便上面的定时器被系统节流（后台标签页）也会走到这里。
    window.setTimeout(hideSplash, waitMs + 800);
  };

  // document.fonts 在极老的环境里可能不存在 —— 那就直接按最短时长淡出。
  if (typeof document !== "undefined" && document.fonts?.ready) {
    // catch：字体加载失败不该把启动屏永久钉在屏幕上。
    void document.fonts.ready
      .catch(() => undefined)
      .then(() => scheduleHide(SPLASH_FONTS_GRACE_MS));
    // fonts.ready 不 settle 时的兜底：只等最短时长。
    scheduleHide(0);
  } else {
    scheduleHide(0);
  }
}
