"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, Check, ChevronDown, Database, Eye, FileText, Plus, Search, Square, X } from "lucide-react";
import { Tooltip } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { bytes, cn } from "@/lib/utils";
import type { DocAttachment, KnowledgeBase } from "@/types";

export type ModelOption = { id: string; label: string; owner?: string; note?: string | null; context?: number | null };
export type ModelOptions = { provider: string; default: string; switchable: boolean; items: ModelOption[] };

const MODEL_KEY = "chat-model";

/** Loads the model list and remembers the user's pick across sessions. */
export function useModelChoice() {
  const [options, setOptions] = useState<ModelOptions | null>(null);
  const [model, setModel] = useState<string | null>(null);

  useEffect(() => {
    api.get<ModelOptions>("/api/models/options").then((o) => {
      setOptions(o);
      let saved: string | null = null;
      try { saved = localStorage.getItem(MODEL_KEY); } catch {}
      setModel(saved && o.items.some((m) => m.id === saved) ? saved : o.default);
    }).catch(() => setOptions(null));
  }, []);

  const choose = (id: string) => {
    setModel(id);
    try { localStorage.setItem(MODEL_KEY, id); } catch {}
  };

  /** The value to send with a chat request (only when switching is supported). */
  const requestModel = options?.switchable ? model ?? undefined : undefined;
  return { options, model, choose, requestModel };
}

