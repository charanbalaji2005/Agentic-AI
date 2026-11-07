"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Check, Cloud, Database, Globe, Hourglass, Sparkles, Wrench, X } from "lucide-react";
import { agentColor, cn } from "@/lib/utils";
import type { AgentInfo, RunState } from "@/types";

const ICON: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  aggregator: Sparkles, local_rag: Database, web_research: Globe, cloud: Cloud,
};

type NodeState = "idle" | "active" | "done" | "failed" | "waiting";

function nodeState(run: RunState | undefined, agent: string): NodeState {
  if (!run) return "idle";
  const steps = Object.values(run.steps).filter((s) => s.agent === agent);
  if (agent === "aggregator") {
    const st = run.agents.aggregator?.status;
    if (run.error) return "failed";
    if (run.done) return "done";
    return st ? "active" : "idle";
  }
  if (!steps.length) return "idle";
  if (steps.some((s) => s.status === "running")) return "active";
  if (steps.some((s) => s.status === "awaiting_approval")) return "waiting";
  if (steps.every((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "completed")) return "done";
  return "active";
}

const MARK = {
  done: { Icon: Check, cls: "bg-ok" },
  failed: { Icon: X, cls: "bg-danger" },
  waiting: { Icon: Hourglass, cls: "bg-warn" },
} as const;

function Node({ agent, label, color, state, detail, size = "md", preview }: {
  agent: string; label: string; color?: string; state: NodeState; detail?: string; size?: "md" | "lg"; preview?: boolean;
}) {
  const Icon = ICON[agent] ?? Wrench;
  const lit = state !== "idle" || preview;
  const c = (a: number) => agentColor(agent, a, color);
  const mark = MARK[state as keyof typeof MARK];
  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5 text-center">
      <motion.div className="relative" whileHover={{ y: -2, scale: 1.04 }} transition={{ type: "spring", stiffness: 400, damping: 20 }}>
        {state === "active" && (
          <>
            <span aria-hidden className="absolute inset-0 animate-pulse-ring rounded-node" style={{ background: c(0.35) }} />
            <span aria-hidden className="absolute -inset-3 rounded-full blur-xl" style={{ background: c(0.35) }} />
          </>
        )}
        <div
          className={cn(
            "relative grid place-items-center rounded-node border transition-all duration-500",
            size === "lg" ? "size-14" : "size-12",
            state === "active" && "beam",
            !lit && "border-dashed border-line bg-surface/60",
          )}
          style={lit ? {
            borderColor: c(state === "idle" ? 0.35 : 0.7),
            background: `linear-gradient(145deg, ${c(0.22)}, ${c(0.06)})`,
            boxShadow: state === "idle" ? undefined : `0 8px 24px -10px ${c(0.7)}, inset 0 1px 0 rgb(255 255 255 / 0.08)`,
          } : undefined}
        >
          <Icon className={cn(size === "lg" ? "size-6" : "size-5", !lit && "text-muted")} style={lit ? { color: c(1) } : undefined} />
          <AnimatePresence>
            {mark && (
              <motion.span
                key={state}
                initial={{ scale: 0, rotate: -45 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 18 }}
                className={cn("absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full ring-2 ring-surface", mark.cls)}
              >
                <mark.Icon className="size-3 text-white" />
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
      <span className={cn("text-[12.5px] font-semibold leading-tight", !lit && "text-muted")}>{label}</span>
      <AnimatePresence mode="wait">
        {detail && (
          <motion.span key={detail} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                       className={cn("line-clamp-2 max-w-[130px] text-[11px] leading-snug", state === "active" ? "text-shimmer" : "text-muted")}>
            {detail}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

export function RouteMap({ run, agents, preview }: { run?: RunState; agents: AgentInfo[]; preview?: boolean }) {
  const workers = agents.filter((a) => a.name !== "aggregator" &&
    (a.available || (run && Object.values(run.steps).some((s) => s.agent === a.name))));
  const toolsByAgent: Record<string, { tool: string; ok?: boolean; pending?: boolean }[]> = {};
  for (const t of run?.tools ?? []) {
    if (t.event !== "tool_result" && !(t.event === "tool_call" && !run?.tools.some((x) => x.event === "tool_result" && x.tool === t.tool))) continue;
    const list = (toolsByAgent[t.agent] ??= []);
    const server = t.tool.split(".")[0];
    const existing = list.find((x) => x.tool === server);
    const pending = !!t.approval_id;
    if (existing) existing.ok = existing.ok || t.ok;
    else list.push({ tool: server, ok: t.ok, pending });
  }
  const agg = run?.agents.aggregator;
  const live = !!run && !run.done;

  return (
    <div className="select-none" aria-label="Agent route">
      <div className="flex justify-center">
        <Node agent="aggregator" label="Aggregator" state={nodeState(run, "aggregator")} size="lg" preview={preview}
              detail={run && !run.done ? agg?.detail : run?.plan?.rationale} />
      </div>
      {workers.length > 0 && (
        <>
          <div className={cn("flow-y mx-auto h-6 w-0.5 rounded-full", live && "is-live")} />
          <div className="relative">
            <div className={cn("flow-x absolute top-0 h-0.5 rounded-full", live && "is-live")}
                 style={{ left: `calc(50% / ${workers.length})`, right: `calc(50% / ${workers.length})` }} />
            <div className="grid" style={{ gridTemplateColumns: `repeat(${workers.length}, minmax(0, 1fr))` }}>
              {workers.map((a, i) => {
                const st = nodeState(run, a.name);
                const step = run && Object.values(run.steps).find((s) => s.agent === a.name);
                const tools = toolsByAgent[a.name] ?? [];
                return (
                  <motion.div key={a.name} className="flex flex-col items-center"
                              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 * i }}>
                    <div className={cn("flow-y h-6 w-0.5 rounded-full", st === "active" && "is-live")}
                         style={st !== "idle" && st !== "active" ? { background: agentColor(a.name, 0.6, a.color) } : undefined} />
                    <Node agent={a.name} label={a.display_name} color={a.color} state={st} preview={preview}
                          detail={st === "idle" ? (a.available ? undefined : "Not connected") : (run?.agents[a.name]?.detail ?? step?.description)} />
                    {tools.length > 0 && (
                      <div className="mt-2 flex flex-col items-center gap-1">
                        <div className="h-3 w-0.5 rounded-full bg-mcp/70" />
                        {tools.map((t) => (
                          <motion.span key={t.tool} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
                                       className={cn("rounded-md border px-1.5 py-0.5 font-mono text-[10.5px]",
                                         t.pending ? "border-warn/50 bg-warn/10 text-warn" : t.ok ? "border-mcp/50 bg-mcp/10" : "border-danger/50 bg-danger/10 text-danger")}>
                            {t.tool}
                          </motion.span>
                        ))}
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
