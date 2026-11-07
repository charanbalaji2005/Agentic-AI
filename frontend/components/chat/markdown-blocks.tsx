"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Download, Table2, WrapText } from "lucide-react";
import { Tooltip } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/* ───────── helpers ───────── */

/** Save text or a Blob as a download. */
export function saveFile(name: string, content: string | Blob, type = "text/plain;charset=utf-8") {
  const blob = typeof content === "string" ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Plain text of a hast (markdown AST) node. */
export function hastText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

const EXT: Record<string, string> = {
  python: "py", py: "py", javascript: "js", js: "js", typescript: "ts", ts: "ts", tsx: "tsx", jsx: "jsx",
  java: "java", go: "go", rust: "rs", rs: "rs", c: "c", cpp: "cpp", "c++": "cpp", csharp: "cs", cs: "cs",
  ruby: "rb", rb: "rb", php: "php", sql: "sql", bash: "sh", sh: "sh", shell: "sh", zsh: "sh", powershell: "ps1", ps1: "ps1",
  yaml: "yaml", yml: "yml", toml: "toml", json: "json", html: "html", css: "css", scss: "scss", markdown: "md", md: "md",
  hcl: "tf", terraform: "tf", tf: "tf", dockerfile: "Dockerfile", kotlin: "kt", swift: "swift", r: "r", xml: "xml",
};

const KEYWORDS = new Set((
  "abstract and as assert async await break case catch class const continue def default del do elif else enum except export " +
  "extends false final finally fn for from func function global if impl import in instanceof interface is lambda let match " +
  "module mut new nil none not null or package pass private protected pub public raise return self static struct super switch " +
  "this throw throws trait true try type typeof undefined use var void where while with yield select insert update delete " +
  "into values create table join on group by order having limit SELECT INSERT UPDATE DELETE FROM WHERE INTO VALUES CREATE TABLE " +
  "JOIN ON GROUP BY ORDER HAVING LIMIT AND OR NOT NULL AS True False None echo then fi done esac"
).split(" "));

type Tok = { t: "kw" | "str" | "com" | "num" | "fn" | "plain"; v: string };

/** Small language-agnostic highlighter: comments, strings, numbers, keywords and function names. */
function tokenize(code: string, lang: string): Tok[] {
  const hashComments = /^(py|python|sh|bash|shell|zsh|yaml|yml|toml|r|ruby|rb|powershell|ps1|dockerfile|hcl|tf|terraform)$/.test(lang);
  const sqlComments = lang === "sql";
  const re = new RegExp(
    [
      String.raw`\/\*[\s\S]*?\*\/`,
      hashComments ? String.raw`#[^\n]*` : sqlComments ? String.raw`--[^\n]*` : String.raw`\/\/[^\n]*`,
      String.raw`"""[\s\S]*?"""`, String.raw`'''[\s\S]*?'''`,
      String.raw`"(?:\\.|[^"\\\n])*"`, String.raw`'(?:\\.|[^'\\\n])*'`, "`(?:\\\\.|[^`\\\\])*`",
      String.raw`\b\d+(?:\.\d+)?\b`,
      String.raw`[A-Za-z_][A-Za-z0-9_]*`,
    ].join("|"),
    "g",
  );
  const out: Tok[] = [];
  let last = 0;
  for (const m of code.matchAll(re)) {
    const v = m[0];
    const i = m.index ?? 0;
    if (i > last) out.push({ t: "plain", v: code.slice(last, i) });
    const c = v[0];
    const t: Tok["t"] =
      v.startsWith("/*") || v.startsWith("//") || (hashComments && c === "#") || (sqlComments && v.startsWith("--")) ? "com"
      : c === '"' || c === "'" || c === "`" ? "str"
      : /\d/.test(c) ? "num"
      : KEYWORDS.has(v) ? "kw"
      : /^\s*\(/.test(code.slice(i + v.length, i + v.length + 3)) ? "fn" : "plain";
    out.push({ t, v });
    last = i + v.length;
  }
  if (last < code.length) out.push({ t: "plain", v: code.slice(last) });
  return out;
}

const TOK_CLASS: Record<Tok["t"], string> = {
  kw: "tok-kw font-medium",
  str: "tok-str",
  com: "tok-com",
  num: "tok-num",
  fn: "tok-fn",
  plain: "",
};

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip label={label}>
      <button type="button" onClick={onClick} aria-label={label}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted transition-colors hover:bg-ink/[0.07] hover:text-ink">
        {children}
      </button>
    </Tooltip>
  );
}

