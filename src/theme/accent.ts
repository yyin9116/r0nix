import type { ThemeAccent } from "../services/userSettings";

/**
 * 运行时强调色 —— 全应用唯一真相
 * ---------------------------------------------------------------------------
 * 为什么单独成一个模块：这 6 组值曾经在三个地方各写一份 ——
 *   ① App.tsx 的 ACCENT_TOKENS（真正注入 --reader-accent 的那份）
 *   ② tokens.css 里抄的一份 --palette-accent-*（已删）
 *   ③ Settings.tsx 强调色色板按钮里的三元表达式，手写 6 个字面色值
 * 于是「加一个强调色」要改三处，漏一处就出现「色板能选、界面不跟随」。
 * 现在只有这里一份：色板、注入、令牌派生都从这里取。
 *
 * 注意：这些值必须在运行时以 CSS 变量注入到 :root（见 App.tsx），
 * 不能在 tokens.css 里写成 --palette-accent-* 之类的静态令牌 ——
 * 它们是「用户可选集合」，不是设计刻度，静态化会产生第二处真相。
 */
export const ACCENT_TOKENS: Record<ThemeAccent, { solid: string; soft: string; contrast: string }> = {
  /**
   * zinc 是唯一一个「这两组值不相等」的选项，务必分清：
   *   - 这里（以及其它 5 个）是**色板圆点**用的示意色，Settings.tsx 直接读 `.solid`。
   *   - 真正注入 --reader-accent 的是 `resolveAccentToken()`，zinc 在那里分浅色/深色两档。
   * 为什么不让色板也读实际值：zinc 的实际值随主题反相（浅色近乎黑、深色近乎白），
   * 两种主题下拿它画圆点都很难看且难以辨认 —— 色板需要的是一个中性的灰。
   */
  zinc: { solid: "#52525b", soft: "rgba(82, 82, 91, 0.16)", contrast: "#ffffff" },
  blue: { solid: "#2563eb", soft: "rgba(37, 99, 235, 0.14)", contrast: "#ffffff" },
  green: { solid: "#059669", soft: "rgba(5, 150, 105, 0.14)", contrast: "#ffffff" },
  orange: { solid: "#ea580c", soft: "rgba(234, 88, 12, 0.14)", contrast: "#ffffff" },
  rose: { solid: "#e11d48", soft: "rgba(225, 29, 72, 0.14)", contrast: "#ffffff" },
  violet: { solid: "#7c3aed", soft: "rgba(124, 58, 237, 0.14)", contrast: "#ffffff" },
};

export type AccentTokens = (typeof ACCENT_TOKENS)[ThemeAccent];
export type ResolvedTheme = "light" | "dark";

/**
 * zinc 是「无色强调色」：它在浅色下要深、深色下要浅，否则落在同色表面上会看不见。
 * 其余 5 个彩色选项在两种模式下用同一个值。
 */
export function resolveAccentToken(accent: ThemeAccent, theme: ResolvedTheme): AccentTokens {
  if (accent !== "zinc") return ACCENT_TOKENS[accent] || ACCENT_TOKENS.zinc;
  return theme === "dark"
    ? { solid: "#f4f4f5", soft: "rgba(244, 244, 245, 0.12)", contrast: "#18181b" }
    : { solid: "#18181b", soft: "rgba(24, 24, 27, 0.08)", contrast: "#ffffff" };
}
