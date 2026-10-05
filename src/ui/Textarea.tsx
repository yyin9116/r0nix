import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn";
import { FIELD } from "./fieldStyles";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(FIELD, "resize-y leading-5", className)} {...rest} />;
});
