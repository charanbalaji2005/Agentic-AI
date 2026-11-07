"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/* ───────── Tooltip ─────────
   A small black label box rendered in a portal (never clipped by overflow-hidden parents),
   placed on the requested side and flipped / clamped to stay inside the viewport. */
type Side = "top" | "bottom" | "left" | "right";
const SHOW_DELAY_MS = 250;
const GAP = 6;

function TipBox({ anchor, side, children }: { anchor: DOMRect; side: Side; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let s = side;
    if (s === "top" && anchor.top - h - GAP < 4) s = "bottom";
    else if (s === "bottom" && anchor.bottom + h + GAP > vh - 4) s = "top";
    else if (s === "right" && anchor.right + w + GAP > vw - 4) s = "left";
    else if (s === "left" && anchor.left - w - GAP < 4) s = "right";
    let x = s === "right" ? anchor.right + GAP : s === "left" ? anchor.left - w - GAP : anchor.left + anchor.width / 2 - w / 2;
    let y = s === "top" ? anchor.top - h - GAP : s === "bottom" ? anchor.bottom + GAP : anchor.top + anchor.height / 2 - h / 2;
    x = Math.max(4, Math.min(x, vw - w - 4));
    y = Math.max(4, Math.min(y, vh - h - 4));
    setPos({ x, y });
  }, [anchor, side, children]);

  return createPortal(
    <div ref={ref} role="tooltip" className="tip"
         style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, visibility: pos ? "visible" : "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}

function TipContent({ label, shortcut }: { label: React.ReactNode; shortcut?: string }) {
  return <>{label}{shortcut && <span className="tip-kbd">{shortcut}</span>}</>;
}

/** Shared show/hide timing for both the explicit Tooltip and AutoTooltips. */
function useTipState() {
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout>>();
  const show = React.useCallback((el: Element, immediate = false) => {
    clearTimeout(timer.current);
    const go = () => el.isConnected && setAnchor(el.getBoundingClientRect());
    if (immediate) go(); else timer.current = setTimeout(go, SHOW_DELAY_MS);
  }, []);
  const hide = React.useCallback(() => { clearTimeout(timer.current); setAnchor(null); }, []);
  React.useEffect(() => {
    if (!anchor) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => { window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide); };
  }, [anchor, hide]);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  return { anchor, show, hide };
}

const isKeyboardFocus = (el: EventTarget | null) => {
  try { return !!(el as HTMLElement)?.matches?.(":focus-visible"); } catch { return false; }
};

export function Tooltip({ label, side = "top", shortcut, children, className, disabled }: {
  label: React.ReactNode; side?: Side; shortcut?: string; children: React.ReactNode; className?: string; disabled?: boolean;
}) {
  const { anchor, show, hide } = useTipState();
  const host = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => { if (disabled) hide(); }, [disabled, hide]);
  return (
    <span ref={host} data-tooltip-host="" className={cn("relative inline-flex", className)}
          onMouseEnter={() => !disabled && host.current && show(host.current)} onMouseLeave={hide}
          onPointerDown={hide}
          onFocus={(e) => !disabled && host.current && isKeyboardFocus(e.target) && show(host.current, true)} onBlur={hide}>
      {children}
      {anchor && !disabled && label && <TipBox anchor={anchor} side={side}><TipContent label={label} shortcut={shortcut} /></TipBox>}
    </span>
  );
}

/**
 * Gives every icon-only button or link its name on hover, so no icon needs a manual <Tooltip>.
 * Picks up `aria-label` (only when the control has no visible text) or an explicit `data-tip`;
 * `data-tip-side` picks the side and `data-no-tip` opts out. Mount once near the app root.
 */
export function AutoTooltips() {
  const { anchor, show, hide } = useTipState();
  const [tip, setTip] = React.useState<{ label: string; side: Side }>({ label: "", side: "top" });
  const current = React.useRef<Element | null>(null);

  React.useEffect(() => {
    const target = (t: EventTarget | null): Element | null => {
      const el = (t as Element | null)?.closest?.("button, a, [role='button'], [data-tip]") ?? null;
      if (!el || el.closest("[data-tooltip-host], [data-no-tip]")) return null;
      const explicit = el.getAttribute("data-tip");
      if (explicit) return el;
      const label = el.getAttribute("aria-label");
      return label && !(el.textContent ?? "").trim() ? el : null;
    };
    const open = (el: Element, immediate: boolean) => {
      current.current = el;
      setTip({ label: el.getAttribute("data-tip") || el.getAttribute("aria-label") || "",
               side: (el.getAttribute("data-tip-side") as Side) || "top" });
      show(el, immediate);
    };
    const close = () => { current.current = null; hide(); };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = target(e.target);
      if (el === current.current) return;
      if (el) open(el, false); else close();
    };
    const onFocus = (e: FocusEvent) => { const el = target(e.target); if (el && isKeyboardFocus(e.target)) open(el, true); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onOut = (e: PointerEvent) => { if (!e.relatedTarget) close(); };  // left the window
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [show, hide]);

  return anchor && tip.label ? <TipBox anchor={anchor} side={tip.side}>{tip.label}</TipBox> : null;
}

/* ───────── Kbd ───────── */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line border-b-2 bg-sunken px-1 font-mono text-[10.5px] font-medium text-muted", className)}>
      {children}
    </kbd>
  );
}