/** Closes a popover on outside click / Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, close]);
  return ref;
}

export function Popover({ open, children, align = "right", placement = "top", className }: {
  open: boolean; children: React.ReactNode; align?: "left" | "right"; placement?: "top" | "bottom"; className?: string;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: placement === "top" ? 6 : -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: placement === "top" ? 6 : -6, scale: 0.98 }}
          transition={{ duration: 0.14, ease: "easeOut" }}
          className={cn("absolute z-40 rounded-xl border border-line bg-elevated p-1.5 shadow-float",
            placement === "top" ? "bottom-full mb-2" : "top-full mt-2",
            align === "right" ? "right-0" : "left-0", className)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ctxLabel(n?: number | null) {
  if (!n) return null;
  return n >= 1000 ? `${Math.round(n / 1000)}k context` : `${n} context`;
}

export function ModelSelector({ options, model, onChange, placement }: {
  options: ModelOptions | null; model: string | null; onChange: (id: string) => void; placement?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useDismiss(open, () => setOpen(false));
  const current = options?.items.find((m) => m.id === model);
  const items = useMemo(
    () => (options?.items ?? []).filter((m) => !q || `${m.id} ${m.owner ?? ""}`.toLowerCase().includes(q.toLowerCase())),
    [options, q],
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button" onClick={() => setOpen((o) => !o)} disabled={!options}
        className={cn("flex h-8 max-w-[220px] items-center gap-1 rounded-lg px-2 text-[13px] text-ink/80 transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-50",
          open && "bg-ink/[0.06] text-ink")}
        aria-haspopup="listbox" aria-expanded={open} aria-label="Choose model"
      >
        <span className="truncate">{current?.label ?? (options ? "Model" : "Loading…")}</span>
        <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      <Popover open={open} placement={placement} className="w-[300px]">
        {options && options.items.length > 6 && (
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models"
                   className="h-8 w-full rounded-lg bg-sunken pl-8 pr-2 text-[13px] placeholder:text-muted focus:outline-none" />
          </div>
        )}
        <ul role="listbox" className="max-h-[300px] overflow-y-auto scroll-thin">
          {items.map((m) => {
            const on = m.id === model;
            const sub = [m.owner, m.note, ctxLabel(m.context)].filter(Boolean).join(" · ");
            return (
              <li key={m.id}>
                <button
                  type="button" role="option" aria-selected={on} disabled={!options?.switchable && !on}
                  onClick={() => { onChange(m.id); setOpen(false); setQ(""); }}
                  className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-ink/[0.05] disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{m.label}</span>
                    {sub && <span className="block truncate text-[12px] text-muted">{sub}</span>}
                  </span>
                  {on && <Check className="mt-0.5 size-4 shrink-0" />}
                </button>
              </li>
            );
          })}
          {items.length === 0 && <li className="px-2.5 py-3 text-center text-[13px] text-muted">No models match</li>}
        </ul>
        <p className="mt-1 border-t border-line px-2.5 pb-1 pt-2 text-[11.5px] leading-snug text-muted">
          {options?.switchable
            ? "Writes the answer. Planning and fact-checking keep their configured models."
            : <>Local models are switched on the <Link href="/models" className="underline">Models page</Link>.</>}
        </p>
      </Popover>
    </div>
  );
}

export function KbSelector({ kbs, kbIds, onChange, placement }: {
  kbs: KnowledgeBase[]; kbIds: string[]; onChange: (ids: string[]) => void; placement?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const n = kbIds.length;
  return (
    <div ref={ref} className="relative">
      <Tooltip label="Knowledge bases to search" disabled={open}>
        <button type="button" onClick={() => setOpen((o) => !o)}
                className={cn("flex h-8 items-center gap-1.5 rounded-lg border border-line px-2 text-[12.5px] text-ink/80 transition-colors hover:bg-ink/[0.05]",
                  open && "bg-ink/[0.05]")}>
          <Database className="size-3.5" />
          {n === 0 ? "No docs" : n === 1 ? kbs.find((k) => k.kb_id === kbIds[0])?.name ?? kbIds[0] : `${n} sources`}
        </button>
      </Tooltip>
      <Popover open={open} align="left" placement={placement} className="w-[240px]">
        <p className="px-2.5 pb-1 pt-1 text-[11.5px] font-medium text-muted">Search in</p>
        {kbs.length === 0 && <p className="px-2.5 py-2 text-[13px] text-muted">No knowledge bases</p>}
        {kbs.map((kb) => {
          const on = kbIds.includes(kb.kb_id);
          return (
            <button key={kb.kb_id} type="button"
                    onClick={() => onChange(on ? kbIds.filter((k) => k !== kb.kb_id) : [...kbIds, kb.kb_id])}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] hover:bg-ink/[0.05]">
              <span className={cn("grid size-4 shrink-0 place-items-center rounded border", on ? "border-ink bg-ink text-canvas" : "border-muted/60")}>
                {on && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1 truncate">{kb.name}</span>
              <span className="text-[12px] tabular-nums text-muted">{kb.documents}</span>
            </button>
          );
        })}
      </Popover>
    </div>
  );
}

export function AttachmentChip({ att, onRemove, onPreview }: { att: DocAttachment; onRemove?: () => void; onPreview?: () => void }) {
  return (
    <motion.div layout initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
                className={cn("group relative flex w-[200px] items-center gap-2.5 overflow-hidden rounded-xl border bg-surface p-2 text-left",
                  att.status === "error" ? "border-danger/40" : "border-line")}>
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-muted"><FileText className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{att.file_name}</span>
        <span className="block truncate text-[11px] text-muted">
          {att.status === "uploading" ? "Indexing…" : att.status === "error" ? <span className="text-danger">Failed</span> : `${att.chunks ?? 0} chunks · ${bytes(att.size)}`}
        </span>
      </span>
      {onPreview && att.doc_id && (
        <button type="button" onClick={onPreview} className="rounded-md p-1 text-muted hover:bg-ink/[0.06] hover:text-ink" aria-label="Preview"><Eye className="size-3.5" /></button>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label="Remove"
                className="absolute -right-1 -top-1 hidden size-5 place-items-center rounded-full border border-line bg-elevated text-muted shadow-soft hover:text-ink group-hover:grid">
          <X className="size-3" />
        </button>
      )}
      {att.status === "uploading" && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-ink/10">
          <span className="block h-full w-1/3 animate-shimmer bg-ink/60" />
        </span>
      )}
    </motion.div>
  );
}

export function Composer({
  value, onChange, onSubmit, onStop, busy, canSend, attachments, onRemoveAttachment, onPreviewAttachment,
  onPickFiles, kbs, kbIds, onKbChange, models, model, onModelChange, placeholder, popoverPlacement = "top", taRef,
}: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; onStop: () => void; busy: boolean; canSend: boolean;
  attachments: DocAttachment[]; onRemoveAttachment: (name: string) => void; onPreviewAttachment: (a: DocAttachment) => void;
  onPickFiles: () => void; kbs: KnowledgeBase[]; kbIds: string[]; onKbChange: (ids: string[]) => void;
  models: ModelOptions | null; model: string | null; onModelChange: (id: string) => void;
  placeholder: string; popoverPlacement?: "top" | "bottom"; taRef: React.RefObject<HTMLTextAreaElement>;
}) {
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [value, taRef]);

  return (
    <div className="rounded-[20px] border border-line bg-surface shadow-composer transition-colors focus-within:border-ink/20 dark:shadow-none">
      <AnimatePresence initial={false}>
        {attachments.length > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              <AnimatePresence>
                {attachments.map((att) => (
                  <AttachmentChip key={att.file_name} att={att} onRemove={() => onRemoveAttachment(att.file_name)} onPreview={() => onPreviewAttachment(att)} />
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <textarea
        ref={taRef} value={value} rows={1}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSubmit(); } }}
        placeholder={placeholder} aria-label="Message"
        className="block max-h-[240px] min-h-[60px] w-full resize-none bg-transparent px-4 pb-1 pt-4 text-[15.5px] leading-relaxed placeholder:text-muted/80 focus:outline-none"
      />
      <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
        <Tooltip label="Add files">
          <button type="button" onClick={onPickFiles} aria-label="Add files"
                  className="grid size-8 place-items-center rounded-lg border border-line text-ink/80 transition-colors hover:bg-ink/[0.05]">
            <Plus className="size-4" />
          </button>
        </Tooltip>
        <KbSelector kbs={kbs} kbIds={kbIds} onChange={onKbChange} placement={popoverPlacement} />
        <div className="ml-auto flex items-center gap-1">
          <ModelSelector options={models} model={model} onChange={onModelChange} placement={popoverPlacement} />
          <AnimatePresence mode="wait" initial={false}>
            {busy ? (
              <motion.button key="stop" type="button" onClick={onStop} aria-label="Stop"
                             initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }}
                             className="grid size-8 place-items-center rounded-lg bg-accent text-on-accent hover:bg-accent/90">
                <Square className="size-3 fill-current" />
              </motion.button>
            ) : (
              <motion.button key="send" type="button" onClick={onSubmit} disabled={!canSend} aria-label="Send message"
                             initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }}
                             className="grid size-8 place-items-center rounded-lg bg-accent text-on-accent transition-opacity hover:bg-accent/90 disabled:bg-accent/40 disabled:text-on-accent">
                <ArrowUp className="size-4" strokeWidth={2.5} />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