/* ───────── Code box ───────── */

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const clean = code.replace(/\n$/, "");
  const tokens = useMemo(() => (clean.length > 60000 ? [{ t: "plain" as const, v: clean }] : tokenize(clean, lang)), [clean, lang]);
  const lines = clean.split("\n").length;

  const copy = async () => {
    try { await navigator.clipboard.writeText(clean); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };
  const download = () => {
    const ext = EXT[lang] ?? (lang || "txt");
    saveFile(ext === "Dockerfile" ? "Dockerfile" : `snippet.${ext}`, clean);
  };

  return (
    <div className="not-prose my-4 overflow-hidden rounded-xl border border-line bg-sunken font-sans">
      <div className="flex h-9 items-center gap-1 border-b border-line bg-ink/[0.03] pl-3.5 pr-1.5">
        <span className="text-[12px] font-medium text-muted">{lang || "code"}</span>
        <span className="ml-1.5 text-[11px] text-muted/70">{lines} line{lines === 1 ? "" : "s"}</span>
        <div className="ml-auto flex items-center">
          <IconAction label={wrap ? "Don't wrap lines" : "Wrap lines"} onClick={() => setWrap((w) => !w)}>
            <WrapText className={cn("size-3.5", wrap && "text-ink")} />
          </IconAction>
          <IconAction label="Download code" onClick={download}>
            <Download className="size-3.5" />
          </IconAction>
          <IconAction label={copied ? "Copied" : "Copy code"} onClick={copy}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </IconAction>
        </div>
      </div>
      <pre className={cn("m-0 max-h-[520px] overflow-auto scroll-thin border-0 bg-transparent p-4 font-mono text-[13px] leading-6",
        wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")}>
        <code>
          {tokens.map((tk, i) => (tk.t === "plain" ? tk.v : <span key={i} className={TOK_CLASS[tk.t]}>{tk.v}</span>))}
        </code>
      </pre>
    </div>
  );
}

/* ───────── Table box ───────── */

function tableRows(node: any): string[][] {
  const rows: string[][] = [];
  const walk = (n: any) => {
    if (!n) return;
    if (n.type === "element" && n.tagName === "tr") {
      rows.push((n.children ?? []).filter((c: any) => c.type === "element" && (c.tagName === "td" || c.tagName === "th"))
        .map((c: any) => hastText(c).trim()));
      return;
    }
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  return rows;
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function TableBlock({ node, children }: { node: any; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const rows = useMemo(() => tableRows(node), [node]);
  const cols = rows[0]?.length ?? 0;

  const copy = async () => {
    // Tab-separated pastes cleanly into spreadsheets and docs.
    try { await navigator.clipboard.writeText(rows.map((r) => r.join("\t")).join("\n")); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };
  const download = () => saveFile("table.csv", "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8");

  return (
    <div className="not-prose my-4 overflow-hidden rounded-xl border border-line font-sans">
      <div className="flex h-9 items-center gap-2 border-b border-line bg-ink/[0.03] pl-3.5 pr-1.5">
        <Table2 className="size-3.5 text-muted" />
        <span className="text-[12px] font-medium text-muted">Table</span>
        <span className="text-[11px] text-muted/70">{Math.max(0, rows.length - 1)} rows × {cols} columns</span>
        <div className="ml-auto flex items-center">
          <IconAction label="Download CSV" onClick={download}>
            <Download className="size-3.5" /><span>CSV</span>
          </IconAction>
          <IconAction label={copied ? "Copied" : "Copy table"} onClick={copy}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </IconAction>
        </div>
      </div>
      <div className="max-h-[480px] overflow-auto scroll-thin">
        <table className="m-0 w-full border-collapse text-[14px] [&_td]:border-b [&_td]:border-line [&_td]:px-3.5 [&_td]:py-2 [&_th]:sticky [&_th]:top-0 [&_th]:border-b [&_th]:border-line [&_th]:bg-sunken [&_th]:px-3.5 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_tr:last-child_td]:border-0 [&_tbody_tr:hover]:bg-ink/[0.025]">
          {children}
        </table>
      </div>
    </div>
  );
}
