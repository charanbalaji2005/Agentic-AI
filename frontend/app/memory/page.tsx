"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Brain, Check, Clock, Heart, Lightbulb, ListTodo, Pencil, Plus, Search, Sparkles, Trash2, X, FolderKanban } from "lucide-react";
import { PageFrame, Reveal } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Empty, ErrorNote } from "@/components/ui/empty";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Tabs, Tooltip } from "@/components/ui/primitives";
import { useUI } from "@/components/ui-provider";
import { api } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import type { MemoryItem } from "@/types";

const KIND: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  preference: { label: "Preference", icon: Heart },
  fact: { label: "Fact", icon: Lightbulb },
  project: { label: "Project context", icon: FolderKanban },
  task_summary: { label: "Task summary", icon: ListTodo },
};

export default function MemoryPage() {
  const { toast, confirm } = useUI();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [draft, setDraft] = useState({ content: "", kind: "preference", ttl_days: "" });
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => { api.get<MemoryItem[]>("/api/memory").then(setItems).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);
  const run = async (fn: () => Promise<unknown>, success?: string) => { setError(null); try { await fn(); load(); if (success) toast(success); } catch (e: any) { setError(e.message); } };

  const proposed = items.filter((m) => m.status === "proposed");
  const active = items.filter((m) => m.status === "active");
  const shown = active.filter((m) => (filter === "all" || m.kind === filter) && (!q || m.content.toLowerCase().includes(q.toLowerCase())));
  const kinds = Array.from(new Set(active.map((m) => m.kind)));

  return (
    <PageFrame
      eyebrow="Personalization" icon={<Brain />} title="Memory"
      description="Long-term memory holds only what you approve: preferences, project context and facts. Passwords, keys, emails and card numbers are refused."
      actions={active.length > 0 ? (
        <Button variant="danger" onClick={async () => { if (await confirm({ title: "Delete all memories?", description: `All ${active.length} saved memories will be removed. This can't be undone.`, confirmLabel: "Delete all", danger: true })) run(() => api.del("/api/memory"), "All memories deleted"); }}>
          <Trash2 /> Delete all
        </Button>
      ) : undefined}
    >
      <ErrorNote message={error} onDismiss={() => setError(null)} />

      <Reveal>
        <Card>
          <CardHeader icon={<Plus />} title="Add a memory" />
          <CardBody>
            <form className="grid gap-3 md:grid-cols-[1fr_180px_150px_auto] md:items-end" onSubmit={(e) => {
              e.preventDefault();
              run(async () => { await api.post("/api/memory", { content: draft.content, kind: draft.kind, ttl_days: draft.ttl_days ? Number(draft.ttl_days) : null }); setDraft({ ...draft, content: "" }); }, "Memory saved");
            }}>
              <label><Label>What should be remembered</Label><Input value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} placeholder="Prefer Terraform examples over CloudFormation" /></label>
              <label><Label>Type</Label>
                <Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                  {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </Select>
              </label>
              <label><Label hint="optional">Forget after (days)</Label><Input type="number" min={1} value={draft.ttl_days} onChange={(e) => setDraft({ ...draft, ttl_days: e.target.value })} /></label>
              <Button type="submit" variant="primary" disabled={!draft.content.trim()}><Check /> Save memory</Button>
            </form>
          </CardBody>
        </Card>
      </Reveal>

      <AnimatePresence>
        {proposed.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <Card spotlight={false} className="beam border-accent/30">
              <CardHeader icon={<Sparkles />} title="Suggested from your conversations" description="These were noticed when you said things like “remember that…”. Nothing is used until you save it." />
              <ul className="divide-y divide-line/60">
                <AnimatePresence initial={false}>
                  {proposed.map((m) => (
                    <motion.li key={m.id} layout exit={{ opacity: 0, x: 30, height: 0 }} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                      <span className="min-w-0 flex-1">{m.content}</span>
                      <Button size="sm" variant="primary" onClick={() => run(() => api.patch(`/api/memory/${m.id}`, { status: "active" }), "Memory saved")}><Check /> Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => run(() => api.del(`/api/memory/${m.id}`))}><X /> Discard</Button>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      <Reveal>
        <Card>
          <CardHeader icon={<Brain />} title="Saved memories" description="Relevant memories are added to the context of new questions as background, never as evidence."
                      action={<Badge tone="info">{active.length} saved</Badge>} />
          {active.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-b border-line/70 px-5 py-3">
              <Tabs id="mem-filter" variant="pill" value={filter} onChange={setFilter}
                    items={[{ id: "all", label: "All", count: active.length }, ...kinds.map((k) => ({ id: k, label: KIND[k]?.label ?? k, count: active.filter((m) => m.kind === k).length }))]} />
              <div className="ml-auto w-full sm:w-60"><Input icon={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memories" /></div>
            </div>
          )}
          {active.length === 0 ? <CardBody><Empty title="No saved memories" icon={<Brain />}>Add one above or save a suggestion from a conversation.</Empty></CardBody> : (
            <ul className="divide-y divide-line/60">
              <AnimatePresence initial={false}>
                {shown.map((m) => {
                  const K = KIND[m.kind] ?? { label: m.kind.replace("_", " "), icon: Brain };
                  return (
                    <motion.li key={m.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -30, height: 0 }}
                               className="group px-5 py-3.5 text-sm transition-colors hover:bg-accent/[0.03]">
                      {editing?.id === m.id ? (
                        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.patch(`/api/memory/${m.id}`, { content: editing.content }); setEditing(null); }, "Memory updated"); }}>
                          <Textarea value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} rows={2} autoFocus />
                          <div className="flex gap-2"><Button size="sm" type="submit" variant="primary">Save changes</Button><Button size="sm" variant="ghost" type="button" onClick={() => setEditing(null)}>Cancel</Button></div>
                        </form>
                      ) : (
                        <div className="flex items-start gap-3">
                          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-accent/25 bg-accent/10 text-accent"><K.icon className="size-4" /></span>
                          <div className="min-w-0 flex-1">
                            <p className="leading-relaxed">{m.content}</p>
                            <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                              <Badge>{K.label}</Badge>
                              <span>saved {timeAgo(m.created_at)}</span>
                              {m.expires_at && <span className={cn("flex items-center gap-1")}><Clock className="size-3" /> expires {new Date(m.expires_at).toLocaleDateString()}</span>}
                            </p>
                          </div>
                          <div className="flex gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                            <Tooltip label="Edit"><Button size="icon-sm" variant="ghost" aria-label="Edit memory" onClick={() => setEditing({ id: m.id, content: m.content })}><Pencil /></Button></Tooltip>
                            <Tooltip label="Delete"><Button size="icon-sm" variant="ghost" className="hover:text-danger" aria-label="Delete memory" onClick={() => run(() => api.del(`/api/memory/${m.id}`), "Memory deleted")}><Trash2 /></Button></Tooltip>
                          </div>
                        </div>
                      )}
                    </motion.li>
                  );
                })}
              </AnimatePresence>
              {shown.length === 0 && <li className="px-5 py-8 text-center text-sm text-muted">No memories match.</li>}
            </ul>
          )}
        </Card>
      </Reveal>
    </PageFrame>
  );
}
