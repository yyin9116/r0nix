/**
 * 设计系统组件层（primitive）
 * ---------------------------------------------------------------------------
 * 存在的理由：设计系统的载体是组件，不是散落的 className。
 * 只要没有这一层，新写的界面就会继续长出 `bg-white dark:bg-zinc-900 border-zinc-200
 * dark:border-zinc-800` 这类「深浅两份真相」，规范文档也拦不住。
 *
 * 硬规则：
 *   1. primitive 只消费语义令牌（bg-surface-panel / text-content-muted / …），
 *      不写 `dark:` 变体 —— 令牌层已经处理了深浅色。
 *   2. 变体用 props 表达。className 只用于布局（宽度、外边距、flex），
 *      不要用它覆盖颜色。
 *   3. 只建当前真有使用者的 primitive。这份清单是「已经被采用」的记录，
 *      不是「打算将来用到」的愿望清单 —— 没有消费者的刻度会被下一个人当成
 *      必须遵守的规范，反而制造新的不一致。
 *
 * 尚未建立（等第一个真实调用点出现再加）：Dialog、MenuItem、Tooltip、EmptyState。
 * 注意浮层类组件在建立时要一并解决 portal 挂载点的令牌继承问题。
 */
export { cn } from "./cn";
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";
export { IconButton, type IconButtonProps, type IconButtonTone } from "./IconButton";
export { TextInput, type TextInputProps } from "./TextInput";
export { Textarea, type TextareaProps } from "./Textarea";
export { Select, type SelectProps } from "./Select";
export { Card, type CardProps } from "./Card";
export { FIELD } from "./fieldStyles";
