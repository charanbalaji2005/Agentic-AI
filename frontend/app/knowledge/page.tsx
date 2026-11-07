"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Database, Eye, FileCode2, FileText, FolderInput, Layers, Library, Plus, RefreshCw, RotateCw, ScanSearch, Search,
  Trash2, UploadCloud, X,
} from "lucide-react";
import { PageFrame, Reveal } from "@/components/app-shell";
import { DocumentPreviewModal } from "@/components/document-preview-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Empty, ErrorNote } from "@/components/ui/empty";
import { Input, Label } from "@/components/ui/input";
import { AnimatedNumber, Tooltip, stagger } from "@/components/ui/primitives";
import { useUI } from "@/components/ui-provider";
import { api } from "@/lib/api";
import { bytes, cn, timeAgo } from "@/lib/utils";
import type { KnowledgeBase } from "@/types";

type Job = { job_id: string; file_name: string; kb_id: string; status: string; error?: string; chunks: number; created_at: string };
type Doc = { doc_id: string; title: string; file_name: string; chunks: number; size: number; indexed_at: string };
type Hit = { chunk_id: string; file_name: string; page?: number; heading?: string; text: string; fused_score: number; rerank_score?: number; matched_by: string[] };

const JOB_TONE: Record<string, "ok" | "danger" | "warn" | "info" | "neutral"> = {
  indexed: "ok", failed: "danger", duplicate: "neutral", queued: "info", parsing: "info", embedding: "info",
};
const CODE_EXT = /\.(py|js|ts|tsx|jsx|java|go|rs|c|cpp|cs|rb|php|sql|sh|ya?ml|toml|tf|json)$/i;

