"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, Cloud, Code2, FileSearch, GitCompare, Newspaper, PanelRight, UploadCloud } from "lucide-react";
import { Mark } from "@/components/app-shell";
import { Composer, useModelChoice } from "@/components/chat/composer";
import { MessageView } from "@/components/chat/message";
import { TracePanel } from "@/components/chat/trace-panel";
import { DocumentPreviewModal } from "@/components/document-preview-modal";
import { Tooltip } from "@/components/ui/primitives";
import { useUI } from "@/components/ui-provider";
import { useAgenticChat } from "@/hooks/use-agentic-chat";
import { api } from "@/lib/api";
import { chatStore, subscribe } from "@/lib/bus";
import { cn } from "@/lib/utils";
import type { AgentInfo, DocAttachment, KnowledgeBase } from "@/types";

const SUGGESTIONS = [
  { icon: Code2, label: "Solve a DSA problem", prompt: "Implement an LRU cache in Python with O(1) get and put, and explain the time and space complexity" },
  { icon: FileSearch, label: "Summarize my docs", prompt: "Summarize the key decisions in my uploaded documents" },
  { icon: GitCompare, label: "Compare with the web", prompt: "Compare what my docs say about deployment with current AWS guidance" },
  { icon: Cloud, label: "Check my cloud", prompt: "Which Azure resources are in my subscription, and are any stopped?" },
  { icon: Newspaper, label: "Release notes", prompt: "What changed in the latest release notes, and what should I watch out for?" },
];

const ACCEPT = ".pdf,.docx,.txt,.md,.markdown,.html,.htm,.csv,.json,.py,.js,.ts,.tsx,.jsx,.java,.go,.rs,.c,.cpp,.cs,.rb,.php,.sql,.sh,.yaml,.yml,.toml,.tf";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Burning the midnight oil?" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

type Convo = { id: string; title: string; updated_at: string };

