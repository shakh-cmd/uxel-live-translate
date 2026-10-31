import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl font-extrabold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-brand-blue text-white hover:bg-[#0069d9]",
        navy: "bg-brand-navy text-white hover:bg-[#081f4d]",
        danger: "bg-brand-red text-white hover:bg-[#e13228]",
        yellow: "bg-brand-yellow text-brand-navy hover:bg-[#f0b800]",
        outline: "border-2 border-brand-navy bg-white text-brand-navy hover:bg-slate-50",
        ghost: "bg-transparent text-brand-navy hover:bg-white/70",
      },
      size: {
        default: "min-h-12 px-4 text-base",
        lg: "min-h-16 w-full px-6 text-lg",
        sm: "min-h-9 px-3 text-sm",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";
