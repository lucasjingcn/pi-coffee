/**
 * Agent Client Protocol (ACP) v1 runner over stdio JSON-RPC.
 *
 * The daemon needs the same observable surface as the pi runner: lifecycle
 * events (`event`), permission prompts (`ui_request`), prompt/cancel, state and
 * a transcript for `pi_tail`. ACP has no model-selection or transcript-replay
 * contract in v1, so those operations are explicitly unsupported.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import type { PiSessionState, PiSessionStats, RpcResponse, UiResponse } from "./types.js";
import type { WorkerTransport } from "./runner.js";

export interface AcpClientOptions {
  command: string[];
  cwd: string;
  /** Raw JSON-RPC transcript (one frame per line) for tail/diagnostics. */
  transcriptPath: string;
  env?: Record<string, string>;
  name?: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const PROMPT_TIMEOUT_MS = 30 * 60 * 1000;

export class AcpClient extends EventEmitter implements WorkerTransport {
  readonly opts: AcpClientOptions;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private pending = new Map<number, PendingRequest>();
  private serverRequests = new Map<number, { optionIds: string[] }>();
  private sessionId?: string;
  private streaming = false;
  private exited = false;
  private stderr = "";
  private lastText = "";

  constructor(opts: AcpClientOptions) {
    super();
    this.opts = opts;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  getStderr(): string {
    return this.stderr;
  }

  async start(timeoutMs = 30_000): Promise<void> {
    if (this.proc) throw new Error("ACP client already started");
    if (!this.opts.command.length) throw new Error("ACP runner command is empty");
    await mkdir(dirname(this.opts.transcriptPath), { recursive: true, mode: 0o700 });
    const [bin, ...args] = this.opts.command;
    const proc = spawn(bin, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.proc = proc;
    proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
      if (this.stderr.length > 200_000) this.stderr = this.stderr.slice(-200_000);
    });
    proc.stdin.on("error", (error) => this.terminate(error));
    proc.on("error", (error) => this.terminate(error));
    proc.on("exit", () => this.terminate(undefined, true));
    const initialized = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "pi-coffee", version: "0.3.0" },
    }, timeoutMs);
    if (!initialized || typeof initialized !== "object") throw new Error("ACP initialize returned an invalid result");
    const session = await this.request("session/new", { cwd: this.opts.cwd, mcpServers: [] }, timeoutMs);
    if (!session || typeof session.sessionId !== "string") throw new Error("ACP session/new did not return a sessionId");
    this.sessionId = session.sessionId;
  }

  async prompt(message: string): Promise<RpcResponse> {
    if (!this.proc || !this.sessionId) throw new Error("ACP client is not started");
    this.lastText = "";
    this.streaming = true;
    this.emit("event", { type: "agent_start" });
    try {
      const result = await this.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: message }],
      }, PROMPT_TIMEOUT_MS);
      this.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: this.lastText }] },
      });
      return { type: "response", command: "prompt", success: true, data: result };
    } catch (error) {
      this.emit("event", { type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } });
      throw error;
    } finally {
      this.streaming = false;
      this.emit("event", { type: "agent_settled" });
    }
  }

  steer(message: string): Promise<RpcResponse> {
    // ACP v1 has no steering channel; a follow-up prompt is the closest contract.
    return this.prompt(message);
  }

  followUp(message: string): Promise<RpcResponse> {
    return this.prompt(message);
  }

  async getState(): Promise<PiSessionState> {
    return {
      isStreaming: this.streaming,
      sessionId: this.sessionId ?? "unknown",
      sessionName: this.opts.name,
    };
  }

  async getSessionStats(): Promise<PiSessionStats> {
    return { sessionId: this.sessionId, tokens: {}, cost: undefined };
  }

  async getEntries(): Promise<{ entries: any[]; leafId: string | null }> {
    return { entries: [], leafId: null };
  }

  async refreshStreaming(): Promise<void> {
    // Streaming is tracked locally; there is no remote state to reconcile.
  }

  async setModel(): Promise<RpcResponse> {
    throw new Error("ACP runner does not support model changes");
  }

  respondUi(response: UiResponse): void {
    const requestId = Number(response.id);
    const pending = this.serverRequests.get(requestId);
    if (!pending) return;
    this.serverRequests.delete(requestId);
    const result = response.cancelled
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId: pending.optionIds[0] ?? "allow" } };
    this.write({ jsonrpc: "2.0", id: requestId, result });
  }

  async stop(): Promise<void> {
    if (!this.proc) {
      this.exited = true;
      return;
    }
    if (!this.exited && this.sessionId) {
      await this.request("session/cancel", { sessionId: this.sessionId }, 2_000).catch(() => undefined);
    }
    const proc = this.proc;
    this.proc = null;
    if (process.platform !== "win32" && proc.pid) {
      try { process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
    } else {
      proc.kill("SIGTERM");
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 2_000);
      proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    this.exited = true;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private write(frame: unknown): void {
    if (!this.proc) return;
    const line = JSON.stringify(frame);
    try {
      this.proc.stdin.write(line + "\n");
      void appendFile(this.opts.transcriptPath, line + "\n").catch(() => undefined);
    } catch (error) {
      this.terminate(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const index = this.buffer.indexOf(0x0a);
      if (index < 0) break;
      const line = this.buffer.subarray(0, index).toString("utf8").trim();
      this.buffer = this.buffer.subarray(index + 1);
      if (!line) continue;
      void appendFile(this.opts.transcriptPath, line + "\n").catch(() => undefined);
      let frame: any;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(frame);
    }
  }

  private dispatch(frame: any): void {
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const pending = this.pending.get(Number(frame.id));
      if (!pending) return;
      this.pending.delete(Number(frame.id));
      clearTimeout(pending.timer);
      if (frame.error) pending.reject(new Error(frame.error.message ?? "ACP request failed"));
      else pending.resolve(frame.result);
      return;
    }
    if (typeof frame.method !== "string") return;
    if (frame.id !== undefined) return this.handleServerRequest(frame);
    this.handleNotification(frame);
  }

  private handleServerRequest(frame: any): void {
    if (frame.method !== "session/request_permission") {
      this.write({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `unsupported method ${frame.method}` } });
      return;
    }
    const options = Array.isArray(frame.params?.options) ? frame.params.options : [];
    const optionIds = options.map((option: any) => String(option.optionId ?? option.id ?? "allow"));
    this.serverRequests.set(Number(frame.id), { optionIds });
    this.emit("ui_request", {
      type: "extension_ui_request",
      id: String(frame.id),
      method: "confirm",
      title: "Permission requested",
      message: String(frame.params?.toolCall?.title ?? frame.params?.message ?? "The agent requests permission"),
      options: optionIds,
    });
  }

  private handleNotification(frame: any): void {
    if (frame.method !== "session/update") return;
    const update = frame.params?.update;
    if (!update || typeof update !== "object") return;
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = update.content?.text;
      if (typeof text === "string") {
        this.lastText += text;
        this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
      }
      return;
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      this.emit("event", { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      this.emit("event", { type: "tool_execution_start", toolCallId: update.toolCallId ?? update.title });
      return;
    }
    if (update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
      this.emit("event", { type: "tool_execution_end", toolCallId: update.toolCallId ?? update.title });
    }
  }

  private terminate(error?: Error, exited = false): void {
    if (exited) this.exited = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("ACP agent exited"));
      this.pending.delete(id);
    }
    if (error) this.stderr += `\n${error.message}`;
    this.emit("exit");
  }
}
