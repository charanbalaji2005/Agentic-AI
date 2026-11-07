import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-4", {
  variants: {
    tone: {
      neutral: "border-line bg-sunken/80 text-muted",
      ok: "border-ok/30 bg-ok/10 text-ok",
      warn: "border-warn/35 bg-warn/10 text-warn",
      danger: "border-danger/30 bg-danger/10 text-danger",
      info: "border-accent/30 bg-accent/10 text-accent",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, dot, pulse, children, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants> & { dot?: boolean; pulse?: boolean }) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && (
        <span className="relative flex size-1.5">
          {pulse && <span className="absolute inset-0 animate-pulse-ring rounded-full bg-current" />}
          <span className="relative size-1.5 rounded-full bg-current" />
        </span>
      )}
      {children}
    </span>
  );
}
