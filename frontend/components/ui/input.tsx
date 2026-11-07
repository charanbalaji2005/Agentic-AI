import * as React from "react";
import { cn } from "@/lib/utils";

const field =
  "w-full rounded-xl border border-line bg-sunken/60 px-3 text-sm text-ink transition-[border-color,box-shadow,background-color] placeholder:text-muted/70 hover:border-muted/40 focus:border-accent/60 focus:bg-surface focus:outline-none focus:ring-4 focus:ring-accent/15 disabled:opacity-60";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { icon?: React.ReactNode }>(
  ({ className, icon, ...props }, ref) =>
    icon ? (
      <div className="relative w-full">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted [&_svg]:size-4">{icon}</span>
        <input ref={ref} className={cn(field, "h-9 pl-9", className)} {...props} />
      </div>
    ) : (
      <input ref={ref} className={cn(field, "h-9", className)} {...props} />
    ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(field, "py-2.5 scroll-thin", className)} {...props} />,
);
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => <select ref={ref} className={cn(field, "h-9 cursor-pointer pr-8", className)} {...props} />,
);
Select.displayName = "Select";

export function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="mb-1.5 block text-[12.5px] font-medium text-ink/90">
      {children}
      {hint && <span className="ml-1.5 font-normal text-muted">{hint}</span>}
    </span>
  );
}
