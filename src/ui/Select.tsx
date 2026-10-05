import type { SelectHTMLAttributes } from "react";
import { cn } from "./cn";
import { FIELD } from "./fieldStyles";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export function Select({ className, ...rest }: SelectProps) {
  return <select className={cn(FIELD, "cursor-pointer", className)} {...rest} />;
}