export default function ChatPage() {
  const chat = useAgenticChat();
  const { toast } = useUI();
  const models = useModelChoice();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<DocAttachment[]>([]);
  const [previewDoc, setPreviewDoc] = useState<{ kbId: string; docId: string; fileName?: string } | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [kbIds, setKbIds] = useState<string[]>(["default"]);
  const [titles, setTitles] = useState<Convo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusCite, setFocusCite] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modelState, setModelState] = useState<string>("ready");
  const [traceOpen, setTraceOpen] = useState(false);
  const [isLg, setIsLg] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [hello, setHello] = useState("Hello");
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => setHello(greeting()), []);

  const refresh = useCallback(() => {
    api.get<AgentInfo[]>("/api/agents").then((a) => { setAgents(a); setNotice(null); })
      .catch(() => setNotice("Can't reach the backend. Start it with `uvicorn app.main:app` and reload."));
    api.get<KnowledgeBase[]>("/api/kb").then(setKbs).catch(() => {});
    api.get<Convo[]>("/api/conversations").then(setTitles).catch(() => {});
    api.get<any>("/api/models").then((m) => setModelState(m.generator.state)).catch(() => {});
  }, []);

  // Runs on mount (busy=false) and whenever a run finishes; also tells the sidebar to refresh Recents.
  useEffect(() => {
    if (chat.busy) return;
    refresh();
    chatStore.bumpHistory();
  }, [chat.busy, refresh]);

  useEffect(() => { chatStore.setActive(chat.conversationId); }, [chat.conversationId]);
  useEffect(() => () => chatStore.setActive(null), []);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setIsLg(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const newChat = useCallback(() => {
    chat.load(null); setSelected(null); setTraceOpen(false); setInput("");
    setTimeout(() => taRef.current?.focus(), 50);
  }, [chat]);

  useEffect(() => subscribe((cmd) => {
    if (cmd.type === "new-chat") newChat();
    else if (cmd.type === "open-conversation") { chat.load(cmd.id); setSelected(null); setAtBottom(true); }
    else if (cmd.type === "prefill") { setInput(cmd.text); setTimeout(() => taRef.current?.focus(), 50); }
    else if (cmd.type === "toggle-trace") setTraceOpen((o) => !o);
  }), [chat, newChat]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable;
      if (e.key === "/" && !typing) { e.preventDefault(); taRef.current?.focus(); }
      if (e.key === "Escape" && chat.busy) chat.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chat]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom && chat.messages.length > 0) el.scrollTo({ top: el.scrollHeight, behavior: chat.busy ? "auto" : "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const assistantMsgs = chat.messages.filter((m) => m.role === "assistant");
  const activeMsg = assistantMsgs.find((m) => m.id === selected) ?? assistantMsgs[assistantMsgs.length - 1];
  const title = titles.find((h) => h.id === chat.conversationId)?.title;
  const uploading = attachments.some((a) => a.status === "uploading");
  const canSend = !!input.trim() && modelState === "ready" && !uploading && !chat.busy;
  const empty = chat.messages.length === 0;
  const labelOf = (id?: string) => (id ? models.options?.items.find((m) => m.id === id)?.label ?? id.split("/").pop() : undefined);

  const send = (text: string) => {
    const docIds = attachments.filter((a) => a.status === "ready" && a.doc_id).map((a) => a.doc_id!);
    const current = [...attachments];
    setAttachments([]);
    setSelected(null);
    setAtBottom(true);
    chat.send(text, kbIds, docIds.length ? docIds : undefined, current.length ? current : undefined, models.requestModel);
  };

  const submit = () => {
    const text = input.trim();
    if (!text || !canSend) return;
    setInput("");
    send(text);
  };

  const upload = async (files: FileList | File[] | null) => {
    if (!files || !files.length) return;
    const kb = kbIds[0] ?? "default";
    const list = Array.from(files);
    const initial: DocAttachment[] = list.map((f) => ({ file_name: f.name, size: f.size, status: "uploading", kb_id: kb }));
    setAttachments((prev) => [...prev, ...initial]);
    try {
      const results = await api.uploadSync<Array<{ file_name: string; doc_id?: string; chunks?: number; error?: string }>>(kb, list);
      setAttachments((prev) => prev.map((att) => {
        const r = results.find((x) => x.file_name === att.file_name);
        return r ? { ...att, doc_id: r.doc_id, chunks: r.chunks ?? 0, status: r.error ? "error" : "ready", error: r.error } : att;
      }));
      refresh();
    } catch (e: any) {
      toast("Upload failed", { description: e.message, tone: "danger" });
      setAttachments((prev) => prev.map((att) => initial.some((i) => i.file_name === att.file_name) ? { ...att, status: "error", error: e.message } : att));
    }
  };

  const openTrace = (msgId?: string) => { if (msgId) setSelected(msgId); setTraceOpen(true); };

  const composer = (placement: "top" | "bottom") => (
    <Composer
      taRef={taRef} value={input} onChange={setInput} onSubmit={submit} onStop={chat.stop} busy={chat.busy} canSend={canSend}
      attachments={attachments} onRemoveAttachment={(n) => setAttachments((p) => p.filter((a) => a.file_name !== n))}
      onPreviewAttachment={(a) => a.doc_id && setPreviewDoc({ kbId: a.kb_id ?? "default", docId: a.doc_id, fileName: a.file_name })}
      onPickFiles={() => fileRef.current?.click()} kbs={kbs} kbIds={kbIds} onKbChange={setKbIds}
      models={models.options} model={models.model} onModelChange={models.choose}
      placeholder={empty ? "How can I help you today?" : "Reply…"} popoverPlacement={placement}
    />
  );

  const banner = (notice || modelState !== "ready") && (
    <p className="mb-2 flex items-start justify-between gap-3 rounded-xl border border-line bg-sunken px-3 py-2 text-[13px] text-muted">
      <span>{modelState !== "ready" ? `The language model is ${modelState}. You can type now; sending works once it's ready.` : notice}</span>
      {notice && <button onClick={() => setNotice(null)} className="shrink-0 font-medium text-ink underline">Dismiss</button>}
    </p>
  );

  const trace = <TracePanel run={activeMsg?.run} agents={agents} focusCite={focusCite} onClose={() => setTraceOpen(false)} />;

  return (
    <div className="flex h-full">
      <section
        className="relative flex min-w-0 flex-1 flex-col" aria-label="Chat"
        onDragEnter={(e) => { if (e.dataTransfer.types.includes("Files")) { dragDepth.current++; setDragging(true); } }}
        onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); dragDepth.current = 0; setDragging(false); upload(e.dataTransfer.files); }}
        onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); upload(e.clipboardData.files); } }}
      >
        <input ref={fileRef} type="file" multiple hidden accept={ACCEPT} onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />

        {/* Header */}
        <header className="flex h-12 shrink-0 items-center gap-2 pl-12 pr-3 md:pl-4">
          {!empty && (
            <motion.h1 key={title ?? "chat"} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                       className="min-w-0 truncate text-[14px] font-medium text-ink/90">
              {title ?? "New chat"}
            </motion.h1>
          )}
          <div className="ml-auto">
            {!empty && (
              <Tooltip label={traceOpen ? "Hide trace" : "Show trace"} side="bottom">
                <button onClick={() => setTraceOpen((o) => !o)} aria-label="Toggle trace"
                        className={cn("grid size-8 place-items-center rounded-lg text-muted hover:bg-ink/[0.06] hover:text-ink", traceOpen && "bg-ink/[0.06] text-ink")}>
                  <PanelRight className="size-[18px]" />
                </button>
              </Tooltip>
            )}
          </div>
        </header>

        {empty ? (
          /* ───── Empty state: centered greeting + composer ───── */
          <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pb-[12vh] pt-[14vh] scroll-thin">
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}
                        className="mb-8 flex items-center gap-3">
              <Mark className="size-10" />
              <h2 className="font-serif text-[34px] font-normal leading-none tracking-tight sm:text-[40px]">{hello}</h2>
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.06, ease: "easeOut" }}
                        className="w-full max-w-[680px]">
              {banner}
              {composer("bottom")}
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map(({ icon: Icon, label, prompt }, i) => (
                  <motion.button key={label} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 + i * 0.04 }}
                                 onClick={() => { setInput(prompt); taRef.current?.focus(); }}
                                 className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] text-ink/80 transition-colors hover:bg-ink/[0.04] hover:text-ink">
                    <Icon className="size-3.5 text-muted" /> {label}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          </div>
        ) : (
          /* ───── Conversation ───── */
          <>
            <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto scroll-thin">
              <div className="mx-auto max-w-[740px] space-y-8 px-4 pb-10 pt-4 sm:px-6">
                {chat.messages.map((m, i) => (
                  <MessageView
                    key={m.id}
                    msg={m}
                    isLast={i === chat.messages.length - 1}
                    question={m.role === "assistant" && chat.messages[i - 1]?.role === "user" ? chat.messages[i - 1].content : undefined}
                    modelLabel={labelOf(m.model)}
                    onCite={(n) => { setSelected(m.id); setFocusCite(null); setTimeout(() => setFocusCite(n), 0); setTraceOpen(true); }}
                    onApproval={(id, a) => chat.resolveApproval(m.id, id, a)}
                    onClearProposal={() => chat.clearProposal(m.id)}
                    onPreviewDoc={(docId, fileName, docKb) => setPreviewDoc({ kbId: docKb ?? kbIds[0] ?? "default", docId, fileName })}
                    onRetry={m.role === "assistant" && !chat.busy && chat.messages[i - 1]?.role === "user" ? () => send(chat.messages[i - 1].content) : undefined}
                    onShowTrace={() => openTrace(m.id)}
                    onShowSources={() => { setSelected(m.id); setFocusCite(null); setTimeout(() => setFocusCite(1), 0); setTraceOpen(true); }}
                  />
                ))}
              </div>
            </div>

            <AnimatePresence>
              {!atBottom && (
                <motion.button initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
                               onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })}
                               aria-label="Scroll to bottom"
                               className="absolute bottom-[136px] left-1/2 z-10 -ml-4 grid size-8 place-items-center rounded-full border border-line bg-surface text-muted shadow-float hover:text-ink">
                  <ArrowDown className="size-4" />
                </motion.button>
              )}
            </AnimatePresence>

            <div className="relative shrink-0 px-4 pb-3 sm:px-6">
              <div className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-canvas to-transparent" />
              <div className="mx-auto max-w-[740px]">
                {banner}
                {composer("top")}
                <p className="mt-2 text-center text-[11.5px] text-muted">Answers are checked against their sources, but can still be wrong. Verify important details.</p>
              </div>
            </div>
          </>
        )}

        <AnimatePresence>
          {dragging && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-canvas/85 backdrop-blur-[2px]">
              <div className="text-center">
                <UploadCloud className="mx-auto size-9" strokeWidth={1.5} />
                <p className="mt-3 font-serif text-xl">Drop files here</p>
                <p className="text-sm text-muted">They’ll be indexed and attached to your next message</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {/* Side panel (like an artifact pane) */}
      <AnimatePresence initial={false}>
        {isLg && traceOpen && !empty && (
          <motion.div key="trace" initial={{ width: 0, opacity: 0 }} animate={{ width: 440, opacity: 1 }} exit={{ width: 0, opacity: 0 }}
                      transition={{ type: "spring", stiffness: 380, damping: 40 }} className="min-h-0 shrink-0 overflow-hidden">
            <div className="h-full w-[440px]">{trace}</div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {!isLg && traceOpen && !empty && (
          <motion.div key="trace-drawer" className="fixed inset-0 z-40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-black/40" onClick={() => setTraceOpen(false)} aria-hidden />
            <motion.div initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", stiffness: 380, damping: 40 }}
                        className="absolute inset-y-0 right-0 w-[min(440px,94vw)] border-l border-line bg-canvas shadow-float">
              {trace}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {previewDoc && (
        <DocumentPreviewModal kbId={previewDoc.kbId} docId={previewDoc.docId} fileName={previewDoc.fileName} onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  );
}
