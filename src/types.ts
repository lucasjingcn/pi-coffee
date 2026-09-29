/** Minimal subset of the pi RPC protocol that the daemon relies on. */

/** JSONL reply to a command sent over the pi RPC stdin pipe. */
export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: any;
  error?: string;
}

export interface PiSessionState {
  model?: { provider?: string; id?: string; name?: string };
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting?: boolean;
  steeringMode?: string;
  followUpMode?: string;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
}

export interface PiSessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  totalMessages?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  cost?: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

/** Any event emitted by a pi session. `type` decides how it is handled. */
export interface PiEvent {
  type: string;
  [key: string]: any;
}

export type UiMethod = "select" | "confirm" | "input" | "editor" | "notify" | string;

/** A pi extension asking a human to answer. The daemon forwards these to Codex. */
export interface UiRequest {
  type: "extension_ui_request";
  id: string;
  method: UiMethod;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  [key: string]: any;
}

export interface UiResponse {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export type SendMode = "prompt" | "steer" | "followup";

/** Classification Codex must give a delegated task; design/security must not be delegated. */
export type TaskType = "mechanical" | "feature" | "refactor" | "debug" | "design" | "security";

/** Assigned work, not a measure of actual code contribution. */
export const WORKSTREAM_PURPOSES = ["implementation", "review", "investigation"] as const;
export type WorkstreamPurpose = typeof WORKSTREAM_PURPOSES[number];

/** Structured delegation contract the coordinator hands to a worker. */
export interface DelegationSpec {
  /** One unambiguous sentence: what must be true when done. */
  goal: string;
  /** Worktree-relative paths/files the worker may touch. Everything else is out of scope. */
  scope: string[];
  /** Explicit non-goals / things not to touch. */
  non_goals?: string[];
  /** Interfaces, types, signatures, invariants to honor. */
  contracts?: string[];
  /** Constraints: no new deps, no public API changes, performance, style, etc. */
  constraints?: string[];
  /** Task classification. */
  task_type?: TaskType;
  /** Distinguish writing code from reviewing it or gathering evidence. Omitted history is unknown. */
  purpose?: WorkstreamPurpose;
}
