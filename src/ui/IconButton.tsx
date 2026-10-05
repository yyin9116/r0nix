import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

/**
 * IconButton —— 只有图标的按钮
 * ---------------------------------------------------------------------------
 * `label` 是**必填**的：图标按钮没有可见文字，不给无障碍名字就是键盘/读屏用户的
 * 死路。把 aria-label 做成必填参数，是让「无障碍」由类型系统兜住，而不是靠自觉。
 */
export type IconButtonTone = "muted" | "danger" | "accent";

const TONE: Record<IconButtonTone, string> = {
  /** 默认：静止时弱化，hover 才提亮（工具栏、列表行内的图标） */
  muted: "text-content-muted hover:bg-surface-hover hover:text-content-primary",
  /** 删除类：静止弱化，hover 变危险色 */
  danger: "text-content-muted hover:bg-state-danger-tint hover:text-state-danger",
  /** 强调类：激活态 */
  accent: "text-accent hover:bg-surface-hover",
};

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** 无障碍名称，必填。 */
  label: string;
  tone?: IconButtonTone;
}

export function IconButton({ label, tone = "muted", className, type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md p-2 transition-colors disabled:opacity-50 disabled:pointer-events-none",
        TONE[tone],
        className,
      )}
      {...rest}
    />
  );
}
