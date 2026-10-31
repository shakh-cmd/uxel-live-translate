import * as React from "react";
import { cn } from "../../lib";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-3xl bg-white p-4 shadow-card", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-sm font-extrabold uppercase tracking-wide text-brand-navy/70", className)} {...props} />;
}
