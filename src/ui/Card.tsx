import type { HTMLAttributes } from "react";
import { cn } from "./cn";

/**
 * Card —— 面板内的一组分块容器
 * ---------------------------------------------------------------------------
 * 对应变更前反复手写的
 * `bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl`。
 * 那两对 zinc 恰好就是 --surface-app 与 --border-subtle，所以这里是一次
 * 取值完全相等的替换 —— 深浅色都一致，没有视觉变化。
 *
 * 内边距/分隔线属于布局，用 className 传（`p-5`、`divide-y divide-border-subtle`）。
 */
export type CardProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...rest }: CardProps) {
  return <div className={cn("rounded-xl border border-border-subtle bg-surface-app", className)} {...rest} />;
}
