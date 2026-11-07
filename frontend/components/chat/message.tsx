"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle, BookmarkPlus, Check, CheckCircle2, ChevronRight, CircleDashed, Cloud, Copy, Database, Download, FileDown,
  FileText, Globe, Hourglass, Layers, Loader2, RotateCcw, Sparkles, Wrench, X, XCircle,
} from "lucide-react";
import { ApprovalCard } from "./approval-card";
import { AttachmentChip, Popover, useDismiss } from "./composer";
import { CodeBlock, TableBlock, hastText, saveFile } from "./markdown-blocks";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/primitives";
import { useUI } from "@/components/ui-provider";
import { api } from "@/lib/api";
import { cn, ms, pct } from "@/lib/utils";
import type { ChatMessage, RunState } from "@/types";

/** Turn [n] markers into citation links, leaving fenced code blocks, inline code, and LaTeX math untouched. */
function withCitationLinks(text: string) {
  // Split out fenced blocks (``` or ~~~), inline code spans, block math ($$...$$), and inline math ($...$).
  const parts = text.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?(?:^(?:```|~~~)[ \t]*$|(?![\s\S]))|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/m);
  return parts.map((p, i) => (i % 2 === 1 ? p : p.replace(/\[(\d+)\](?![(\]])/g, "[$1](#cite-$1)"))).join("");
}

const AGENT_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  local_rag: Database, web_research: Globe, cloud: Cloud, aggregator: Sparkles,
};
const STEP_ICON = { pending: CircleDashed, running: Loader2, awaiting_approval: Hourglass, completed: CheckCircle2, failed: XCircle, skipped: CircleDashed };

/** One-line summary of what the agents did, like a tool-use row. */
function workSummary(run: RunState) {
  const steps = Object.values(run.steps);
  if (!run.done) return run.agents.aggregator?.detail ?? "Thinking";
  const parts: string[] = [];
  if (steps.length) parts.push(`${steps.length} step${steps.length > 1 ? "s" : ""}`);
  if (run.evidence.length) parts.push(`searched ${run.evidence.length} passage${run.evidence.length > 1 ? "s" : ""}`);
  const tools = run.tools.filter((t) => t.event === "tool_result").length;
  if (tools) parts.push(`${tools} tool call${tools > 1 ? "s" : ""}`);
  if (run.stats?.claims) parts.push(`${run.stats.supported}/${run.stats.claims} claims verified`);
  const s = parts.join(", ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Answered directly";
}

function WorkRow({ run, onOpenTrace }: { run: RunState; onOpenTrace?: () => void }) {
  const [open, setOpen] = useState(false);
  const steps = Object.values(run.steps);
  const agents = Array.from(new Set(steps.map((s) => s.agent)));
  const live = !run.done;
  const hasDetail = steps.length > 0 || run.iterations.length > 0;

  return (
    <div className="mb-3">
      <button
        type="button" onClick={() => hasDetail && setOpen((o) => !o)}
        className={cn("group inline-flex max-w-full items-center gap-2 rounded-lg py-1 pr-2 text-[13.5px] text-muted transition-colors", hasDetail && "hover:text-ink")}
      >
        <span className="flex -space-x-1">
          {(agents.length ? agents : ["aggregator"]).slice(0, 3).map((a) => {
            const Icon = AGENT_ICON[a] ?? Wrench;
            return (
              <span key={a} className="grid size-5 place-items-center rounded-full border border-line bg-canvas">
                <Icon className={cn("size-3", live && "animate-pulse")} />
              </span>
            );
          })}
        </span>
        <span className={cn("truncate", live && "text-shimmer")}>{workSummary(run)}</span>
        {hasDetail && <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="ml-2.5 mt-1 border-l border-line pl-4">
              <ol className="space-y-2 py-1">
                {steps.map((s) => {
                  const Icon = STEP_ICON[s.status];
                  return (
                    <li key={s.task_id} className="flex gap-2 text-[13px]">
                      <Icon className={cn("mt-0.5 size-3.5 shrink-0 text-muted", s.status === "running" && "animate-spin",
                        s.status === "failed" && "text-danger")} />
                      <div className="min-w-0">
                        <p className="text-ink/90">{s.description}</p>
                        {(s.result_summary || s.error) && <p className={cn("text-[12.5px]", s.error ? "text-danger" : "text-muted")}>{s.error ?? s.result_summary}</p>}
                      </div>
                    </li>
                  );
                })}
                {run.iterations.map((it) => (
                  <li key={it.iteration} className="flex gap-2 text-[13px] text-muted">
                    <RotateCcw className="mt-0.5 size-3.5 shrink-0" /> Searched again for “{it.query}”
                  </li>
                ))}
              </ol>
              {onOpenTrace && (
                <button type="button" onClick={onOpenTrace} className="mb-1 text-[12.5px] text-muted underline underline-offset-2 hover:text-ink">
                  Open full trace
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function fileBase(s?: string) {
  const b = (s ?? "answer").replace(/[^A-Za-z0-9 _-]+/g, "").trim().slice(0, 60).replace(/\s+/g, "-");
  return b || "answer";
}

/** Download menu for a whole answer: PDF (server-rendered) or Markdown. */
function DownloadMenu({ msg, question, modelLabel }: { msg: ChatMessage; question?: string; modelLabel?: string }) {
  const { toast } = useUI();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const citations = msg.run?.citations ?? [];
  const title = question ? (question.length > 90 ? question.slice(0, 87) + "…" : question) : "Answer";

  const pdf = async () => {
    setOpen(false);
    setBusy(true);
    try {
      const blob = await api.blob("/api/export/pdf", {
        title, question, markdown: msg.content, model: modelLabel,
        citations: citations.map((c) => ({ index: c.index, title: c.title, source: c.source, locator: c.locator ?? null })),
      });
      saveFile(`${fileBase(question)}.pdf`, blob);
      toast("PDF downloaded");
    } catch (e: any) {
      toast("Couldn't create the PDF", {
        tone: "danger",
        description: e?.status === 404 ? "Restart the backend to enable PDF export." : e?.message,
      });
    } finally { setBusy(false); }
  };

  const markdown = () => {
    setOpen(false);
    const src = citations.length
      ? "\n\n---\n**Sources**\n\n" + citations.map((c) => `${c.index}. ${c.title}${c.source ? ` — ${c.source}` : ""}${c.locator ? ` (${c.locator})` : ""}`).join("\n")
      : "";
    saveFile(`${fileBase(question)}.md`, `${question ? `# ${question}\n\n` : ""}${msg.content}${src}\n`, "text/markdown;charset=utf-8");
  };

  return (
    <div ref={ref} className="relative">
      <Tooltip label="Download answer" disabled={open}>
        <Button size="icon-sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-label="Download answer" aria-haspopup="menu" aria-expanded={open} loading={busy}>
          {!busy && <Download />}
        </Button>
      </Tooltip>
      <Popover open={open} align="left" placement="top" className="w-[210px]">
        <button type="button" onClick={pdf} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] hover:bg-ink/[0.05]">
          <FileDown className="size-4 text-muted" />
          <span><span className="block font-medium">PDF document</span><span className="block text-[11.5px] text-muted">Includes sources</span></span>
        </button>
        <button type="button" onClick={markdown} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] hover:bg-ink/[0.05]">
          <FileText className="size-4 text-muted" />
          <span><span className="block font-medium">Markdown</span><span className="block text-[11.5px] text-muted">.md file</span></span>
        </button>
      </Popover>
    </div>
  );
}

export function MessageView({ msg, onCite, onApproval, onClearProposal, onPreviewDoc, onRetry, onShowTrace, onShowSources, modelLabel, isLast, question }: {
  msg: ChatMessage;
  active?: boolean;
  onCite: (n: number) => void;
  onApproval: (id: string, a: any) => void;
  onClearProposal: () => void;
  onPreviewDoc?: (docId: string, fileName: string, kbId?: string) => void;
  onRetry?: () => void;
  onShowTrace?: () => void;
  onShowSources?: () => void;
  modelLabel?: string;
  isLast?: boolean;
  /** The user message this answers — used as the title of downloads. */
  question?: string;
}) {
  const { toast } = useUI();
  const [copied, setCopied] = useState(false);

  if (msg.role === "user") {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
                  className="flex flex-col items-end gap-2">
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {msg.attachments.map((att, i) => (
              <AttachmentChip key={i} att={att} onPreview={att.doc_id ? () => onPreviewDoc?.(att.doc_id!, att.file_name, att.kb_id) : undefined} />
            ))}
          </div>
        )}
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-bubble px-4 py-2.5 text-[15.5px] leading-relaxed">
          {msg.content}
        </div>
      </motion.div>
    );
  }

  const run = msg.run;
  const streaming = !!run && !run.done;
  const invalid = new Set(run?.stats?.invalid_citations ?? []);
  const validCites = new Set(run?.citations.map((c) => c.index) ?? []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { toast("Couldn't copy", { tone: "danger" }); }
  };

  return (
    <motion.article initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="group/msg">
      {run && <WorkRow run={run} onOpenTrace={onShowTrace} />}

      {streaming && !msg.content && (
        <div className="flex items-center gap-1.5 py-2" aria-label="Thinking">
          {[0, 1, 2].map((i) => (
            <motion.span key={i} className="size-2 rounded-full bg-ink/70"
                         animate={{ opacity: [0.25, 1, 0.25], scale: [0.85, 1, 0.85] }}
                         transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }} />
          ))}
        </div>
      )}

      {msg.content && (
        <div className={cn("prose-answer", streaming && "caret-last")}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={{
              pre: ({ node }) => {
                const codeEl: any = (node as any)?.children?.find((c: any) => c.type === "element" && c.tagName === "code");
                const cls: string[] = codeEl?.properties?.className ?? [];
                const lang = (cls.find((c) => String(c).startsWith("language-")) ?? "").toString().replace("language-", "").toLowerCase();
                return <CodeBlock code={hastText(codeEl ?? node)} lang={lang} />;
              },
              table: ({ node, children }) => <TableBlock node={node}>{children}</TableBlock>,
              a: ({ href, children }) => {
                const m = href?.match(/^#cite-(\d+)$/);
                if (m) {
                  const n = Number(m[1]);
                  const bad = invalid.has(n) || (run?.done && !validCites.has(n));
                  const cite = run?.citations.find((c) => c.index === n);
                  return (
                    <Tooltip label={bad ? "No matching source" : (cite?.title ?? `Source ${n}`)} side="top">
                      <button
                        onClick={() => onCite(n)}
                        className={cn("mx-0.5 inline-grid h-[18px] min-w-[18px] -translate-y-[2px] place-items-center rounded-[5px] px-1 align-middle font-sans text-[10.5px] font-semibold transition-colors",
                          bad ? "bg-danger/10 text-danger line-through" : "bg-ink/[0.08] text-ink/80 hover:bg-ink hover:text-canvas")}
                      >
                        {n}
                      </button>
                    </Tooltip>
                  );
                }
                return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
              },
            }}
          >
            {withCitationLinks(msg.content)}
          </ReactMarkdown>
        </div>
      )}

      {run?.approvals.map((a) => (
        <div key={a.approval_id} className="mt-4">
          <ApprovalCard approval={a} onResolved={(r) => onApproval(a.approval_id, r)} />
        </div>
      ))}

      {run?.memoryProposal && (
        <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                    className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-3 text-sm">
          <BookmarkPlus className="size-4 text-muted" />
          <span className="min-w-0 flex-1">Remember: “{run.memoryProposal.content}”</span>
          <Button size="sm" variant="primary" onClick={async () => {
            await api.patch(`/api/memory/${run.memoryProposal!.id}`, { status: "active" });
            onClearProposal();
            toast("Saved to memory");
          }}><Check /> Save</Button>
          <Button size="sm" variant="ghost" onClick={async () => {
            await api.del(`/api/memory/${run.memoryProposal!.id}`);
            onClearProposal();
          }}><X /> Dismiss</Button>
        </motion.div>
      )}

      {run?.error && (
        <p className="mt-3 flex items-center gap-2 rounded-xl border border-danger/30 px-3 py-2 text-sm text-danger">
          <AlertTriangle className="size-4 shrink-0" />{run.error}
        </p>
      )}

      {run?.done && (
        <div className={cn("mt-3 flex flex-wrap items-center gap-0.5 text-muted transition-opacity",
          isLast ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100")}>
          {msg.content && (
            <Tooltip label={copied ? "Copied" : "Copy"}>
              <Button size="icon-sm" variant="ghost" onClick={copy} aria-label="Copy">{copied ? <Check /> : <Copy />}</Button>
            </Tooltip>
          )}
          {msg.content && <DownloadMenu msg={msg} question={question} modelLabel={modelLabel} />}
          {onRetry && (
            <Tooltip label="Retry">
              <Button size="icon-sm" variant="ghost" onClick={onRetry} aria-label="Retry"><RotateCcw /></Button>
            </Tooltip>
          )}
          {run.citations.length > 0 && onShowSources && (
            <button onClick={onShowSources} className="ml-1 flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] hover:bg-ink/[0.06] hover:text-ink">
              <Layers className="size-3.5" /> {run.citations.length} source{run.citations.length > 1 ? "s" : ""}
            </button>
          )}
          <span className="ml-auto flex items-center gap-3 pr-1 text-[12px]">
            {run.stats && run.stats.claims > 0 && <span title="Claims supported by a cited source">{pct(run.stats.supported_ratio)} grounded</span>}
            {run.elapsedMs != null && <span>{ms(run.elapsedMs)}</span>}
            {modelLabel && <span className="hidden sm:inline">{modelLabel}</span>}
          </span>
        </div>
      )}
    </motion.article>
  );
}
