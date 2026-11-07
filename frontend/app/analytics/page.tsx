"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle, BarChart3, Bot, CheckCircle2, Clock, Download, FlaskConical, History, MessagesSquare, Play, Search, Target, Timer, Users,
} from "lucide-react";
import { PageFrame, Reveal } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Empty, ErrorNote } from "@/components/ui/empty";
import { Input, Label, Textarea } from "@/components/ui/input";
import { AnimatedNumber, Skeleton, Tabs, statusTone } from "@/components/ui/primitives";
import { useUI } from "@/components/ui-provider";
import { api } from "@/lib/api";
import { agentColor, cn, ms, pct, timeAgo } from "@/lib/utils";

type Analytics = {
  queries: number; avg_retrieval_ms: number; avg_generation_ms: number; avg_supported_ratio: number; avg_top_score: number;
  insufficient: number; output_tokens: number; agent_usage: Record<string, number>;
  tool_usage: { server: string; tool: string; status: string; count: number }[];
  recent: { ts: string; retrieval_ms: number; generation_ms: number; supported_ratio: number; top_score: number }[];
};

const SAMPLE = `[
  {"question": "How many times are failed uploads retried?", "expected_sources": ["ops.md"], "ground_truth": "Three times with exponential backoff."}
]`;

const METRIC_LABEL: Record<string, string> = {
  "recall@k": "Recall@k", "precision@k": "Precision@k", mrr: "MRR", "ndcg@k": "nDCG@k", context_precision: "Context precision",
  context_recall: "Context recall", faithfulness: "Faithfulness", answer_relevancy: "Answer relevancy",
  citation_correctness: "Citation correctness", retrieval_ms: "Retrieval latency", generation_ms: "Generation latency", output_tokens: "Output tokens",
};

const STATUS_LABEL = { ok: "Well grounded", warn: "Partially grounded", danger: "Weakly grounded" } as const;
const STATUS_ICON = { ok: CheckCircle2, warn: AlertTriangle, danger: AlertTriangle } as const;
const STATUS_TEXT = { ok: "text-ok", warn: "text-warn", danger: "text-danger" } as const;

function fmt(k: string, v: number) {
  if (k.endsWith("_ms")) return ms(v);
  if (k === "output_tokens") return Math.round(v).toString();
  return v.toFixed(3);
}

