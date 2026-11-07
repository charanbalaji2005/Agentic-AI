import { cn } from "@/lib/utils";

/**
 * The Agentic RAG mark: a hub (the aggregator) wired to three agent nodes, held together by a broken orbit.
 * Drawn in `currentColor`, so it takes the clay accent by default and any text color when needed.
 */
export function LogoMark({ className, title = "Agentic RAG" }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-6 text-accent", className)}
         {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}>
      <g fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
        <path d="M16 16V6.5M16 16l8.23 4.75M16 16l-8.23 4.75" />
        <path d="M19.56 7.19A9.5 9.5 0 0 1 25.41 17.32M21.85 23.49A9.5 9.5 0 0 1 10.15 23.49M6.59 17.32A9.5 9.5 0 0 1 12.44 7.19" />
      </g>
      <g fill="currentColor">
        <circle cx="16" cy="16" r="3.6" />
        <circle cx="16" cy="6.5" r="2.7" />
        <circle cx="24.23" cy="20.75" r="2.7" />
        <circle cx="7.77" cy="20.75" r="2.7" />
      </g>
    </svg>
  );
}

/** Mark + wordmark, as used in the sidebar. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className="size-[22px]" />
      <span className="font-serif text-[19px] font-medium tracking-tight text-ink">Agentic RAG</span>
    </span>
  );
}
