import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "./cn";
import { FIELD } from "./fieldStyles";

export type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

/**
 * 用 forwardRef：表单控件经常需要外部拿 ref 做聚焦（例如「跳转到快捷链接」
 * 会把焦点落到标题输入框）。React 18 里函数组件的 ref 必须显式转发，
 * 否则 `<TextInput ref={x} />` 会编译报错而不是静默失效。
 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className, type = "text", ...rest },
  ref,
) {
  return <input ref={ref} type={type} className={cn(FIELD, className)} {...rest} />;
});
