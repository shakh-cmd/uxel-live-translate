import type { HTMLAttributes } from "react";
import { cn } from "../../lib";

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-brand-navy/10 px-3 py-1 text-xs font-extrabold uppercase tracking-wide text-brand-navy",
        className,
      )}
      {...props}
    />
  );
}
