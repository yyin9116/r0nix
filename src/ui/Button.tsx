import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

/**
 * Button —— 本应用唯一的按钮基元
 * ---------------------------------------------------------------------------
 * 变更前，同一套「按钮观感」在 TSX 里被手写了 20+ 次，每次都带上自己的
 * `dark:` 配对（`bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 …`），
 * 于是深浅色是两份真相，任何一处漏配对都不会被构建拦住。
 * 这里只消费语义令牌，**不写任何 `dark:` 变体** —— 令牌层已经处理了深浅色。
 *
 * 变体只用 props 表达，不要在外面拼 className 字符串改颜色；
 * `className` 只用来描述布局（宽度、外边距、flex 伸缩）。
 */
export type ButtonVariant =
  /** 主操作：实心强调色。一处改，全应用跟随用户选中的强调色。 */
  | "accent"
  /** 次级操作：中性填充，与输入框并排时的「浏览 / 添加」。 */
  | "neutral"
  /** 描边式：浮层里的按钮，靠描边建立层级。 */
  | "outline"
  /** 危险操作：删除、清空。 */
  | "danger";

export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:opacity-60 disabled:pointer-events-none";

const SIZE: Record<ButtonSize, string> = {
  /** 紧凑：开关胶囊、行内小按钮 */
  sm: "px-3 py-1.5 text-xs",
  /** 默认：与表单控件同高（px-3 py-2） */
  md: "px-3 py-2 text-sm",
};

const VARIANT: Record<ButtonVariant, string> = {
  /**
   * 文字色必须是 text-accent-on，不能写 white：
   * zinc 强调色在深色下的 solid 是 #f4f4f5，写死白字会变成「近白底 + 白字」，
   * 实测对比度 1.08:1（几乎不可见）。--accent-on 正是为这种情况存在的。
   */
  accent: "bg-accent text-accent-on hover:opacity-90",
  neutral: "bg-surface-hover text-content-primary hover:bg-surface-active",
  outline: "border border-border-default bg-surface-panel text-content-secondary hover:bg-surface-hover hover:text-content-primary",
  danger: "border border-state-danger-border bg-state-danger-tint text-state-danger hover:bg-state-danger-border",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = "neutral", size = "md", className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cn(BASE, SIZE[size], VARIANT[variant], className)} {...rest} />;
}