export default function KnowledgePage() {
  const { toast, confirm } = useUI();
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [kb, setKb] = useState("default");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docFilter, setDocFilter] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [chunks, setChunks] = useState<{ doc: Doc; rows: any[] } | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ kbId: string; docId: string; fileName?: string } | null>(null);
  const [newKb, setNewKb] = useState({ kb_id: "", name: "" });
  const [folder, setFolder] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);

  const load = useCallback(() => {
    api.get<KnowledgeBase[]>("/api/kb").then(setKbs).catch((e) => setError(e.message));
    api.get<Doc[]>(`/api/kb/${kb}/documents`).then(setDocs).catch(() => setDocs([]));
    api.get<Job[]>("/api/kb/jobs").then(setJobs).catch(() => {});
  }, [kb]);
  useEffect(load, [load]);

  const running = jobs.some((j) => ["queued", "parsing", "embedding"].includes(j.status));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [running, load]);

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setError(null);
    try { await fn(); load(); if (success) toast(success); } catch (e: any) { setError(e.message); }
  };

  const upload = (files: FileList | File[]) => run(() => api.upload(`/api/kb/${kb}/upload`, Array.from(files)), `${files.length} file${files.length > 1 ? "s" : ""} queued for indexing`);
  const current = kbs.find((k) => k.kb_id === kb);
  const shownDocs = docs.filter((d) => !docFilter || `${d.title} ${d.file_name}`.toLowerCase().includes(docFilter.toLowerCase()));

  return (
    <PageFrame
      eyebrow="Knowledge" icon={<Library />} title="Documents"
      description="Upload files into knowledge bases. Each file is split by its headings and pages, embedded, and indexed for both meaning and keyword search."
    >
      <ErrorNote message={error} onDismiss={() => setError(null)} />

      {/* KB selector */}
      <Reveal>
        <div className="flex flex-wrap items-stretch gap-3">
          {kbs.map((k) => {
            const on = kb === k.kb_id;
            return (
              <motion.button key={k.kb_id} whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}
                             onClick={() => { setKb(k.kb_id); setHits(null); setChunks(null); }}
                             className={cn("glass relative min-w-[180px] rounded-2xl border px-4 py-3 text-left transition-colors",
                               on ? "border-accent/50 shadow-glow-sm" : "border-line/80 hover:border-line")}>
                {on && <motion.span layoutId="kb-active" className="absolute inset-0 rounded-2xl bg-accent/[0.07]" />}
                <span className="relative flex items-center gap-2 text-sm font-semibold">
                  <Database className={cn("size-4", on ? "text-accent" : "text-muted")} /> {k.name}
                </span>
                <span className="relative mt-1 flex gap-3 text-[12px] text-muted">
                  <span><span className="font-semibold tabular-nums text-ink">{k.documents}</span> files</span>
                  <span><span className="font-semibold tabular-nums text-ink">{k.chunks}</span> chunks</span>
                </span>
              </motion.button>
            );
          })}
          <form className="glass ml-auto flex items-center gap-2 rounded-2xl border border-dashed border-line px-3 py-2"
                onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post("/api/kb", { ...newKb, description: "" }); setKb(newKb.kb_id); setNewKb({ kb_id: "", name: "" }); }, "Knowledge base created"); }}>
            <Input placeholder="New knowledge base" value={newKb.name} className="w-44"
                   onChange={(e) => setNewKb({ name: e.target.value, kb_id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) })} />
            <Button type="submit" variant="primary" size="sm" disabled={newKb.kb_id.length < 2}><Plus /> Create</Button>
          </form>
        </div>
      </Reveal>

      {/* Stats strip */}
      {current && (
        <Reveal>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Files", value: current.documents, icon: FileText },
              { label: "Chunks", value: current.chunks, icon: Layers },
              { label: "Vectors", value: current.vectors, icon: ScanSearch },
            ].map(({ label, value, icon: Icon }) => (
              <Card key={label} className="flex items-center gap-3 px-4 py-3.5">
                <span className="grid size-9 place-items-center rounded-xl border border-line bg-sunken text-accent"><Icon className="size-4" /></span>
                <div>
                  <p className="font-display text-xl font-bold leading-none"><AnimatedNumber value={value} /></p>
                  <p className="mt-1 text-[12px] text-muted">{label}</p>
                </div>
              </Card>
            ))}
          </div>
        </Reveal>
      )}

      <Reveal className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader icon={<UploadCloud />} title="Add files" description="PDF, Word, Markdown, HTML, text, CSV, JSON and source code, up to 50 MB each." />
          <CardBody className="space-y-4">
            <label
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}
              className={cn("group relative flex cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-all",
                drag ? "scale-[1.01] border-accent bg-accent/10" : "border-line hover:border-accent/50 hover:bg-accent/[0.04]")}
            >
              <motion.span animate={drag ? { y: -6, scale: 1.1 } : { y: 0, scale: 1 }}
                           className="mb-3 grid size-12 place-items-center rounded-2xl bg-ink text-canvas">
                <UploadCloud className="size-6" />
              </motion.span>
              <span className="font-medium">{drag ? "Release to upload" : "Drop files here or click to browse"}</span>
              <span className="mt-0.5 text-sm text-muted">Re-uploading a file with the same name replaces the old version</span>
              <input type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
            </label>
            <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); run(() => api.form(`/api/kb/${kb}/ingest-folder`, { path: folder, recursive: "true" }), "Folder queued for indexing"); }}>
              <div className="flex-1">
                <Label hint="relative to data/uploads on the server">Index a folder</Label>
                <Input icon={<FolderInput />} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="handbook/2024" />
              </div>
              <Button type="submit" disabled={!folder}>Index folder</Button>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            icon={<RefreshCw className={cn(running && "animate-spin")} />} title="Indexing"
            description={running ? "Working…" : "Recent jobs"}
            action={<Tooltip label="Refresh"><Button variant="ghost" size="icon-sm" onClick={load} aria-label="Refresh"><RotateCw /></Button></Tooltip>}
          />
          <ul className="max-h-[320px] divide-y divide-line/70 overflow-y-auto scroll-thin">
            {jobs.length === 0 && <li className="px-5 py-6 text-center text-sm text-muted">Nothing indexing right now.</li>}
            <AnimatePresence initial={false}>
              {jobs.map((j) => {
                const active = ["queued", "parsing", "embedding"].includes(j.status);
                return (
                  <motion.li key={j.job_id} layout initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} className="relative px-5 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{j.file_name}</span>
                      <Badge tone={JOB_TONE[j.status] ?? "neutral"} dot pulse={active}>{j.status}</Badge>
                    </div>
                    {j.error && <p className="mt-0.5 text-[12.5px] text-danger">{j.error}</p>}
                    {active && (
                      <span className="absolute inset-x-5 bottom-1 h-0.5 overflow-hidden rounded-full bg-accent/15">
                        <span className="block h-full w-1/3 animate-shimmer rounded-full bg-brand" />
                      </span>
                    )}
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </Card>
      </Reveal>

      <Reveal>
        <Card>
          <CardHeader
            icon={<FileText />} title="Files in this knowledge base"
            description={`${docs.length} file${docs.length === 1 ? "" : "s"}`}
            action={docs.length > 4 ? <div className="w-56"><Input icon={<Search />} value={docFilter} onChange={(e) => setDocFilter(e.target.value)} placeholder="Filter files" /></div> : undefined}
          />
          {docs.length === 0 ? (
            <CardBody><Empty title="No files yet" icon={<FileText />}>Add files above to start asking questions about them.</Empty></CardBody>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[12px] uppercase tracking-wider text-muted">
                  <tr className="border-b border-line/70">
                    <th className="px-5 py-2.5 font-medium">File</th><th className="px-3 py-2.5 font-medium">Chunks</th>
                    <th className="px-3 py-2.5 font-medium">Size</th><th className="px-3 py-2.5 font-medium">Indexed</th><th />
                  </tr>
                </thead>
                <motion.tbody variants={stagger.container} initial="hidden" animate="show">
                  {shownDocs.map((d) => {
                    const Icon = CODE_EXT.test(d.file_name) ? FileCode2 : FileText;
                    return (
                      <motion.tr key={d.doc_id} variants={stagger.item} className="group border-b border-line/60 transition-colors last:border-0 hover:bg-accent/[0.04]">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-local/25 bg-local/10 text-local"><Icon className="size-4" /></span>
                            <div className="min-w-0">
                              <p className="truncate font-medium">{d.title}</p>
                              <p className="truncate text-[12px] text-muted">{d.file_name}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 tabular-nums">{d.chunks}</td>
                        <td className="px-3 tabular-nums text-muted">{bytes(d.size)}</td>
                        <td className="px-3 text-muted">{timeAgo(d.indexed_at)}</td>
                        <td className="px-3 text-right">
                          <div className="flex justify-end gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
                            <Tooltip label="Preview"><Button size="icon-sm" variant="ghost" aria-label="Preview" onClick={() => setPreviewDoc({ kbId: kb, docId: d.doc_id, fileName: d.file_name })}><Eye /></Button></Tooltip>
                            <Tooltip label="Inspect chunks"><Button size="icon-sm" variant="ghost" aria-label="Inspect chunks" onClick={() => run(async () => setChunks({ doc: d, rows: await api.get<any[]>(`/api/kb/${kb}/documents/${d.doc_id}/chunks`) }))}><Layers /></Button></Tooltip>
                            <Tooltip label="Re-index"><Button size="icon-sm" variant="ghost" aria-label="Re-index" onClick={() => run(() => api.post(`/api/kb/${kb}/documents/${d.doc_id}/reindex`), "Re-indexing started")}><RotateCw /></Button></Tooltip>
                            <Tooltip label="Delete"><Button size="icon-sm" variant="ghost" className="hover:text-danger" aria-label={`Delete ${d.file_name}`}
                              onClick={async () => { if (await confirm({ title: `Delete ${d.file_name}?`, description: "It will be removed from the index and won't be searchable.", confirmLabel: "Delete", danger: true })) run(() => api.del(`/api/kb/${kb}/documents/${d.doc_id}`), "File deleted"); }}><Trash2 /></Button></Tooltip>
                          </div>
                        </td>
                      </motion.tr>
                    );
                  })}
                </motion.tbody>
              </table>
            </div>
          )}
        </Card>
      </Reveal>

      <AnimatePresence>
        {chunks && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>
            <Card>
              <CardHeader icon={<Layers />} title={`Chunks of ${chunks.doc.file_name}`} description={`${chunks.rows.length} chunks`}
                          action={<Button size="icon-sm" variant="ghost" onClick={() => setChunks(null)} aria-label="Close"><X /></Button>} />
              <ol className="max-h-[440px] divide-y divide-line/60 overflow-y-auto scroll-thin">
                {chunks.rows.map((c) => (
                  <li key={c.chunk_id} className="px-5 py-3 text-[13px]">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="info">#{c.position}</Badge>
                      {c.page && <Badge>page {c.page}</Badge>}
                      {c.heading && <span className="truncate text-[12px] font-medium">{c.heading}</span>}
                      <span className="ml-auto text-[11px] text-muted">{c.content_type}</span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap leading-relaxed text-ink/90">{c.text}</p>
                  </li>
                ))}
              </ol>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      <Reveal>
        <Card>
          <CardHeader icon={<ScanSearch />} title="Test retrieval" description="Runs the same hybrid search the local agent uses: query rewrites, HyDE, meaning + keyword search, fusion and reranking." />
          <CardBody className="space-y-4">
            <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); setSearching(true); try { setHits(await api.post<Hit[]>(`/api/kb/${kb}/search`, { query, top_k: 8 })); } catch (er: any) { setError(er.message); } finally { setSearching(false); } }}>
              <Input icon={<Search />} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="What does the retry policy say?" />
              <Button type="submit" variant="primary" loading={searching} disabled={!query}>{!searching && <Search />} {searching ? "Searching…" : "Search"}</Button>
            </form>
            {hits && hits.length === 0 && <Empty title="No passages matched" icon={<Search />}>Try different words, or check the files are indexed.</Empty>}
            {hits && hits.length > 0 && (() => {
              const max = Math.max(...hits.map((h) => h.rerank_score ?? h.fused_score ?? 0), 1e-6);
              return (
                <motion.ol className="space-y-2.5" variants={stagger.container} initial="hidden" animate="show">
                  {hits.map((h, i) => {
                    const s = h.rerank_score ?? h.fused_score ?? 0;
                    return (
                      <motion.li key={h.chunk_id} variants={stagger.item} className="rounded-2xl border border-line/70 bg-surface/50 p-4 text-[13px] transition-colors hover:border-accent/40">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="grid size-6 place-items-center rounded-lg bg-accent/15 text-[11px] font-bold text-accent">{i + 1}</span>
                          <span className="font-semibold">{h.file_name}</span>
                          {h.page && <span className="text-muted">page {h.page}</span>}
                          {h.heading && <span className="truncate text-muted">· {h.heading}</span>}
                          <span className="ml-auto flex items-center gap-2 text-[12px] text-muted">
                            relevance
                            <span className="h-1.5 w-20 overflow-hidden rounded-full bg-line/70">
                              <motion.span className="block h-full rounded-full bg-brand" initial={{ width: 0 }} animate={{ width: `${Math.max(4, (s / max) * 100)}%` }} transition={{ duration: 0.6, delay: i * 0.04 }} />
                            </span>
                            <span className="tabular-nums text-ink">{h.rerank_score?.toFixed(3) ?? "–"}</span>
                          </span>
                        </div>
                        <p className="mt-2 line-clamp-4 whitespace-pre-wrap leading-relaxed text-ink/90">{h.text}</p>
                        <div className="mt-2.5 flex gap-1">{h.matched_by.map((m) => <Badge key={m} tone="info">{m}</Badge>)}</div>
                      </motion.li>
                    );
                  })}
                </motion.ol>
              );
            })()}
          </CardBody>
        </Card>
      </Reveal>

      {previewDoc && (
        <DocumentPreviewModal kbId={previewDoc.kbId} docId={previewDoc.docId} fileName={previewDoc.fileName} onClose={() => setPreviewDoc(null)} />
      )}
    </PageFrame>
  );
}
