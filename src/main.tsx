import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import packageMeta from "../package.json";

const SPLASH_MIN_DURATION_MS = 1000;
const splashStartedAt =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <App />
);

const splashVersionEl = document.getElementById("app-splash-version");
if (splashVersionEl) {
  splashVersionEl.textContent = `v${packageMeta.version}`;
}

const splashEl = document.getElementById("app-splash");
if (splashEl) {
  const now =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const elapsed = Math.max(0, now - splashStartedAt);
  const waitMs = Math.max(0, SPLASH_MIN_DURATION_MS - elapsed);
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
  window.setTimeout(() => {
    hideSplash();
  }, waitMs);

  window.setTimeout(() => {
    if (splashEl.isConnected) {
      hideSplash();
    }
  }, waitMs + 800);
}