/** Round an axis max up to a tidy number. */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function LatencyChart({ data }: { data: Analytics["recent"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(1, ...data.map((r) => r.retrieval_ms + r.generation_ms)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const h = data[hover ?? -1];
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-[12px] text-muted">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-accent" /> Generation</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-muted/60" /> Retrieval</span>
      </div>
      <div className="relative flex h-48 gap-2">
        {/* Y axis */}
        <div className="flex w-12 shrink-0 flex-col-reverse justify-between text-right text-[10.5px] tabular-nums text-muted">
          {ticks.map((t) => <span key={t} className="-mb-1.5 leading-none">{ms(t)}</span>)}
        </div>
        <div className="relative flex-1" onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 border-t border-line/50" style={{ bottom: `${(t / max) * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-[3px] overflow-x-auto" role="img" aria-label="Latency per recent question">
            {data.map((r, i) => {
              const total = r.retrieval_ms + r.generation_ms;
              return (
                <div key={i} className="relative flex h-full min-w-[8px] max-w-[28px] flex-1 cursor-pointer items-end" onMouseEnter={() => setHover(i)}>
                  <motion.div
                    className={cn("flex w-full flex-col justify-end gap-[2px] transition-opacity", hover != null && hover !== i && "opacity-40")}
                    initial={{ height: 0 }} animate={{ height: `${(total / max) * 100}%` }}
                    transition={{ type: "spring", stiffness: 120, damping: 20, delay: i * 0.015 }}
                  >
                    <div className="w-full rounded-t-[4px] bg-accent" style={{ flexGrow: r.generation_ms }} />
                    <div className="w-full bg-muted/60" style={{ flexGrow: r.retrieval_ms }} />
                  </motion.div>
                </div>
              );
            })}
          </div>
          <AnimatePresence>
            {h && hover != null && (
              <motion.div
                key="tip" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="pointer-events-none absolute top-0 z-10 w-52 rounded-xl border border-line bg-elevated p-3 text-[12px] shadow-float"
                style={{ left: `clamp(0px, calc(${((hover + 0.5) / data.length) * 100}% - 104px), calc(100% - 208px))` }}
              >
                <p className="font-semibold">{ms(h.retrieval_ms + h.generation_ms)} total</p>
                <p className="text-muted">{new Date(h.ts).toLocaleString()}</p>
                <div className="mt-2 space-y-1">
                  <p className="flex justify-between"><span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-accent" />Generation</span><span className="tabular-nums">{ms(h.generation_ms)}</span></p>
                  <p className="flex justify-between"><span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-muted/60" />Retrieval</span><span className="tabular-nums">{ms(h.retrieval_ms)}</span></p>
                  {(() => {
                    const t = statusTone(h.supported_ratio); const I = STATUS_ICON[t];
                    return <p className="flex justify-between border-t border-line pt-1"><span className={cn("flex items-center gap-1", STATUS_TEXT[t])}><I className="size-3" />{STATUS_LABEL[t]}</span><span className="tabular-nums">{pct(h.supported_ratio)}</span></p>;
                  })()}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { toast } = useUI();
  const [a, setA] = useState<Analytics | null>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [dataset, setDataset] = useState(SAMPLE);
  const [name, setName] = useState("Baseline");
  const [k, setK] = useState(5);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [runQ, setRunQ] = useState("");

  const load = useCallback(() => {
    api.get<Analytics>("/api/analytics").then(setA).catch((e) => setError(e.message));
    api.get<any[]>("/api/eval/runs").then(setRuns).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const datasetCount = useMemo(() => { try { const d = JSON.parse(dataset); return Array.isArray(d) ? d.length : null; } catch { return null; } }, [dataset]);
  const agentRows = Object.entries(a?.agent_usage ?? {}).sort((x, y) => y[1] - x[1]);
  const agentMax = Math.max(1, ...agentRows.map(([, n]) => n));
  const toolTotal = a?.tool_usage.reduce((s, t) => s + t.count, 0) ?? 0;
  const toolFailed = a?.tool_usage.filter((t) => !["ok", "awaiting_approval", "rejected"].includes(t.status)).reduce((s, t) => s + t.count, 0) ?? 0;

  const tiles = a ? [
    { label: "Questions answered", value: a.queries, format: (n: number) => Math.round(n).toLocaleString(), icon: MessagesSquare },
    { label: "Claims supported", value: a.avg_supported_ratio * 100, format: (n: number) => `${Math.round(n)}%`, icon: CheckCircle2, tone: statusTone(a.avg_supported_ratio) },
    { label: "Best evidence score", value: a.avg_top_score, format: (n: number) => n.toFixed(2), icon: Target },
    { label: "Retrieval time", value: a.avg_retrieval_ms, format: (n: number) => ms(n), icon: Search },
    { label: "Generation time", value: a.avg_generation_ms, format: (n: number) => ms(n), icon: Timer },
    { label: "Weak-evidence answers", value: a.insufficient, format: (n: number) => Math.round(n).toString(), icon: AlertTriangle },
  ] : [];

  return (
    <PageFrame eyebrow="Evaluation" icon={<BarChart3 />} title="Quality" description="How well retrieval and answers are holding up, and a benchmark you can re-run after changing models or chunking.">
      <ErrorNote message={error} onDismiss={() => setError(null)} />

      <Reveal>
        {a ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            {tiles.map(({ label, value, format, icon: Icon, tone }) => (
              <Card key={label} className="p-4">
                <div className="flex items-center justify-between">
                  <span className="grid size-8 place-items-center rounded-lg border border-line bg-sunken text-accent"><Icon className="size-4" /></span>
                  {tone && <span className={cn("size-2 rounded-full", tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : "bg-danger")} title={STATUS_LABEL[tone]} />}
                </div>
                <p className="mt-3 font-display text-2xl font-bold leading-none"><AnimatedNumber value={value} format={format} /></p>
                <p className="mt-1.5 text-[12px] text-muted">{label}</p>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
        )}
      </Reveal>

      {a && (
        <Reveal className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <Card>
            <CardHeader icon={<Clock />} title="Latency of recent questions" description="Each bar is one question, split into retrieval and generation time. Hover for details."
                        action={<Tabs id="lat-view" variant="pill" value={view} onChange={setView} items={[{ id: "chart", label: "Chart" }, { id: "table", label: "Table" }]} />} />
            <CardBody>
              {a.recent.length === 0 ? <Empty title="No questions yet" icon={<BarChart3 />} /> : view === "chart" ? (
                <LatencyChart data={a.recent} />
              ) : (
                <div className="max-h-56 overflow-auto scroll-thin">
                  <table className="w-full text-[12.5px]">
                    <thead className="sticky top-0 bg-surface text-left text-muted"><tr className="border-b border-line">{["When", "Retrieval", "Generation", "Total", "Grounded"].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
                    <tbody>
                      {a.recent.map((r, i) => (
                        <tr key={i} className="border-b border-line/50 last:border-0">
                          <td className="px-2 py-1.5 text-muted">{timeAgo(r.ts)}</td>
                          <td className="px-2 tabular-nums">{ms(r.retrieval_ms)}</td>
                          <td className="px-2 tabular-nums">{ms(r.generation_ms)}</td>
                          <td className="px-2 font-medium tabular-nums">{ms(r.retrieval_ms + r.generation_ms)}</td>
                          <td className={cn("px-2 tabular-nums", STATUS_TEXT[statusTone(r.supported_ratio)])}>{pct(r.supported_ratio)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader icon={<Users />} title="Agent use" description="Runs per agent" />
            <CardBody className="space-y-3 text-sm">
              {agentRows.length === 0 && <p className="text-muted">No agent runs yet.</p>}
              {agentRows.map(([agent, n], i) => (
                <div key={agent}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="flex items-center gap-2 capitalize"><Bot className="size-3.5 text-muted" />{agent.replace("_", " ")}</span>
                    <span className="font-semibold tabular-nums">{n}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-line/50">
                    <motion.div className="h-full rounded-full" style={{ background: agentColor(agent) }}
                                initial={{ width: 0 }} animate={{ width: `${(n / agentMax) * 100}%` }} transition={{ duration: 0.8, delay: 0.1 + i * 0.08, ease: [0.22, 1, 0.36, 1] }} />
                  </div>
                </div>
              ))}
              {toolTotal > 0 && (
                <div className="flex items-center justify-between rounded-xl border border-line/70 bg-sunken/50 px-3 py-2 text-[12.5px]">
                  <span className="text-muted">Tool calls</span>
                  <span><span className="font-semibold tabular-nums">{toolTotal}</span>{toolFailed > 0 && <span className="text-danger"> · {toolFailed} failed</span>}</span>
                </div>
              )}
            </CardBody>
          </Card>
        </Reveal>
      )}

      <Reveal>
        <Card>
          <CardHeader icon={<FlaskConical />} title="Run a benchmark" description="Each item lists the files that should be found. Retrieval is scored at the file level; with answers on, each question also goes through the full agent pipeline." />
          <CardBody className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
              <label><Label>Run name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></label>
              <label><Label>Top k</Label><Input type="number" min={1} max={20} value={k} onChange={(e) => setK(Number(e.target.value))} /></label>
            </div>
            <label className="block">
              <Label hint={datasetCount != null ? `JSON list · ${datasetCount} question${datasetCount === 1 ? "" : "s"}` : "JSON list · invalid JSON"}>Questions</Label>
              <Textarea rows={8} value={dataset} onChange={(e) => setDataset(e.target.value)} className={cn("font-mono text-[12.5px] leading-6", datasetCount == null && "border-danger/50")} spellCheck={false} />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={running} disabled={datasetCount == null} onClick={async () => {
                setError(null); setRunning(true);
                try { setResult(await api.post("/api/eval/run", { name, k, generate: true, items: JSON.parse(dataset) })); toast("Benchmark complete", { description: name }); load(); }
                catch (e: any) { setError(e instanceof SyntaxError ? `Questions are not valid JSON: ${e.message}` : e.message); }
                finally { setRunning(false); }
              }}>{!running && <Play />} {running ? "Running benchmark…" : "Run benchmark"}</Button>
              {result?.ragas_records?.length > 0 && (
                <Button variant="secondary" onClick={() => {
                  const blob = new Blob([result.ragas_records.map((r: any) => JSON.stringify(r)).join("\n")], { type: "application/jsonl" });
                  const u = URL.createObjectURL(blob); const el = document.createElement("a"); el.href = u; el.download = `${name}-ragas.jsonl`; el.click(); URL.revokeObjectURL(u);
                }}><Download /> Download Ragas dataset</Button>
              )}
            </div>
            <AnimatePresence>
              {result && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {Object.entries(result.metrics as Record<string, number>).map(([key, v], i) => {
                    const unit = !key.endsWith("_ms") && key !== "output_tokens";
                    return (
                      <motion.div key={key} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.04 }}
                                  className="rounded-xl border border-line/70 bg-sunken/50 px-4 py-3">
                        <p className="font-display text-xl font-bold tabular-nums">{fmt(key, v)}</p>
                        <p className="text-[12px] text-muted">{METRIC_LABEL[key] ?? key}</p>
                        {unit && (
                          <div className="mt-2 h-1 overflow-hidden rounded-full bg-line/60">
                            <motion.div className="h-full rounded-full bg-brand" initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }} transition={{ duration: 0.8, delay: 0.1 + i * 0.04 }} />
                          </div>
                        )}
                      </motion.div>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </CardBody>
        </Card>
      </Reveal>

      {runs.length > 0 && (
        <Reveal>
          <Card>
            <CardHeader icon={<History />} title="Benchmark history" description="Compare runs after changing models, chunking or retrieval settings."
                        action={<div className="w-48"><Input icon={<Search />} value={runQ} onChange={(e) => setRunQ(e.target.value)} placeholder="Filter runs" /></div>} />
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="text-left text-[12px] uppercase tracking-wider text-muted"><tr className="border-b border-line/70">{["Run", "Models", "Recall@k", "nDCG@k", "Faithfulness", "Citations", "When"].map((h) => <th key={h} className="px-5 py-2.5 font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {runs.filter((r) => !runQ || r.name.toLowerCase().includes(runQ.toLowerCase())).map((r, idx, arr) => {
                    const best = (key: string) => Math.max(...arr.map((x) => x.metrics[key] ?? -1));
                    const cell = (key: string) => {
                      const v = r.metrics[key];
                      if (v == null) return <span className="text-muted">–</span>;
                      const top = arr.length > 1 && v === best(key);
                      return <span className={cn("tabular-nums", top && "font-semibold text-ok")}>{v.toFixed(3)}{top && " ★"}</span>;
                    };
                    return (
                      <tr key={r.id} className="border-b border-line/50 transition-colors last:border-0 hover:bg-accent/[0.04]">
                        <td className="px-5 py-2.5 font-medium">{r.name}{idx === 0 && <Badge tone="info" className="ml-2">latest</Badge>}</td>
                        <td className="px-5 font-mono text-[12px] text-muted">{[r.config.llm, r.config.reranker].filter(Boolean).map((s: string) => s.split("/").pop()).join(", ")}</td>
                        <td className="px-5">{cell("recall@k")}</td>
                        <td className="px-5">{cell("ndcg@k")}</td>
                        <td className="px-5">{cell("faithfulness")}</td>
                        <td className="px-5">{cell("citation_correctness")}</td>
                        <td className="whitespace-nowrap px-5 text-muted">{timeAgo(r.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </Reveal>
      )}
    </PageFrame>
  );
}
