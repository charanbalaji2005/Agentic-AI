import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Theme tokens for each known agent; unknown agents fall back to their configured hex color. */
const AGENT_TOKEN: Record<string, string> = {
  aggregator: "agg",
  local_rag: "local",
  web_research: "web",
  cloud: "cloud",
  mcp: "mcp",
};

/** A CSS color for an agent at the given alpha, theme-aware for known agents. */
export function agentColor(agent: string, alpha = 1, fallback?: string) {
  const token = AGENT_TOKEN[agent];
  if (token) return `rgb(var(--${token}) / ${alpha})`;
  const hex = fallback ?? "#8B5CF6";
  return alpha >= 1 ? hex : `color-mix(in srgb, ${hex} ${Math.round(alpha * 100)}%, transparent)`;
}

/** Kept for compatibility with older callers. */
export function toneFor(agent: string, color?: string) {
  return { className: "", style: { background: agentColor(agent, 1, color) } };
}

export function ms(n?: number | null) {
  if (n == null) return "–";
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
}

export function pct(n?: number | null) {
  return n == null ? "–" : `${Math.round(n * 100)}%`;
}

export function timeAgo(iso?: string) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function bytes(n?: number | null) {
  if (!n) return "–";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** Groups items into Today / Yesterday / Previous 7 days / Older by an ISO date field. */
export function groupByRecency<T>(items: T[], date: (t: T) => string | undefined) {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const day = 86400000;
  const groups: { label: string; items: T[] }[] = [
    { label: "Today", items: [] }, { label: "Yesterday", items: [] },
    { label: "Previous 7 days", items: [] }, { label: "Older", items: [] },
  ];
  for (const it of items) {
    const t = new Date(date(it) ?? 0).getTime();
    const idx = t >= startOfDay.getTime() ? 0 : t >= startOfDay.getTime() - day ? 1 : t >= startOfDay.getTime() - 7 * day ? 2 : 3;
    groups[idx].items.push(it);
  }
  return groups.filter((g) => g.items.length);
}
