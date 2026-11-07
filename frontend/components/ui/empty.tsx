"use client";

import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Inbox, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function Empty({ title, children, icon, className }: { title: string; children?: React.ReactNode; icon?: React.ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("relative overflow-hidden rounded-2xl border border-dashed border-line px-6 py-10 text-center", className)}
    >
      <div className="mx-auto mb-3 grid size-11 animate-float place-items-center rounded-2xl border border-line bg-sunken text-muted [&_svg]:size-5">
        {icon ?? <Inbox />}
      </div>
      <p className="font-display text-[15px] font-semibold">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
    </motion.div>
  );
}

export function ErrorNote({ message, onDismiss }: { message?: string | null; onDismiss?: () => void }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="overflow-hidden"
          role="alert"
        >
          <div className="flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1">{message}</span>
            {onDismiss && <button onClick={onDismiss} aria-label="Dismiss" className="rounded p-0.5 hover:bg-danger/15"><X className="size-3.5" /></button>}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
