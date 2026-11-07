"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** Tracks the pointer so `.spotlight` cards can light up under the cursor. */
export function useSpotlight<T extends HTMLElement>() {
  return React.useCallback((e: React.MouseEvent<T>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  }, []);
}

export function Card({ className, spotlight = true, onMouseMove, ...props }: React.HTMLAttributes<HTMLDivElement> & { spotlight?: boolean }) {
  const track = useSpotlight<HTMLDivElement>();
  return (
    <div
      onMouseMove={(e) => { if (spotlight) track(e); onMouseMove?.(e); }}
      className={cn("rounded-xl border border-line bg-surface", spotlight && "spotlight", className)}
      {...props}
    />
  );
}

export function CardHeader({ title, description, action, icon, className }: {
  title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; icon?: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4 border-b border-line px-5 py-4", className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon && <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line text-muted [&_svg]:size-4">{icon}</span>}
        <div className="min-w-0">
          <h2 className="font-sans text-[15px] font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-[13.5px] leading-relaxed text-muted">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}
