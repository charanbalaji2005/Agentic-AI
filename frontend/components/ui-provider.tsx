"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type Tone = "ok" | "danger" | "info" | "warn";
type Toast = { id: number; title: string; description?: string; tone: Tone };
type ConfirmOpts = { title: string; description?: string; confirmLabel?: string; danger?: boolean };

const Ctx = React.createContext<{
  toast: (title: string, opts?: { description?: string; tone?: Tone }) => void;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
} | null>(null);

export function useUI() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useUI must be used inside <UIProvider>");
  return ctx;
}

const ICON = { ok: CheckCircle2, danger: XCircle, info: Info, warn: AlertTriangle };
const TONE_TEXT = { ok: "text-ok", danger: "text-danger", info: "text-accent", warn: "text-warn" };
let tid = 0;

export function UIProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const [pending, setPending] = React.useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);

  const dismiss = React.useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = React.useCallback((title: string, opts?: { description?: string; tone?: Tone }) => {
    const id = ++tid;
    setToasts((t) => [...t.slice(-3), { id, title, description: opts?.description, tone: opts?.tone ?? "ok" }]);
    setTimeout(() => dismiss(id), 4200);
  }, [dismiss]);

  const confirm = React.useCallback((opts: ConfirmOpts) => new Promise<boolean>((resolve) => setPending({ ...opts, resolve })), []);
  const settle = (v: boolean) => { pending?.resolve(v); setPending(null); };

  const value = React.useMemo(() => ({ toast, confirm }), [toast, confirm]);

  return (
    <Ctx.Provider value={value}>
      {children}

      {/* Toasts */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const Icon = ICON[t.tone];
            return (
              <motion.div
                key={t.id} layout
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="glass pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-xl border border-line p-3.5 shadow-float"
              >
                <Icon className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[t.tone])} />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium">{t.title}</p>
                  {t.description && <p className="mt-0.5 text-[12.5px] text-muted">{t.description}</p>}
                </div>
                <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="rounded p-0.5 text-muted hover:text-ink"><X className="size-3.5" /></button>
                <motion.span
                  className={cn("absolute bottom-0 left-0 h-0.5", t.tone === "danger" ? "bg-danger" : t.tone === "warn" ? "bg-warn" : "bg-brand")}
                  initial={{ width: "100%" }} animate={{ width: "0%" }} transition={{ duration: 4.2, ease: "linear" }}
                />
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Confirm */}
      <Dialog open={!!pending} onClose={() => settle(false)} className="max-w-md" label={pending?.title}>
        {pending && (
          <div className="p-6">
            <div className="flex items-start gap-4">
              <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl border",
                pending.danger ? "border-danger/30 bg-danger/10 text-danger" : "border-accent/30 bg-accent/10 text-accent")}>
                <AlertTriangle className="size-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold">{pending.title}</h2>
                {pending.description && <p className="mt-1 text-sm text-muted">{pending.description}</p>}
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => settle(false)}>Cancel</Button>
              <Button variant={pending.danger ? "danger" : "primary"} onClick={() => settle(true)} autoFocus>
                {pending.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Ctx.Provider>
  );
}
