export type AgentState = "idle" | "planning" | "retrieving" | "executing" | "validating" | "completed" | "failed";
export type StepStatus = "pending" | "running" | "awaiting_approval" | "completed" | "failed" | "skipped";
export type SourceKind = "local" | "web" | "cloud" | "memory" | "tool";

export interface AgentInfo {
  name: string;
  display_name: string;
  description: string;
  color: string;
  available: boolean;
  status_detail: string;
}

export interface PlanStep {
  task_id: string;
  description: string;
  agent: string;
  query: string;
  tools: string[];
  arguments: Record<string, unknown>;
  depends_on: string[];
  status: StepStatus;
  result_summary?: string | null;
  error?: string | null;
}

export interface Plan {
  intent: string;
  rationale: string;
  steps: PlanStep[];
}

export interface EvidenceItem {
  evidence_id: string;
  kind: SourceKind;
  title: string;
  source: string;
  locator?: string | null;
  agent: string;
  score: number;
  rerank_score?: number | null;
  reliability: number;
  published_at?: string | null;
  preview: string;
  metadata: Record<string, any>;
}

export interface Citation {
  index: number;
  evidence_id: string;
  title: string;
  source: string;
  locator?: string | null;
  kind: SourceKind;
  snippet: string;
}

export interface ClaimCheck {
  sentence: string;
  cited: number[];
  supported: boolean;
  support_score: number;
  /** Citations were taken from the sentence's bullet/paragraph or section. */
  inherited?: boolean;
  /** The answer gave no citation; `cited` is the best-matching source. */
  matched?: boolean;
}

export interface ValidationStats {
  claims: number;
  supported: number;
  uncited: number;
  invalid_citations: number[];
  supported_ratio: number;
}

export interface ToolEvent {
  event: "tool_call" | "tool_result";
  agent: string;
  task_id?: string;
  tool: string;
  arguments?: Record<string, unknown>;
  ok?: boolean;
  error?: string | null;
  preview?: string;
  reason?: string;
  approval_id?: string | null;
}

export interface Approval {
  approval_id: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  actor: string;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  description: string;
  created_at: string;
  result?: { ok: boolean; content: string; error?: string } | null;
}

export interface MemoryItem {
  id: string;
  kind: string;
  content: string;
  status: "active" | "proposed";
  importance: number;
  created_at?: string;
  expires_at?: string | null;
  score?: number;
}

export interface RunState {
  plan?: Plan;
  steps: Record<string, PlanStep>;
  agents: Record<string, { status: AgentState; detail?: string }>;
  tools: ToolEvent[];
  evidence: EvidenceItem[];
  selected: string[];
  conflicts: { a: string; b: string; issue: string }[];
  citations: Citation[];
  claims: ClaimCheck[];
  stats?: ValidationStats;
  approvals: Approval[];
  iterations: { iteration: number; query: string; action: string }[];
  memories: MemoryItem[];
  memoryProposal?: MemoryItem;
  error?: string;
  done: boolean;
  elapsedMs?: number;
}

export interface DocAttachment {
  doc_id?: string;
  file_name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  kb_id?: string;
  error?: string;
  chunks?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  run?: RunState;
  attachments?: DocAttachment[];
  /** Model id that wrote this answer, when one was chosen. */
  model?: string;
}

export interface McpTool {
  server: string;
  name: string;
  description: string;
  input_schema: Record<string, any>;
  read_only?: boolean | null;
  destructive?: boolean | null;
}

export interface McpServer {
  name: string;
  category: string;
  transport: "stdio" | "http";
  command?: string;
  args: string[];
  url?: string;
  enabled: boolean;
  description: string;
  status: "connected" | "connecting" | "disconnected" | "error";
  error?: string | null;
  env_keys: string[];
  permissions: { allow: string[]; deny: string[]; approval_required: string[]; auto_approve_read_only: boolean };
  tools: McpTool[];
}

export interface KnowledgeBase {
  kb_id: string;
  name: string;
  description: string;
  documents: number;
  chunks: number;
  vectors: number;
}

export interface ModelStatus {
  name: string | null;
  state: "unloaded" | "loading" | "ready" | "error";
  device: string | null;
  error: string | null;
  load_seconds: number | null;
  extra: Record<string, any>;
}
