"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Binary, Cpu, Gauge, MemoryStick, MessageSquareText, Save, SlidersHorizontal, SortDesc } from "lucide-react";
import { PageFrame, Reveal } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorNote } from "@/components/ui/empty";
import { Input, Label, Select } from "@/components/ui/input";
import { Skeleton, Switch } from "@/components/ui/primitives";
import { useUI } from "@/components/ui-provider";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ModelStatus } from "@/types";

const GENERATORS = ["Qwen/Qwen2.5-0.5B-Instruct", "Qwen/Qwen2.5-3B-Instruct", "Qwen/Qwen2.5-7B-Instruct",
  "meta-llama/Llama-3.1-8B-Instruct", "mistralai/Mistral-7B-Instruct-v0.3", "google/gemma-2-9b-it"];
const RERANKERS = ["BAAI/bge-reranker-v2-m3", "cross-encoder/ms-marco-MiniLM-L-6-v2"];
const STATE_TONE = { ready: "ok", loading: "info", unloaded: "neutral", error: "danger" } as const;

type Status = { generator: ModelStatus; embedder: ModelStatus; reranker: ModelStatus; gpu: { name: string; used_gb: number; total_gb: number } | null; device_available: string };

function ModelCard({ role, title, purpose, icon, s, presets, onLoad, quant }: {
  role: string; title: string; purpose: string; icon: React.ReactNode; s: ModelStatus; presets?: string[];
  onLoad?: (name: string, q?: string) => void; quant?: boolean;
}) {
  const [name, setName] = useState(s.name ?? "");
  const [q, setQ] = useState("none");
  useEffect(() => { if (s.name) setName(s.name); }, [s.name]);
  const loading = s.state === "loading";
  return (
    <Card className={cn("flex flex-col", s.state === "ready" && "border-ok/25")} spotlight={!loading}>
      <div className={cn("relative flex flex-col", loading && "beam rounded-2xl")}>
        <CardHeader icon={icon} title={title} description={purpose}
                    action={<Badge tone={STATE_TONE[s.state]} dot pulse={loading || s.state === "ready"}>{s.state}</Badge>} />
        <CardBody className="flex flex-1 flex-col space-y-4 text-sm">
          <div className="rounded-xl border border-line/70 bg-sunken/50 p-3">
            <p className="truncate font-mono text-[12.5px] font-medium">{s.name ?? "–"}</p>
            <dl className="mt-2 grid grid-cols-[96px_1fr] gap-y-1 text-[12.5px]">
              <dt className="text-muted">Device</dt><dd>{s.device ?? "–"}</dd>
              {s.load_seconds != null && (<><dt className="text-muted">Load time</dt><dd className="tabular-nums">{s.load_seconds} s</dd></>)}
              {Object.entries(s.extra ?? {}).map(([k, v]) => (<Fragment key={k}><dt className="truncate text-muted">{k}</dt><dd className="truncate">{String(v)}</dd></Fragment>))}
            </dl>
          </div>
          {s.error && <ErrorNote message={s.error} />}
          {onLoad ? (
            <form className="mt-auto space-y-2 border-t border-line/70 pt-4" onSubmit={(e) => { e.preventDefault(); onLoad(name, quant ? q : undefined); }}>
              <Label hint="any Hugging Face model id">Switch {role}</Label>
              <Input list={`${role}-presets`} value={name} onChange={(e) => setName(e.target.value)} className="font-mono text-[12.5px]" />
              <datalist id={`${role}-presets`}>{presets?.map((p) => <option key={p} value={p} />)}</datalist>
              {quant && (
                <Select value={q} onChange={(e) => setQ(e.target.value)} aria-label="Quantization">
                  <option value="none">Full precision</option>
                  <option value="8bit">8-bit (CUDA)</option>
                  <option value="4bit">4-bit NF4 (CUDA)</option>
                </Select>
              )}
              <Button type="submit" variant="secondary" className="w-full" loading={loading} disabled={!name}>{loading ? "Loading…" : "Load model"}</Button>
            </form>
          ) : (
            <p className="mt-auto border-t border-line/70 pt-4 text-[12.5px] leading-relaxed text-muted">Changing the embedding model means re-indexing every document. Set EMBEDDING_MODEL in .env, clear data/indexes and restart.</p>
          )}
        </CardBody>
      </div>
    </Card>
  );
}

