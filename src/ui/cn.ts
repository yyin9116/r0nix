/**
 * className 合并工具
 * ---------------------------------------------------------------------------
 * 只要有一处 `className={a + " " + b}`，就说明「变体应当用 props 表达」这条规则
 * 没有载体。本文件提供最小实现，避免引入 clsx / tailwind-merge 这类依赖：
 * 本仓库的 primitive 只做「基类 + 变体 + 调用方补充」三段拼接，
 * 顺序固定、不需要冲突消解。
 */
export type ClassValue = string | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