/* ───────── Animated number ───────── */
export function AnimatedNumber({ value, format = (n) => Math.round(n).toLocaleString(), className }: {
  value: number; format?: (n: number) => string; className?: string;
}) {
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 80, damping: 20, mass: 0.8 });
  const text = useTransform(spring, (v) => format(v));
  React.useEffect(() => { mv.set(Number.isFinite(value) ? value : 0); }, [value, mv]);
  return <motion.span className={cn("tabular-nums", className)}>{text}</motion.span>;
}

/* ───────── Progress ring ───────── */
export function statusTone(ratio: number): "ok" | "warn" | "danger" {
  return ratio >= 0.8 ? "ok" : ratio >= 0.5 ? "warn" : "danger";
}

export function ProgressRing({ value, size = 56, stroke = 5, children, tone }: {
  value: number; size?: number; stroke?: number; children?: React.ReactNode; tone?: "ok" | "warn" | "danger" | "accent";
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value || 0));
  const t = tone ?? statusTone(v);
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-line" />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
          stroke={`rgb(var(--${t}))`} strokeDasharray={c}
          initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - v) }}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}

/* ───────── Skeleton ───────── */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-lg bg-ink/[0.06]", className)}>
      <div className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-ink/[0.06] to-transparent" />
    </div>
  );
}

/* ───────── Switch ───────── */
export function Switch({ checked, onChange, label, description }: {
  checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode; description?: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors",
          checked ? "border-accent bg-accent" : "border-line bg-sunken")}
      >
        <motion.span
          layout transition={{ type: "spring", stiffness: 600, damping: 32 }}
          className={cn("absolute top-0.5 size-3.5 rounded-full shadow", checked ? "right-0.5 bg-canvas" : "left-0.5 bg-muted")}
        />
      </button>
      {(label || description) && (
        <span className="text-sm">
          {label && <span className="block font-medium">{label}</span>}
          {description && <span className="block text-[12.5px] text-muted">{description}</span>}
        </span>
      )}
    </label>
  );
}

/* ───────── Tabs (animated indicator) ───────── */
export function Tabs<T extends string>({ value, onChange, items, id, className, variant = "underline" }: {
  value: T; onChange: (v: T) => void; items: { id: T; label: React.ReactNode; count?: number; icon?: React.ReactNode }[];
  id: string; className?: string; variant?: "underline" | "pill";
}) {
  return (
    <div role="tablist" className={cn("flex gap-1", variant === "pill" && "rounded-xl border border-line bg-sunken/70 p-1", className)}>
      {items.map((it) => {
        const on = it.id === value;
        return (
          <button
            key={it.id} role="tab" aria-selected={on} onClick={() => onChange(it.id)}
            className={cn("relative flex items-center gap-1.5 px-3 text-[13px] font-medium transition-colors [&_svg]:size-3.5",
              variant === "underline" ? "pb-2.5 pt-1" : "rounded-lg py-1.5",
              on ? "text-ink" : "text-muted hover:text-ink")}
          >
            {on && (
              <motion.span
                layoutId={`tab-${id}`}
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
                className={cn("absolute", variant === "underline"
                  ? "inset-x-1 -bottom-px h-0.5 rounded-full bg-brand"
                  : "inset-0 rounded-lg border border-line bg-surface shadow-soft")}
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              {it.icon}{it.label}
              {it.count != null && it.count > 0 && (
                <span className={cn("rounded-full px-1.5 text-[10.5px] tabular-nums", on ? "bg-accent/15 text-accent" : "bg-ink/[0.07]")}>{it.count}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ───────── Dialog ───────── */
export function Dialog({ open, onClose, children, className, label }: {
  open: boolean; onClose: () => void; children: React.ReactNode; className?: string; label?: string;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-canvas/70 backdrop-blur-md" onClick={onClose} aria-hidden />
          <motion.div
            role="dialog" aria-modal="true" aria-label={label}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            className={cn("relative w-full overflow-hidden rounded-2xl border border-line bg-elevated shadow-float", className)}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function DialogClose({ onClose }: { onClose: () => void }) {
  return (
    <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink">
      <X className="size-4" />
    </button>
  );
}

/* ───────── Stagger helpers ───────── */
export const stagger = {
  container: { hidden: {}, show: { transition: { staggerChildren: 0.05 } } },
  item: { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 400, damping: 34 } } },
} as const;