export default function ModelsPage() {
  const { toast } = useUI();
  const [st, setSt] = useState<Status | null>(null);
  const [cfg, setCfg] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.get<Status>("/api/models").then(setSt).catch((e) => setError(e.message));
    api.get<Record<string, any>>("/api/settings").then(setCfg).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!st || ![st.generator, st.reranker].some((m) => m.state === "loading")) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [st, load]);

  const loadModel = (role: string) => async (name: string, quantization?: string) => {
    setError(null);
    try { await api.post("/api/models/load", { role, name, quantization }); toast(`Loading ${name.split("/").pop()}`, { tone: "info" }); setTimeout(load, 500); } catch (e: any) { setError(e.message); }
  };

  const set = (k: string, v: any) => setCfg((c) => ({ ...c, [k]: v }));

  /** Numeric field with an optional range slider. */
  const field = (k: string, label: string, opts: { step?: number; min?: number; max?: number; hint?: string } = {}) => (
    <label className="block rounded-xl border border-line/70 bg-sunken/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <Label hint={opts.hint}>{label}</Label>
        <Input type="number" step={opts.step ?? 1} value={cfg?.[k] ?? ""} className="-mt-1.5 h-7 w-24 text-right tabular-nums"
               onChange={(e) => set(k, e.target.value === "" ? "" : Number(e.target.value))} />
      </div>
      {opts.max != null && (
        <input type="range" className="range mt-2 w-full" min={opts.min ?? 0} max={opts.max} step={opts.step ?? 1}
               value={Number(cfg?.[k] ?? 0)} onChange={(e) => set(k, Number(e.target.value))}
               style={{ background: `linear-gradient(90deg, rgb(var(--accent)) ${((Number(cfg?.[k] ?? 0) - (opts.min ?? 0)) / (opts.max - (opts.min ?? 0))) * 100}%, rgb(var(--sunken)) 0)` }} />
      )}
    </label>
  );

  const gpuPct = st?.gpu ? st.gpu.used_gb / Math.max(st.gpu.total_gb, 0.01) : 0;

  return (
    <PageFrame eyebrow="Runtime" icon={<Cpu />} title="Models" description="Every model runs locally through Hugging Face Transformers. Swap the language model or reranker without restarting.">
      <ErrorNote message={error} onDismiss={() => setError(null)} />

      <Reveal>
        <Card className="flex flex-wrap items-center gap-4 px-5 py-4">
          <span className="grid size-10 place-items-center rounded-xl border border-line bg-sunken text-accent"><MemoryStick className="size-5" /></span>
          {!st ? <Skeleton className="h-4 w-64" /> : st.gpu ? (
            <div className="min-w-[240px] flex-1">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{st.gpu.name}</span>
                <span className="tabular-nums text-muted">{st.gpu.used_gb} / {st.gpu.total_gb} GB</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-line/60">
                <motion.div className={cn("h-full rounded-full", gpuPct > 0.9 ? "bg-danger" : gpuPct > 0.7 ? "bg-warn" : "bg-brand")}
                            initial={{ width: 0 }} animate={{ width: `${gpuPct * 100}%` }} transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">No CUDA GPU detected; running on <span className="font-medium text-ink">{st.device_available}</span>.</p>
          )}
        </Card>
      </Reveal>

      <Reveal>
        {st ? (
          <div className="grid gap-5 lg:grid-cols-3">
            <ModelCard role="generator" title="Language model" icon={<MessageSquareText />} purpose="Plans, rewrites queries and writes answers" s={st.generator} presets={GENERATORS} onLoad={loadModel("generator")} quant />
            <ModelCard role="embedder" title="Embedding model" icon={<Binary />} purpose="Turns text into vectors for meaning search" s={st.embedder} />
            <ModelCard role="reranker" title="Reranker" icon={<SortDesc />} purpose="Scores passages and checks claims against sources" s={st.reranker} presets={RERANKERS} onLoad={loadModel("reranker")} />
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-72 rounded-2xl" />)}</div>
        )}
      </Reveal>

      {cfg && (
        <Reveal>
          <Card>
            <CardHeader icon={<SlidersHorizontal />} title="Generation and retrieval settings" description="Applied immediately to new questions. Restarting restores the values in .env." />
            <CardBody>
              <form className="space-y-5" onSubmit={async (e) => {
                e.preventDefault();
                setSaving(true);
                const body = { temperature: cfg.llm_temperature, top_p: cfg.llm_top_p, max_new_tokens: cfg.llm_max_new_tokens,
                  context_token_budget: cfg.context_token_budget, rerank_top_k: cfg.rerank_top_k, max_iterations: cfg.max_iterations,
                  sufficiency_threshold: cfg.sufficiency_threshold, use_hyde: cfg.use_hyde, multi_query_count: cfg.multi_query_count };
                try { setCfg(await api.patch("/api/settings", body)); toast("Settings saved", { description: "New questions will use these values." }); }
                catch (er: any) { setError(er.message); } finally { setSaving(false); }
              }}>
                <div>
                  <p className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted"><MessageSquareText className="size-3.5" /> Generation</p>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {field("llm_temperature", "Temperature", { step: 0.05, min: 0, max: 2 })}
                    {field("llm_top_p", "Top-p", { step: 0.05, min: 0, max: 1 })}
                    {field("llm_max_new_tokens", "Max answer tokens", { step: 32, min: 64, max: 4096 })}
                    {field("context_token_budget", "Context budget", { step: 256, min: 512, max: 32768, hint: "tokens" })}
                  </div>
                </div>
                <div>
                  <p className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted"><Gauge className="size-3.5" /> Retrieval</p>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {field("rerank_top_k", "Passages per search", { min: 1, max: 30 })}
                    {field("multi_query_count", "Query rewrites", { min: 0, max: 8 })}
                    {field("max_iterations", "Retrieval rounds", { min: 1, max: 6 })}
                    {field("sufficiency_threshold", "Evidence threshold", { step: 0.05, min: 0, max: 1, hint: "0–1" })}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line/70 bg-sunken/40 p-3">
                  <Switch checked={!!cfg.use_hyde} onChange={(v) => set("use_hyde", v)}
                          label="Hypothetical-answer search (HyDE)" description="Drafts an answer first and searches with it to improve recall." />
                  <p className="text-[12.5px] text-muted">Chunking: <span className="text-ink">{cfg.chunk_strategy}</span>, {cfg.chunk_size} chars · Vector store: <span className="text-ink">{cfg.vector_backend}</span></p>
                </div>
                <Button type="submit" variant="primary" loading={saving}>{!saving && <Save />} Save settings</Button>
              </form>
            </CardBody>
          </Card>
        </Reveal>
      )}
    </PageFrame>
  );
}
