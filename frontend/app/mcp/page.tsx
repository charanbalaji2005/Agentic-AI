"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity, ChevronDown, Code2, History, Pencil, Plug, PlugZap, Plus, Search, ShieldAlert, Trash2, Unplug, Wrench,
} from "lucide-react";
import { ApprovalCard } from "@/components/chat/approval-card";
import { PageFrame, Reveal } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Empty, ErrorNote } from "@/components/ui/empty";
import { Input, Textarea } from "@/components/ui/input";
import { AnimatedNumber, Tooltip, stagger } from "@/components/ui/primitives";
import { useUI } from "@/components/ui-provider";
import { api } from "@/lib/api";
import { cn, ms, timeAgo } from "@/lib/utils";
import type { Approval, McpServer } from "@/types";

const STATUS_TONE = { connected: "ok", connecting: "info", disconnected: "neutral", error: "danger" } as const;
const TEMPLATE = `{
  "name": "github",
  "category": "github",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "\${GITHUB_TOKEN}" },
  "enabled": true,
  "permissions": { "allow": ["*"], "deny": [], "approval_required": ["create_*", "push_*", "merge_*"] }
}`;

function jsonError(text: string) {
  try { JSON.parse(text); return null; } catch (e: any) { return e.message as string; }
}

export default function McpPage() {
  const { toast, confirm } = useUI();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [toolQ, setToolQ] = useState("");
  const [editor, setEditor] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<McpServer[]>("/api/mcp/servers").then(setServers).catch((e) => setError(e.message));
    api.get<Approval[]>("/api/approvals").then(setApprovals).catch(() => {});
    api.get<any[]>("/api/mcp/logs?limit=60").then(setLogs).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const act = async (name: string, action: "connect" | "disconnect" | "health") => {
    setBusy(name + action);
    setError(null);
    try {
      const r = await api.post<any>(`/api/mcp/servers/${name}/${action}`);
      if (action === "health") setHealth((h) => ({ ...h, [name]: r.healthy ? { ok: true, text: `Responding in ${r.latency_ms} ms` } : { ok: false, text: `Not responding: ${r.error ?? r.status}` } }));
      else toast(action === "connect" ? `Connected to ${name}` : `Disconnected ${name}`, { tone: action === "connect" ? "ok" : "info" });
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const save = async () => {
    setError(null);
    try {
      const cfg = JSON.parse(editor!);
      setBusy("save");
      await api.post("/api/mcp/servers", cfg);
      setEditor(null);
      toast(`Saved ${cfg.name ?? "server"}`);
      load();
    } catch (e: any) { setError(e instanceof SyntaxError ? `The configuration is not valid JSON: ${e.message}` : e.message); } finally { setBusy(null); }
  };

  const connected = servers.filter((s) => s.status === "connected").length;
  const toolCount = servers.reduce((n, s) => n + s.tools.length, 0);
  const editorErr = editor !== null ? jsonError(editor) : null;

  return (
    <PageFrame
      eyebrow="Integrations" icon={<PlugZap />} title="Tools"
      description="MCP servers give agents their tools: local files, web search, cloud accounts and anything else you connect. Risky actions wait for your approval."
      actions={<Button variant="primary" onClick={() => setEditor(TEMPLATE)}><Plus /> Add server</Button>}
    >
      <ErrorNote message={error} onDismiss={() => setError(null)} />

      <Reveal>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { label: "Servers", value: servers.length, icon: PlugZap },
            { label: "Connected", value: connected, icon: Plug },
            { label: "Tools available", value: toolCount, icon: Wrench },
            { label: "Pending approvals", value: approvals.length, icon: ShieldAlert },
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

      <AnimatePresence>
        {approvals.length > 0 && (
          <motion.section initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="space-y-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldAlert className="size-5 text-warn" /> Waiting for approval</h2>
            {approvals.map((a) => <ApprovalCard key={a.approval_id} approval={a} onResolved={() => load()} />)}
          </motion.section>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {editor !== null && (
          <motion.div initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }}>
            <Card spotlight={false} className="beam">
              <CardHeader icon={<Code2 />} title="Server configuration" description="Use ${VAR} to read secrets from the backend environment, so keys never live in this file."
                          action={editorErr ? <Badge tone="danger" dot>invalid JSON</Badge> : <Badge tone="ok" dot>valid JSON</Badge>} />
              <CardBody className="space-y-3">
                <Textarea value={editor} onChange={(e) => setEditor(e.target.value)} rows={14} className="font-mono text-[12.5px] leading-6" spellCheck={false} />
                {editorErr && <p className="font-mono text-[12px] text-danger">{editorErr}</p>}
                <div className="flex gap-2">
                  <Button variant="primary" onClick={save} loading={busy === "save"} disabled={!!editorErr}>{busy === "save" ? "Connecting…" : "Save and connect"}</Button>
                  <Button variant="ghost" onClick={() => setEditor(null)}>Cancel</Button>
                </div>
              </CardBody>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      <Reveal>
        <motion.div className="space-y-3" variants={stagger.container} initial="hidden" animate="show">
          {servers.length === 0 && <Empty title="No MCP servers configured" icon={<PlugZap />}>Add one above, or edit backend/mcp_servers.json.</Empty>}
          {servers.map((s) => {
            const on = s.status === "connected";
            const isOpen = open === s.name;
            const tools = s.tools.filter((t) => !toolQ || `${t.name} ${t.description}`.toLowerCase().includes(toolQ.toLowerCase()));
            return (
              <motion.div key={s.name} variants={stagger.item}>
                <Card className={cn(on && "border-mcp/30")}>
                  <div className="flex flex-wrap items-center gap-4 px-5 py-4">
                    <span className="relative">
                      {on && <span className="absolute -inset-1 rounded-2xl bg-mcp/30 blur-md" />}
                      <span className={cn("relative grid size-11 place-items-center rounded-2xl border",
                        on ? "border-mcp/50 bg-gradient-to-br from-mcp/30 to-mcp/5 text-mcp" : "border-dashed border-line text-muted")}>
                        <PlugZap className="size-5" />
                      </span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold">{s.name}</h3>
                        <Badge tone={STATUS_TONE[s.status]} dot pulse={s.status === "connecting" || on}>{s.status}</Badge>
                        <Badge>{s.category}</Badge>
                        <Badge>{s.transport}</Badge>
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[12px] text-muted">{s.description || (s.transport === "stdio" ? `${s.command} ${s.args.join(" ")}` : s.url)}</p>
                      {s.error && <p className="mt-1 text-sm text-danger">{s.error}</p>}
                      <AnimatePresence>
                        {health[s.name] && (
                          <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className={cn("mt-1 flex items-center gap-1.5 text-[12.5px]", health[s.name].ok ? "text-ok" : "text-danger")}>
                            <Activity className="size-3.5" /> {health[s.name].text}
                          </motion.p>
                        )}
                      </AnimatePresence>
                    </div>
                    <div className="flex items-center gap-1">
                      {on ? (
                        <>
                          <Button size="sm" variant="ghost" loading={busy === s.name + "health"} onClick={() => act(s.name, "health")}><Activity /> Ping</Button>
                          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => act(s.name, "disconnect")}><Unplug /> Disconnect</Button>
                        </>
                      ) : (
                        <Button size="sm" variant="primary" loading={busy === s.name + "connect"} disabled={!!busy} onClick={() => act(s.name, "connect")}>
                          {busy !== s.name + "connect" && <Plug />} {busy === s.name + "connect" ? "Connecting…" : "Connect"}
                        </Button>
                      )}
                      <Tooltip label="Edit config">
                        <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => setEditor(JSON.stringify({ ...s, tools: undefined, status: undefined, error: undefined, env_keys: undefined, env: Object.fromEntries(s.env_keys.map((k) => [k, `\${${k}}`])) }, null, 2))}><Pencil /></Button>
                      </Tooltip>
                      <Tooltip label="Remove">
                        <Button size="icon-sm" variant="ghost" className="hover:text-danger" aria-label={`Remove ${s.name}`}
                                onClick={async () => { if (await confirm({ title: `Remove ${s.name}?`, description: "Agents will lose access to its tools.", confirmLabel: "Remove", danger: true })) { await api.del(`/api/mcp/servers/${s.name}`); toast(`Removed ${s.name}`); load(); } }}><Trash2 /></Button>
                      </Tooltip>
                    </div>
                  </div>
                  {s.tools.length > 0 && (
                    <div className="border-t border-line/70">
                      <button onClick={() => { setOpen(isOpen ? null : s.name); setToolQ(""); }} className="flex w-full items-center gap-2 px-5 py-2.5 text-sm font-medium text-muted transition-colors hover:text-ink">
                        <ChevronDown className={cn("size-4 transition-transform duration-300", isOpen && "rotate-180")} />
                        <Wrench className="size-3.5" /> {s.tools.length} tools
                      </button>
                      <AnimatePresence initial={false}>
                        {isOpen && (
                          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }} className="overflow-hidden">
                            {s.tools.length > 5 && (
                              <div className="px-5 pb-2"><Input icon={<Search />} value={toolQ} onChange={(e) => setToolQ(e.target.value)} placeholder="Filter tools" /></div>
                            )}
                            <ul className="grid gap-px border-t border-line/70 bg-line/50 md:grid-cols-2">
                              {tools.map((t) => (
                                <li key={t.name} className="bg-surface/90 px-5 py-3 text-[13px]">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-mono font-medium">{t.name}</span>
                                    {t.read_only && <Badge tone="ok">read-only</Badge>}
                                    {t.destructive && <Badge tone="danger">destructive</Badge>}
                                  </div>
                                  <p className="mt-1 line-clamp-3 text-muted">{t.description}</p>
                                  <details className="group/d mt-1.5">
                                    <summary className="cursor-pointer text-[12px] text-accent">Input schema</summary>
                                    <pre className="mt-1.5 max-h-56 overflow-auto scroll-thin rounded-lg border border-line bg-sunken p-2.5 font-mono text-[11.5px]">{JSON.stringify(t.input_schema, null, 2)}</pre>
                                  </details>
                                </li>
                              ))}
                            </ul>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </Card>
              </motion.div>
            );
          })}
        </motion.div>
      </Reveal>

      <Reveal>
        <Card>
          <CardHeader icon={<History />} title="Recent tool calls" description="Every call is logged with its arguments (secrets redacted), who ran it and the outcome." />
          {logs.length === 0 ? <CardBody><p className="text-sm text-muted">No tool calls yet.</p></CardBody> : (
            <div className="max-h-[420px] overflow-auto scroll-thin">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-surface/95 text-left text-[12px] uppercase tracking-wider text-muted backdrop-blur">
                  <tr className="border-b border-line/70">{["When", "Tool", "Agent", "Result", "Time"].map((h) => <th key={h} className="px-5 py-2.5 font-medium">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id} className="border-b border-line/50 transition-colors last:border-0 hover:bg-accent/[0.04]">
                      <td className="whitespace-nowrap px-5 py-2.5 text-muted">{timeAgo(l.ts)}</td>
                      <td className="px-5 font-mono text-[12.5px]">{l.server}.{l.tool}</td>
                      <td className="px-5">{l.actor}</td>
                      <td className="px-5"><Badge dot tone={l.status === "ok" ? "ok" : l.status === "awaiting_approval" ? "warn" : l.status === "rejected" ? "neutral" : "danger"}>{l.status.replace("_", " ")}</Badge></td>
                      <td className="px-5 tabular-nums text-muted">{ms(l.duration_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Reveal>
    </PageFrame>
  );
}
