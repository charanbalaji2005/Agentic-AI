"use client";

import { useCallback, useRef, useState } from "react";
import { api, streamSSE } from "@/lib/api";
import type { ChatMessage, DocAttachment, RunState } from "@/types";

const emptyRun = (): RunState => ({
  steps: {}, agents: { aggregator: { status: "planning" } }, tools: [], evidence: [], selected: [], conflicts: [],
  citations: [], claims: [], approvals: [], iterations: [], memories: [], done: false,
});

let uid = 0;
const nextId = () => `local-${Date.now()}-${uid++}`;

export function useAgenticChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const patchRun = (id: string, fn: (r: RunState, m: ChatMessage) => Partial<RunState> | void, text?: string) =>
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m;
        const run = { ...(m.run ?? emptyRun()) };
        const delta = fn(run, m);
        return { ...m, content: text !== undefined ? m.content + text : m.content, run: { ...run, ...(delta ?? {}) } };
      }),
    );

  const send = useCallback(
    async (text: string, kbIds: string[], docIds?: string[], attachments?: DocAttachment[], model?: string) => {
      if (!text.trim() || busy) return;
      const aid = nextId();
      setMessages((prev) => [...prev, { id: nextId(), role: "user", content: text, attachments },
        { id: aid, role: "assistant", content: "", run: emptyRun(), model }]);
      setBusy(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        await streamSSE("/api/chat", { message: text, conversation_id: conversationId, kb_ids: kbIds, doc_ids: docIds, ...(model ? { model } : {}) }, (event, data) => {
          switch (event) {
            case "conversation": setConversationId(data.conversation_id); break;
            case "token": patchRun(aid, () => {}, data.text); break;
            case "plan": patchRun(aid, (r) => ({ plan: data, steps: { ...r.steps, ...Object.fromEntries(data.steps.map((s: any) => [s.task_id, r.steps[s.task_id] ?? s])) } })); break;
            case "step": patchRun(aid, (r) => ({ steps: { ...r.steps, [data.task_id]: data } })); break;
            case "agent_status": patchRun(aid, (r) => ({ agents: { ...r.agents, [data.agent]: { status: data.status, detail: data.detail } } })); break;
            case "tool_call":
            case "tool_result": patchRun(aid, (r) => ({ tools: [...r.tools, { event, ...data }] })); break;
            case "evidence": patchRun(aid, (r) => ({ evidence: [...r.evidence, ...data.items] })); break;
            case "context": patchRun(aid, () => ({ selected: data.selected, conflicts: data.conflicts })); break;
            case "iteration": patchRun(aid, (r) => ({ iterations: [...r.iterations, data] })); break;
            case "approval": patchRun(aid, (r) => ({ approvals: [...r.approvals.filter((a) => a.approval_id !== data.approval_id), data] })); break;
            case "memory": patchRun(aid, () => ({ memories: data.items })); break;
            case "memory_proposal": patchRun(aid, () => ({ memoryProposal: data })); break;
            case "validation": patchRun(aid, () => ({ claims: data.claims, stats: data.stats })); break;
            case "citations": patchRun(aid, () => ({ citations: data.items })); break;
            case "error": patchRun(aid, () => ({ error: data.message, done: true })); break;
            case "done": patchRun(aid, () => ({ done: true, elapsedMs: data.elapsed_ms })); break;
          }
        }, ctrl.signal);
      } catch (e: any) {
        if (e?.name !== "AbortError") patchRun(aid, () => ({ error: e?.message ?? "Request failed", done: true }));
        else patchRun(aid, () => ({ error: "Stopped", done: true }));
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, conversationId],
  );

  const stop = () => abortRef.current?.abort();

  const load = useCallback(async (id: string | null) => {
    setConversationId(id);
    if (!id) return setMessages([]);
    const rows = await api.get<any[]>(`/api/conversations/${id}`);
    setMessages(rows.map((r) => ({
      id: r.id, role: r.role, content: r.content,
      run: r.role === "assistant" && r.trace ? {
        ...emptyRun(), done: true, plan: r.trace.plan ?? undefined, steps: r.trace.steps ?? {},
        tools: (r.trace.tool_calls ?? []) as any, evidence: r.trace.evidence ?? [], selected: r.trace.selected ?? [],
        conflicts: r.trace.conflicts ?? [], citations: r.citations ?? [], claims: r.trace.claims ?? [],
        stats: r.trace.validation ?? undefined, iterations: r.trace.iterations ?? [], agents: {},
      } : undefined,
    })));
  }, []);

  const resolveApproval = (msgId: string, approvalId: string, approval: any) =>
    patchRun(msgId, (r) => ({ approvals: r.approvals.map((a) => (a.approval_id === approvalId ? approval : a)) }));

  const clearProposal = (msgId: string) => patchRun(msgId, () => ({ memoryProposal: undefined }));

  return { messages, busy, send, stop, load, conversationId, resolveApproval, clearProposal };
}
