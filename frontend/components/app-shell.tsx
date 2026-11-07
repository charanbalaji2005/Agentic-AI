"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import {
  BarChart3, Brain, Cpu, Library, Menu, MessageSquare, Moon, MoreHorizontal, PanelLeft, Plus, PlugZap, Search, Sun, Trash2,
} from "lucide-react";
import { CommandPalette } from "@/components/command-palette";
import { LogoMark } from "@/components/logo";
import { UIProvider, useUI } from "@/components/ui-provider";
import { AutoTooltips, Kbd, Tooltip } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { chatStore, emit, useChatStore } from "@/lib/bus";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Chats", icon: MessageSquare },
  { href: "/knowledge", label: "Documents", icon: Library },
  { href: "/mcp", label: "Tools", icon: PlugZap },
  { href: "/models", label: "Models", icon: Cpu },
  { href: "/memory", label: "Memory", icon: Brain },
  { href: "/analytics", label: "Quality", icon: BarChart3 },
];

type Convo = { id: string; title: string; updated_at: string };
type Health = "online" | "loading" | "offline";

/** The app's mark in the clay accent (see components/logo.tsx). */
export function Mark({ className }: { className?: string }) {
  return <LogoMark className={className} />;
}

function Sidebar({ expanded, onToggle, onOpenPalette, dark, onToggleTheme, health, mobile, onNavigate }: {
  expanded: boolean; onToggle: () => void; onOpenPalette: () => void; dark: boolean; onToggleTheme: () => void;
  health: { state: Health; detail: string }; mobile?: boolean; onNavigate?: () => void;
}) {
  const path = usePathname();
  const router = useRouter();
  const { confirm, toast } = useUI();
  const { activeId, historyVersion } = useChatStore();
  const [convos, setConvos] = useState<Convo[]>([]);
  const [menu, setMenu] = useState<string | null>(null);

  const loadConvos = useCallback(() => {
    api.get<Convo[]>("/api/conversations").then(setConvos).catch(() => setConvos([]));
  }, []);
  useEffect(loadConvos, [loadConvos, historyVersion]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const open = (cmd: Parameters<typeof emit>[0]) => {
    if (path !== "/") router.push("/");
    emit(cmd);
    onNavigate?.();
  };

  const remove = async (c: Convo) => {
    setMenu(null);
    if (!(await confirm({ title: "Delete chat?", description: `“${c.title}” will be permanently deleted.`, confirmLabel: "Delete", danger: true }))) return;
    await api.del(`/api/conversations/${c.id}`);
    if (activeId === c.id) emit({ type: "new-chat" });
    toast("Chat deleted");
    loadConvos();
  };

  const dot = health.state === "online" ? "bg-ok" : health.state === "loading" ? "bg-warn" : "bg-danger";
  const wide = expanded || mobile;

  const row = "flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-[14px] transition-colors";

  return (
    <div className="flex h-full flex-col">
      {/* Top: toggle + wordmark */}
      <div className="flex h-12 items-center gap-1 px-2">
        <Tooltip label={wide ? "Close sidebar" : "Open sidebar"} shortcut="Ctrl \" side="right" disabled={mobile}>
          <button onClick={onToggle} className="grid size-9 place-items-center rounded-lg text-muted hover:bg-ink/[0.06] hover:text-ink" aria-label="Toggle sidebar">
            <PanelLeft className="size-[18px]" />
          </button>
        </Tooltip>
        {wide && (
          <Link href="/" onClick={onNavigate} className="ml-1 flex min-w-0 items-center gap-2" aria-label="Agentic RAG home">
            <LogoMark className="size-[22px] shrink-0" title="" />
            <span className="truncate font-serif text-[19px] font-medium tracking-tight">Agentic RAG</span>
          </Link>
        )}
      </div>

      {/* New chat + search */}
      <div className="space-y-0.5 px-2 pt-1">
        <Tooltip label="New chat" shortcut="Ctrl Shift O" side="right" disabled={wide} className="w-full">
          <button onClick={() => open({ type: "new-chat" })} className={cn(row, "group text-ink hover:bg-ink/[0.06]")} aria-label="New chat">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-on-accent transition-transform group-hover:scale-105">
              <Plus className="size-3.5" strokeWidth={2.5} />
            </span>
            {wide && <span className="font-medium">New chat</span>}
          </button>
        </Tooltip>
        <Tooltip label="Search" shortcut="Ctrl K" side="right" disabled={wide} className="w-full">
          <button onClick={onOpenPalette} className={cn(row, "text-ink/85 hover:bg-ink/[0.06]")} aria-label="Search">
            <Search className="ml-[3px] size-[17px] shrink-0 text-muted" />
            {wide && <span className="flex flex-1 items-center justify-between">Search <Kbd>Ctrl K</Kbd></span>}
          </button>
        </Tooltip>
      </div>

      {/* Pages */}
      <nav aria-label="Main" className="mt-2 space-y-0.5 px-2">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Tooltip key={href} label={label} side="right" disabled={wide} className="w-full">
              <Link href={href} onClick={onNavigate} aria-current={active ? "page" : undefined} aria-label={label}
                    className={cn(row, active ? "bg-ink/[0.07] font-medium text-ink" : "text-ink/80 hover:bg-ink/[0.05]")}>
                <Icon className={cn("ml-[3px] size-[17px] shrink-0", active ? "text-ink" : "text-muted")} />
                {wide && <span className="truncate">{label}</span>}
              </Link>
            </Tooltip>
          );
        })}
      </nav>

      {/* Recents */}
      <div className="mt-5 min-h-0 flex-1 overflow-y-auto scroll-thin px-2">
        {wide && (
          <>
            <p className="px-2.5 pb-1.5 text-[12px] font-medium text-muted">Recents</p>
            {convos.length === 0 && <p className="px-2.5 text-[13px] text-muted/80">No chats yet</p>}
            <ul className="space-y-px pb-3">
              {convos.map((c) => {
                const on = activeId === c.id && path === "/";
                return (
                  <li key={c.id} className="group relative">
                    <button onClick={() => open({ type: "open-conversation", id: c.id })}
                            className={cn("block w-full truncate rounded-lg py-1.5 pl-2.5 pr-8 text-left text-[13.5px] transition-colors",
                              on ? "bg-ink/[0.07] text-ink" : "text-ink/80 hover:bg-ink/[0.05]")}>
                      {c.title}
                    </button>
                    <button aria-label="Chat options" onClick={(e) => { e.stopPropagation(); setMenu(menu === c.id ? null : c.id); }}
                            className={cn("absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted hover:bg-ink/[0.08] hover:text-ink",
                              menu === c.id ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100")}>
                      <MoreHorizontal className="size-4" />
                    </button>
                    <AnimatePresence>
                      {menu === c.id && (
                        <motion.div initial={{ opacity: 0, scale: 0.95, y: -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}
                                    transition={{ duration: 0.12 }} onClick={(e) => e.stopPropagation()}
                                    className="absolute right-1 top-8 z-30 w-40 rounded-xl border border-line bg-elevated p-1 shadow-float">
                          <button onClick={() => remove(c)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-danger hover:bg-danger/10">
                            <Trash2 className="size-3.5" /> Delete
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* Profile row */}
      <div className="border-t border-line p-2">
        <div className={cn("flex items-center gap-2 rounded-lg p-1.5", wide && "hover:bg-ink/[0.04]")}>
          <Tooltip label={health.detail} side="right" disabled={wide}>
            <span className="relative grid size-8 shrink-0 place-items-center rounded-full bg-ink text-[13px] font-semibold text-canvas">
              U
              <span className={cn("absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-sidebar", dot)} />
            </span>
          </Tooltip>
          {wide && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-medium">Local user</p>
              <p className="truncate text-[11.5px] text-muted">{health.detail}</p>
            </div>
          )}
          {wide && (
            <Tooltip label={dark ? "Light mode" : "Dark mode"}>
              <button onClick={onToggleTheme} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-ink/[0.06] hover:text-ink" aria-label="Toggle theme">
                {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </button>
            </Tooltip>
          )}
        </div>
        {!wide && (
          <Tooltip label={dark ? "Light mode" : "Dark mode"} side="right">
            <button onClick={onToggleTheme} className="mt-1 grid size-9 w-full place-items-center rounded-lg text-muted hover:bg-ink/[0.06] hover:text-ink" aria-label="Toggle theme">
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [dark, setDark] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [health, setHealth] = useState<{ state: Health; detail: string }>({ state: "loading", detail: "Connecting…" });

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    try { const v = localStorage.getItem("nav-expanded"); if (v) setExpanded(v === "1"); } catch {}
  }, []);

  useEffect(() => {
    let alive = true;
    const check = () => api.get<any>("/api/models")
      .then((m) => {
        if (!alive) return;
        const st = m?.generator?.state;
        setHealth(st === "ready" ? { state: "online", detail: "Online" } : { state: "loading", detail: `Model ${st ?? "unknown"}` });
      })
      .catch(() => alive && setHealth({ state: "offline", detail: "Backend offline" }));
    check();
    const t = setInterval(check, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const toggleNav = useCallback(() => setExpanded((x) => {
    try { localStorage.setItem("nav-expanded", x ? "0" : "1"); } catch {}
    return !x;
  }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); }
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") { e.preventDefault(); toggleNav(); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); emit({ type: "new-chat" }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleNav]);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch {}
  };

  const common = { onOpenPalette: () => setPalette(true), dark, onToggleTheme: toggleTheme, health };

  return (
    <MotionConfig reducedMotion="user">
      <UIProvider>
        <div className="flex h-dvh overflow-hidden">
          {/* Desktop sidebar */}
          <motion.aside
            animate={{ width: expanded ? 268 : 56 }}
            transition={{ type: "spring", stiffness: 420, damping: 40 }}
            className="hidden shrink-0 overflow-hidden border-r border-line bg-sidebar md:block"
          >
            <div className={cn("h-full", expanded ? "w-[268px]" : "w-14")}>
              <Sidebar expanded={expanded} onToggle={toggleNav} {...common} />
            </div>
          </motion.aside>

          {/* Mobile sidebar */}
          <button onClick={() => setMobileOpen(true)} aria-label="Open menu"
                  className="fixed left-2 top-2 z-30 grid size-9 place-items-center rounded-lg text-muted hover:bg-ink/[0.06] md:hidden">
            <Menu className="size-5" />
          </button>
          <AnimatePresence>
            {mobileOpen && (
              <motion.div className="fixed inset-0 z-50 md:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} aria-hidden />
                <motion.aside initial={{ x: -290 }} animate={{ x: 0 }} exit={{ x: -290 }} transition={{ type: "spring", stiffness: 420, damping: 40 }}
                              className="absolute inset-y-0 left-0 w-[280px] border-r border-line bg-sidebar">
                  <Sidebar expanded mobile onToggle={() => setMobileOpen(false)} onNavigate={() => setMobileOpen(false)} {...common} />
                </motion.aside>
              </motion.div>
            )}
          </AnimatePresence>

          <main className="relative min-w-0 flex-1 overflow-hidden bg-canvas">{children}</main>
        </div>
        <CommandPalette open={palette} onOpenChange={setPalette} onToggleTheme={toggleTheme} />
        <AutoTooltips />
      </UIProvider>
    </MotionConfig>
  );
}

export function PageFrame({ title, description, actions, children }: {
  title: string; description?: string; actions?: React.ReactNode; eyebrow?: string; icon?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="mx-auto max-w-5xl px-5 pb-12 pt-14 md:px-10 md:pt-12">
        <motion.header
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: "easeOut" }}
          className="mb-8 flex flex-wrap items-end justify-between gap-4"
        >
          <div>
            <h1 className="font-serif text-[32px] font-medium leading-tight">{title}</h1>
            {description && <p className="mt-1.5 max-w-2xl text-[14.5px] leading-relaxed text-muted">{description}</p>}
          </div>
          {actions}
        </motion.header>
        <motion.div className="space-y-6" initial="hidden" animate="show"
                    variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04, delayChildren: 0.05 } } }}>
          {children}
        </motion.div>
      </div>
    </div>
  );
}

/** Wrap a page section to fade in as part of PageFrame's stagger. */
export function Reveal({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div className={className}
                variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } } }}>
      {children}
    </motion.div>
  );
}

export { chatStore };
