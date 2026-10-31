import * as React from "react";
import { cn } from "../../lib";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-28 w-full rounded-2xl border-2 border-slate-200 bg-white px-4 py-3 text-base font-semibold text-brand-navy outline-none placeholder:text-slate-400 focus:border-brand-blue",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
