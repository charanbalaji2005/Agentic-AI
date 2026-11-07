"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  BarChart3, Brain, Cpu, CornerDownLeft, History, Library, MessageSquarePlus, MessagesSquare,
  Moon, PanelRight, PlugZap, Search, Sparkles,
} from "lucide-react";
import { Kbd } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { emit } from "@/lib/bus";
import { cn, timeAgo } from "@/lib/utils";

type Item = { id: string; group: string; label: string; hint?: string; icon: React.ComponentType<{ className?: string }>; run: () => void };

export const STARTERS = [
  "Summarize the key decisions in my uploaded documents",
  "Compare what my docs say about deployment with current AWS guidance",
  "Which Azure resources are in my subscription, and are any stopped?",
  "What changed in the latest release notes, and what should I watch out for?",
];

function score(q: string, text: string) {
  if (!q) return 1;
  const t = text.toLowerCase();
  const s = q.toLowerCase();
  if (t.includes(s)) return 2 + (t.startsWith(s) ? 1 : 0);
  // subsequence match
  let i = 0;
  for (const ch of t) if (ch === s[i]) i++;
  return i === s.length ? 1 : 0;
}

export function CommandPalette({ open, onOpenChange, onToggleTheme }: {
  open: boolean; onOpenChange: (v: boolean) => void; onToggleTheme: () => void;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [convos, setConvos] = React.useState<{ id: string; title: string; updated_at: string }[]>([]);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    setQ(""); setActive(0);
    api.get<typeof convos>("/api/conversations").then((c) => setConvos(c.slice(0, 8))).catch(() => setConvos([]));
  }, [open]);

  const close = () => onOpenChange(false);
  const go = (href: string) => () => { router.push(href); close(); };
  const toAsk = (fn: () => void) => () => { router.push("/"); fn(); close(); };

  const items: Item[] = React.useMemo(() => [
    { id: "new", group: "Actions", label: "New conversation", icon: MessageSquarePlus, hint: "N", run: toAsk(() => emit({ type: "new-chat" })) },
    { id: "theme", group: "Actions", label: "Toggle light / dark theme", icon: Moon, run: () => { onToggleTheme(); close(); } },
    { id: "trace", group: "Actions", label: "Show / hide the trace panel", icon: PanelRight, run: toAsk(() => emit({ type: "toggle-trace" })) },
    { id: "nav-ask", group: "Go to", label: "Ask", icon: MessagesSquare, run: go("/") },
    { id: "nav-kb", group: "Go to", label: "Documents", hint: "Knowledge bases & retrieval", icon: Library, run: go("/knowledge") },
    { id: "nav-mcp", group: "Go to", label: "Tools", hint: "MCP servers & approvals", icon: PlugZap, run: go("/mcp") },
    { id: "nav-models", group: "Go to", label: "Models", hint: "LLM, embedder, reranker", icon: Cpu, run: go("/models") },
    { id: "nav-mem", group: "Go to", label: "Memory", icon: Brain, run: go("/memory") },
    { id: "nav-quality", group: "Go to", label: "Quality", hint: "Analytics & benchmarks", icon: BarChart3, run: go("/analytics") },
    ...STARTERS.map((s, i) => ({ id: `ask-${i}`, group: "Ask", label: s, icon: Sparkles, run: toAsk(() => emit({ type: "prefill", text: s })) })),
    ...convos.map((c) => ({ id: `c-${c.id}`, group: "Recent conversations", label: c.title, hint: timeAgo(c.updated_at), icon: History, run: toAsk(() => emit({ type: "open-conversation", id: c.id })) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [convos]);

  const filtered = React.useMemo(() => {
    const hits = items.map((it) => ({ it, s: Math.max(score(q, it.label), score(q, it.hint ?? "") * 0.5) })).filter((x) => x.s > 0);
    if (q) hits.sort((a, b) => b.s - a.s);
    return hits.map((x) => x.it);
  }, [items, q]);

  React.useEffect(() => { setActive(0); }, [q]);
  React.useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); filtered[active]?.run(); }
    else if (e.key === "Escape") close();
  };

  let idx = -1;
  const groups = Array.from(new Set(filtered.map((f) => f.group)));

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[80] flex items-start justify-center p-4 pt-[12vh]"
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-canvas/60 backdrop-blur-md" onClick={close} aria-hidden />
          <motion.div
            role="dialog" aria-label="Command palette"
            initial={{ opacity: 0, scale: 0.96, y: -12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: -8 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-elevated/95 shadow-float backdrop-blur-xl"
          >
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search className="size-4 text-muted" />
              <input
                autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
                placeholder="Search pages, actions, conversations…"
                className="h-14 flex-1 bg-transparent text-[15px] placeholder:text-muted/70 focus:outline-none"
                aria-label="Search commands"
              />
              <Kbd>Esc</Kbd>
            </div>
            <div ref={listRef} className="max-h-[52vh] overflow-y-auto scroll-thin p-2">
              {filtered.length === 0 && <p className="px-3 py-10 text-center text-sm text-muted">No results for “{q}”</p>}
              {groups.map((g) => (
                <div key={g} className="mb-1">
                  <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted/80">{g}</p>
                  {filtered.filter((f) => f.group === g).map((it) => {
                    idx++;
                    const i = idx;
                    const on = i === active;
                    const Icon = it.icon;
                    return (
                      <button
                        key={it.id} data-idx={i} onMouseMove={() => setActive(i)} onClick={it.run}
                        className={cn("relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm", on ? "text-ink" : "text-ink/85")}
                      >
                        {on && <motion.span layoutId="cmd-active" transition={{ type: "spring", stiffness: 600, damping: 40 }} className="absolute inset-0 rounded-xl border border-accent/25 bg-accent/10" />}
                        <span className={cn("relative grid size-7 shrink-0 place-items-center rounded-lg border", on ? "border-accent/40 bg-accent/15 text-accent" : "border-line bg-sunken text-muted")}>
                          <Icon className="size-3.5" />
                        </span>
                        <span className="relative min-w-0 flex-1 truncate">{it.label}</span>
                        {it.hint && <span className="relative shrink-0 text-[12px] text-muted">{it.hint}</span>}
                        {on && <CornerDownLeft className="relative size-3.5 shrink-0 text-accent" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-4 border-t border-line px-4 py-2.5 text-[11.5px] text-muted">
              <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
              <span className="flex items-center gap-1"><Kbd>↵</Kbd> select</span>
              <span className="ml-auto flex items-center gap-1"><Kbd>Ctrl</Kbd><Kbd>K</Kbd> toggle</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
