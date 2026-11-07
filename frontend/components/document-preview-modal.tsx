"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { AlignLeft, Check, Copy, ExternalLink, FileText, LayoutList, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogClose, Skeleton, Tabs, stagger } from "@/components/ui/primitives";
import { api } from "@/lib/api";

interface PreviewData {
  doc_id: string;
  title: string;
  file_name: string;
  file_path: string;
  content_type?: string;
  chunk_count: number;
  full_text: string;
  sections: Array<{
    chunk_id: string;
    position: number;
    page?: number;
    heading?: string;
    content_type: string;
    text: string;
  }>;
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q || q.length < 2) return <>{text}</>;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${esc})`, "gi"));
  return (
    <>
      {parts.map((p, i) => (p.toLowerCase() === q.toLowerCase()
        ? <mark key={i} className="rounded bg-accent/30 px-0.5 text-ink">{p}</mark>
        : <span key={i}>{p}</span>))}
    </>
  );
}

export function DocumentPreviewModal({ kbId, docId, fileName, onClose }: {
  kbId: string; docId: string; fileName?: string; onClose: () => void;
}) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"text" | "sections">("text");
  const [q, setQ] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api.previewDocument<PreviewData>(kbId, docId)
      .then((res) => { if (active) { setData(res); setLoading(false); } })
      .catch((err) => { if (active) { setError(err.message || "Failed to load document preview"); setLoading(false); } });
    return () => { active = false; };
  }, [kbId, docId]);

  const matches = useMemo(() => {
    if (!data || q.length < 2) return 0;
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (data.full_text.match(new RegExp(esc, "gi")) ?? []).length;
  }, [data, q]);

  const sections = useMemo(
    () => (data?.sections ?? []).filter((s) => q.length < 2 || s.text.toLowerCase().includes(q.toLowerCase()) || s.heading?.toLowerCase().includes(q.toLowerCase())),
    [data, q],
  );

  const copyText = () => {
    if (!data?.full_text) return;
    navigator.clipboard.writeText(data.full_text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const fileUrl = api.documentFileUrl(kbId, docId);

  return (
    <Dialog open onClose={onClose} className="flex max-h-[88vh] max-w-4xl flex-col" label="Document preview">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-local/30 bg-local/10 text-local">
            <FileText className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{data?.title || fileName || "Document preview"}</h2>
            <p className="truncate text-xs text-muted">
              {data?.file_name || fileName}{data ? ` · ${data.chunk_count} indexed chunks · ${data.full_text.length.toLocaleString()} chars` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild size="sm" variant="secondary">
            <a href={fileUrl} target="_blank" rel="noreferrer"><ExternalLink /> Open original</a>
          </Button>
          {data?.full_text && (
            <Button size="sm" variant="secondary" onClick={copyText}>
              {copied ? <Check className="text-ok" /> : <Copy />}
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
          <DialogClose onClose={onClose} />
        </div>
      </div>

      {data && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-3">
          <Tabs id="doc-preview" variant="pill" value={tab} onChange={setTab}
                items={[
                  { id: "text", label: "Full text", icon: <AlignLeft /> },
                  { id: "sections", label: "Chunks", icon: <LayoutList />, count: data.sections.length },
                ]} />
          <div className="flex w-full items-center gap-2 sm:w-64">
            <Input icon={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find in document…" aria-label="Find in document" />
            {q.length >= 2 && <span className="shrink-0 text-[12px] tabular-nums text-muted">{tab === "text" ? matches : sections.length}</span>}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto scroll-thin p-6">
        {loading && (
          <div className="space-y-3">
            {[92, 84, 96, 70, 88, 60].map((w, i) => <div key={i} style={{ width: `${w}%` }}><Skeleton className="h-3.5" /></div>)}
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            <p className="font-semibold">Unable to load document preview</p>
            <p className="mt-1 text-xs">{error}</p>
          </div>
        )}

        {!loading && !error && data && (
          tab === "text" ? (
            <div className="select-text whitespace-pre-wrap rounded-xl border border-line bg-sunken/60 p-5 font-mono text-[12.5px] leading-relaxed">
              {data.full_text ? <Highlight text={data.full_text} q={q} /> : "(No extracted text found in this document)"}
            </div>
          ) : (
            <motion.div className="space-y-3" variants={stagger.container} initial="hidden" animate="show">
              {sections.map((sec) => (
                <motion.div key={sec.chunk_id} variants={stagger.item}
                            className="rounded-xl border border-line bg-surface/60 p-4 text-xs transition-colors hover:border-accent/40">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge tone="info">Chunk #{sec.position + 1}</Badge>
                    {sec.page && <Badge>Page {sec.page}</Badge>}
                    {sec.heading && <span className="max-w-md truncate font-semibold">{sec.heading}</span>}
                    <span className="ml-auto text-[11px] text-muted">{sec.content_type}</span>
                  </div>
                  <p className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink/90"><Highlight text={sec.text} q={q} /></p>
                </motion.div>
              ))}
              {sections.length === 0 && <p className="py-8 text-center text-sm text-muted">No chunks match “{q}”.</p>}
            </motion.div>
          )
        )}
      </div>
    </Dialog>
  );
}
