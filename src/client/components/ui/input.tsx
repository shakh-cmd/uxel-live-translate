import * as React from "react";
import { cn } from "../../lib";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex min-h-12 w-full rounded-2xl border-2 border-slate-200 bg-white px-4 text-base font-semibold text-brand-navy outline-none placeholder:text-slate-400 focus:border-brand-blue",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
