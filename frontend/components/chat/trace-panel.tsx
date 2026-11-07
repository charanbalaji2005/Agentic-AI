"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity, CheckCircle2, ChevronDown, CircleDashed, ExternalLink, FileText, Globe, Hourglass, Layers, ListChecks,
  Loader2, RefreshCw, ShieldAlert, Wrench, X, XCircle,
} from "lucide-react";
import { RouteMap } from "./route-map";
import { Badge } from "@/components/ui/badge";
import { AnimatedNumber, ProgressRing, Tabs, stagger } from "@/components/ui/primitives";
import { agentColor, cn, pct } from "@/lib/utils";
import type { AgentInfo, PlanStep, RunState } from "@/types";

const STEP_ICON = {
  pending: CircleDashed, running: Loader2, awaiting_approval: Hourglass, completed: CheckCircle2, failed: XCircle, skipped: CircleDashed,
};
const STEP_TONE = {
  pending: "text-muted border-line", running: "text-accent border-accent/50", awaiting_approval: "text-warn border-warn/50",
  completed: "text-ok border-ok/40", failed: "text-danger border-danger/40", skipped: "text-muted border-line",
};

type Tab = "route" | "sources" | "checks";

export function TracePanel({ run, agents, focusCite, onClose }: { run?: RunState; agents: AgentInfo[]; focusCite: number | null; onClose?: () => void }) {
  const [tab, setTab] = useState<Tab>("route");
  const [showAll, setShowAll] = useState(false);
  const citeRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focusCite != null) {
      setTab("sources");
      setTimeout(() => citeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
    }
  }, [focusCite]);

  const steps = Object.values(run?.steps ?? {});
  const doneSteps = steps.filter((s) => s.status === "completed").length;
  const live = !!run && !run.done;

  return (
    <aside className="flex h-full flex-col border-l border-line bg-canvas">
      <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
        <div className="flex items-center gap-2">
          <h2 className="font-sans text-[15px] font-semibold">Run trace</h2>
          {live && <Badge tone="info" dot pulse>live</Badge>}
          {run?.done && !run.error && <Badge tone="ok" dot>complete</Badge>}
          {run?.error && <Badge tone="danger" dot>failed</Badge>}
        </div>
        {onClose && (
          <button onClick={onClose} aria-label="Hide trace panel" className="rounded-lg p-1.5 text-muted hover:bg-ink/[0.06] hover:text-ink">
            <X className="size-4" />
          </button>
        )}
      </div>
      <Tabs
        id="trace" value={tab} onChange={setTab} className="border-b border-line/70 px-3 pt-2"
        items={[
          { id: "route", label: "Route", icon: <Activity /> },
          { id: "sources", label: "Sources", icon: <Layers />, count: run?.citations.length },
          { id: "checks", label: "Checks", icon: <ListChecks />, count: run?.claims.length },
        ]}
      />
      <div className="flex-1 overflow-y-auto scroll-thin p-4">
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
            {tab === "route" && (
              <div className="space-y-6">
                <div className="relative overflow-hidden rounded-2xl border border-line/70 bg-sunken/50 px-3 py-6">
                  <div className="backdrop-grid opacity-60" aria-hidden />
                  <div className="relative"><RouteMap run={run} agents={agents} /></div>
                </div>
                {!run && <p className="text-sm text-muted">Ask a question to watch the aggregator plan the work and route it to agents in real time.</p>}

                {steps.length > 0 && (
                  <section>
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-sm font-semibold">Plan</h3>
                      <span className="text-[12px] tabular-nums text-muted">{doneSteps}/{steps.length} steps</span>
                    </div>
                    <div className="mb-4 h-1 overflow-hidden rounded-full bg-line/60">
                      <motion.div className="h-full rounded-full bg-brand" initial={{ width: 0 }} animate={{ width: `${(doneSteps / steps.length) * 100}%` }} transition={{ type: "spring", stiffness: 120, damping: 22 }} />
                    </div>
                    <motion.ol className="relative space-y-3" variants={stagger.container} initial="hidden" animate="show">
                      <span className="absolute bottom-3 left-[13px] top-3 w-px bg-line" aria-hidden />
                      {steps.map((s: PlanStep) => {
                        const Icon = STEP_ICON[s.status];
                        return (
                          <motion.li key={s.task_id} variants={stagger.item} className="relative flex gap-3 text-[13px]">
                            <span className={cn("relative z-10 mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border bg-surface", STEP_TONE[s.status])}>
                              <Icon className={cn("size-3.5", s.status === "running" && "animate-spin")} />
                            </span>
                            <div className="min-w-0 flex-1 rounded-xl border border-line/70 bg-surface/50 p-3">
                              <div className="flex items-start justify-between gap-2">
                                <p className="font-medium leading-snug">{s.description}</p>
                                <span className="shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-medium"
                                      style={{ color: agentColor(s.agent), background: agentColor(s.agent, 0.12) }}>
                                  {s.agent.replace("_", " ")}
                                </span>
                              </div>
                              <p className="mt-1 font-mono text-[11.5px] text-muted">“{s.query}”</p>
                              {(s.result_summary || s.error) && <p className={cn("mt-1.5", s.error ? "text-danger" : "text-muted")}>{s.error ?? s.result_summary}</p>}
                              {s.depends_on.length > 0 && <p className="mt-1 text-[11.5px] text-muted">after {s.depends_on.join(", ")}</p>}
                            </div>
                          </motion.li>
                        );
                      })}
                    </motion.ol>
                  </section>
                )}

                {run?.iterations.map((it) => (
                  <motion.p key={it.iteration} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                            className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/[0.07] px-3 py-2.5 text-[13px]">
                    <RefreshCw className="mt-0.5 size-3.5 shrink-0 text-warn" />
                    <span>Evidence was weak, so round {it.iteration + 1} searched again for “{it.query}”.</span>
                  </motion.p>
                ))}

                {!!run?.tools.length && (
                  <section>
                    <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Wrench className="size-3.5" /> Tool calls</h3>
                    <ul className="space-y-1.5">
                      {run.tools.filter((t) => t.event === "tool_result" || t.approval_id).map((t, i) => (
                        <motion.li key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                                   className="rounded-xl border border-line/70 bg-surface/50 px-3 py-2 text-[12.5px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-mono">{t.tool}</span>
                            <Badge tone={t.approval_id ? "warn" : t.ok ? "ok" : "danger"} dot>{t.approval_id ? "needs approval" : t.ok ? "ok" : "failed"}</Badge>
                          </div>
                          {(t.error || t.preview) && <p className="mt-1 line-clamp-2 text-muted">{t.error ?? t.preview}</p>}
                        </motion.li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}

            {tab === "sources" && (
              <div className="space-y-5">
                {!run?.citations.length && (
                  <div className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
                    <Layers className="mx-auto mb-2 size-5" />
                    Cited sources appear here once the answer is checked.
                  </div>
                )}
                <motion.ol className="space-y-2.5" variants={stagger.container} initial="hidden" animate="show">
                  {run?.citations.map((c) => {
                    const isUrl = c.source.startsWith("http");
                    const focused = focusCite === c.index;
                    let host = "";
                    try { host = isUrl ? new URL(c.source).hostname.replace(/^www\./, "") : ""; } catch {}
                    return (
                      <motion.li key={c.index} variants={stagger.item} ref={focused ? citeRef : undefined}
                                 className={cn("rounded-2xl border p-3.5 text-[13px] transition-colors",
                                   focused ? "border-accent/50 bg-accent/[0.08] shadow-glow-sm" : "border-line/70 bg-surface/50 hover:border-line")}>
                        <div className="flex items-start gap-3">
                          <span className={cn("grid size-6 shrink-0 place-items-center rounded-lg text-[11px] font-bold",
                            focused ? "bg-ink text-canvas" : "bg-ink/[0.08] text-ink")}>{c.index}</span>
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold leading-snug">{c.title}</p>
                            <p className="mt-1 flex items-center gap-1.5 truncate text-[12px] text-muted">
                              {isUrl ? <Globe className="size-3.5 shrink-0 text-web" /> : <FileText className="size-3.5 shrink-0 text-local" />}
                              {isUrl
                                ? <a href={c.source} target="_blank" rel="noreferrer" className="truncate hover:text-ink hover:underline">{host || c.source}</a>
                                : <span className="truncate">{c.source}</span>}
                              {isUrl && <ExternalLink className="size-3 shrink-0" />}
                              {c.locator && <span className="shrink-0">· {c.locator}</span>}
                            </p>
                            <p className="mt-2 line-clamp-6 whitespace-pre-wrap border-l-2 border-line pl-2.5 leading-relaxed text-ink/85">{c.snippet}</p>
                          </div>
                        </div>
                      </motion.li>
                    );
                  })}
                </motion.ol>
                {!!run?.evidence.length && (
                  <div className="text-[13px]">
                    <button onClick={() => setShowAll((x) => !x)} className="flex w-full items-center gap-2 rounded-xl px-1 py-1.5 font-medium hover:text-accent">
                      <ChevronDown className={cn("size-4 transition-transform", showAll && "rotate-180")} />
                      All retrieved evidence ({run.evidence.length})
                    </button>
                    <AnimatePresence initial={false}>
                      {showAll && (
                        <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                                   className="mt-1 space-y-1.5 overflow-hidden">
                          {run.evidence.map((e) => {
                            const used = run.selected.includes(e.evidence_id);
                            const score = Math.max(0, Math.min(1, e.rerank_score ?? e.score ?? 0));
                            return (
                              <li key={e.evidence_id} className={cn("rounded-xl border px-3 py-2", used ? "border-line bg-surface/50" : "border-dashed border-line opacity-70")}>
                                <div className="flex justify-between gap-2">
                                  <span className="truncate font-medium">{e.title}</span>
                                  <span className="shrink-0 tabular-nums text-muted">{e.rerank_score != null ? e.rerank_score.toFixed(2) : "–"}</span>
                                </div>
                                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line/60">
                                  <motion.div className="h-full rounded-full" style={{ background: agentColor(e.agent) }}
                                              initial={{ width: 0 }} animate={{ width: `${score * 100}%` }} transition={{ duration: 0.6 }} />
                                </div>
                                <p className="mt-1 truncate text-[12px] text-muted">{e.locator ?? e.source}</p>
                                {e.metadata?.injection_flag && <Badge tone="danger" className="mt-1"><ShieldAlert className="size-3" /> Contains instruction-like text</Badge>}
                              </li>
                            );
                          })}
                        </motion.ul>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            )}

            {tab === "checks" && (
              <div className="space-y-4 text-[13px]">
                {!run?.stats && (
                  <div className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
                    <ListChecks className="mx-auto mb-2 size-5" />
                    After the answer is written, each sentence is checked against the source it cites.
                  </div>
                )}
                {run?.stats && (
                  <div className="flex items-center gap-4 rounded-2xl border border-line/70 bg-surface/50 p-4">
                    <ProgressRing value={run.stats.supported_ratio} size={76} stroke={7}>
                      <span className="font-display text-lg font-bold">
                        <AnimatedNumber value={run.stats.supported_ratio * 100} format={(n) => `${Math.round(n)}%`} />
                      </span>
                    </ProgressRing>
                    <div>
                      <p className="font-display text-base font-semibold">Grounding score</p>
                      <p className="text-muted">
                        {run.stats.supported} of {run.stats.claims} claims supported
                        {run.stats.uncited > 0 && `, ${run.stats.uncited} without a citation`}.
                      </p>
                      <p className="mt-1 text-[12px] text-muted">
                        {run.stats.supported_ratio >= 0.8 ? "✓ Well grounded" : run.stats.supported_ratio >= 0.5 ? "⚠ Partially grounded" : "✕ Weakly grounded"} · {pct(run.stats.supported_ratio)}
                      </p>
                    </div>
                  </div>
                )}
                {!!run?.conflicts.length && (
                  <div className="rounded-xl border border-warn/40 bg-warn/[0.07] p-3">
                    <p className="flex items-center gap-2 font-medium"><ShieldAlert className="size-4 text-warn" /> Sources disagree</p>
                    <ul className="mt-1 list-disc pl-6 text-muted">{run.conflicts.map((c, i) => <li key={i}>{c.issue}</li>)}</ul>
                  </div>
                )}
                <motion.ul className="space-y-1.5" variants={stagger.container} initial="hidden" animate="show">
                  {run?.claims.map((c, i) => (
                    <motion.li key={i} variants={stagger.item}
                               className={cn("flex gap-2.5 rounded-xl border p-3", c.supported ? "border-line/70 bg-surface/50" : "border-danger/25 bg-danger/[0.04]")}>
                      {c.supported ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />}
                      <div className="min-w-0 flex-1">
                        <p className="leading-relaxed">{c.sentence}</p>
                        <div className="mt-1.5 flex items-center gap-2 text-[11.5px] text-muted">
                          <span>{c.matched ? `Uncited · matches [${c.cited.join("], [")}]`
                            : c.cited.length ? `Cites ${c.cited.map((n) => `[${n}]`).join(" ")}${c.inherited ? " · from its paragraph" : ""}`
                            : "No citation"}</span>
                          {c.cited.length > 0 && (
                            <>
                              <span className="h-1 w-16 overflow-hidden rounded-full bg-line/60">
                                <span className={cn("block h-full rounded-full", c.supported ? "bg-ok" : "bg-danger")} style={{ width: `${Math.max(0, Math.min(1, c.support_score)) * 100}%` }} />
                              </span>
                              <span className="tabular-nums">{c.support_score.toFixed(2)}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </motion.li>
                  ))}
                </motion.ul>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </aside>
  );
}
