"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Check, ShieldAlert, ShieldCheck, ShieldX, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Approval } from "@/types";

export function ApprovalCard({ approval, onResolved }: { approval: Approval; onResolved: (a: Approval) => void }) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (d: "approve" | "reject") => {
    setBusy(d);
    setError(null);
    try {
      onResolved(await api.post<Approval>(`/api/approvals/${approval.approval_id}/${d}`));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  const resolved = approval.status !== "pending";
  const good = approval.status === "approved" || approval.status === "executed";
  const Icon = !resolved ? ShieldAlert : good ? ShieldCheck : ShieldX;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
      className={cn("relative overflow-hidden rounded-2xl border p-4",
        !resolved ? "beam border-warn/40 bg-warn/[0.06]" : good ? "border-ok/30 bg-ok/[0.05]" : "border-line bg-sunken/60")}
    >
      <div className="flex items-start gap-3">
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl border",
          !resolved ? "border-warn/40 bg-warn/15 text-warn" : good ? "border-ok/30 bg-ok/10 text-ok" : "border-line bg-sunken text-muted")}>
          <Icon className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">{resolved ? `Action ${approval.status}` : "Approval required"}</p>
            <Badge tone={!resolved ? "warn" : good ? "ok" : "neutral"} dot pulse={!resolved}>{approval.status}</Badge>
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            {approval.server} → <span className="font-mono text-ink">{approval.tool}</span>
            {approval.description && ` — ${approval.description}`}
          </p>
          <pre className="mt-2.5 max-h-40 overflow-auto scroll-thin rounded-xl border border-line bg-sunken/80 p-3 font-mono text-[12px] leading-5">
            {JSON.stringify(approval.arguments, null, 2)}
          </pre>
          {approval.result && (
            <pre className={cn("mt-2 max-h-40 overflow-auto scroll-thin rounded-xl border p-3 font-mono text-[12px] leading-5",
              approval.result.ok ? "border-ok/25 bg-ok/[0.05]" : "border-danger/25 bg-danger/[0.05] text-danger")}>
              {approval.result.ok ? approval.result.content : approval.result.error}
            </pre>
          )}
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
          {!resolved && (
            <div className="mt-3 flex gap-2">
              <Button variant="primary" size="sm" loading={busy === "approve"} disabled={!!busy} onClick={() => decide("approve")}>
                {busy !== "approve" && <Check />} {busy === "approve" ? "Running…" : "Approve and run"}
              </Button>
              <Button variant="secondary" size="sm" loading={busy === "reject"} disabled={!!busy} onClick={() => decide("reject")}>
                {busy !== "reject" && <X />} Reject
              </Button>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
