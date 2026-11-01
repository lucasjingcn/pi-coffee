/**
 * Runner abstraction: the daemon drives a long-lived agent process through the
 * same transport surface whether it is pi (JSONL RPC) or an ACP agent.
 */

import type { EventEmitter } from "node:events";
import type { PiSessionState, PiSessionStats, RpcResponse, UiResponse } from "./types.js";
import type { WorkerRunnerSpec } from "./types.js";

export interface WorkerTransport extends EventEmitter {
  readonly isStreaming: boolean;
  readonly hasExited: boolean;
  readonly pid?: number;
  start(timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<RpcResponse>;
  steer(message: string): Promise<RpcResponse>;
  followUp(message: string): Promise<RpcResponse>;
  getState(): Promise<PiSessionState>;
  getSessionStats(): Promise<PiSessionStats>;
  getEntries(since?: string): Promise<{ entries: any[]; leafId: string | null }>;
  refreshStreaming(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<RpcResponse>;
  respondUi(response: UiResponse): void;
  getStderr(): string;
}

export type RunnerSpec = WorkerRunnerSpec;
