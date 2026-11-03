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
import { descendantPids, terminateSurvivingDescendants } from "./process-tree.js";
import type { WorkerTransport } from "./runner.js";
import { PI_COFFEE_VERSION } from "./version.js";

interface AcpClientOptions {
  command: string[];
  cwd: string;
  /** Raw JSON-RPC transcript (one frame per line) for tail/diagnostics. */
  transcriptPath: string;
  env?: Record<string, string>;
  name?: string;
  /** Per-turn prompt budget; defaults to 30 minutes. Lower it in tests. */
  promptTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const PROMPT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Cap for one unterminated stdout line. An agent that never emits the newline
 * would otherwise grow the buffer until the daemon runs out of memory; the pi
 * runner fails closed the same way.
 */
const MAX_ACP_LINE_BYTES = 8 * 1024 * 1024;

export class AcpClient extends EventEmitter implements WorkerTransport {
  readonly opts: AcpClientOptions;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private pending = new Map<number, PendingRequest>();
  private serverRequests = new Map<number, { optionIds: string[] }>();
  private sessionId?: string;
  /**
   * Instructions accepted but not finished: the turn currently on the wire plus
   * every turn queued behind it. ACP v1 answers one `session/prompt` per turn, so
   * `isStreaming` must stay true while anything is still queued — `pi_wait`,
   * `pi_verify`, `pi_commit` and `pi_finish` gate on it, and an early
   * `agent_settled` would let verification and integration run while the agent is
   * still writing the worktree.
   */
  private outstanding = 0;
  /** Serializes turns: a `session/prompt` is only written after the previous one answered. */
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private exited = false;
  /**
   * Set when a prompt timed out. ACP v1 answers one prompt per turn, so queueing
   * the next instruction would put two turns in flight; every later turn fails
   * loudly instead of racing the agent.
   */
  private poisoned?: string;
  private stderr = "";
  private lastText = "";

  constructor(opts: AcpClientOptions) {
    super();
    this.opts = opts;
  }

  get isStreaming(): boolean {
    return this.outstanding > 0;
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
    this.stopped = false;
    this.exited = false;
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
      clientInfo: { name: "pi-coffee", version: PI_COFFEE_VERSION },
    }, timeoutMs);
    if (!initialized || typeof initialized !== "object") throw new Error("ACP initialize returned an invalid result");
    const session = await this.request("session/new", { cwd: this.opts.cwd, mcpServers: [] }, timeoutMs);
    if (!session || typeof session.sessionId !== "string") throw new Error("ACP session/new did not return a sessionId");
    this.sessionId = session.sessionId;
  }

  async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<RpcResponse> {
    this.assertLive();
    if (streamingBehavior || this.outstanding > 0) {
      // ACP v1 has no steering channel, so a second instruction becomes the next
      // turn instead of racing the running one. Ack it so the orchestrator's MCP
      // call does not block for the rest of somebody else's turn; a failure in
      // that queued turn still surfaces as `message_end` with `stopReason: "error"`
      // and, through it, as a provider failure.
      void this.acceptTurn(message).catch(() => undefined);
      return { type: "response", command: "prompt", success: true, data: { queued: true } };
    }
    return this.acceptTurn(message);
  }

  steer(message: string): Promise<RpcResponse> {
    // ACP v1 has no steering channel; the instruction is delivered as the next turn.
    return this.prompt(message, "steer");
  }

  followUp(message: string): Promise<RpcResponse> {
    return this.prompt(message, "followUp");
  }

  async getState(): Promise<PiSessionState> {
    return {
      isStreaming: this.outstanding > 0,
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
    // Streaming is tracked locally and there is no remote state to reconcile, so
    // `isStreaming` is authoritative only because it counts queued turns too.
  }

  async setModel(): Promise<RpcResponse> {
    throw new Error("ACP runner does not support model changes");
  }

  respondUi(response: UiResponse): void {
    const requestId = Number(response.id);
    const pending = this.serverRequests.get(requestId);
    if (!pending) return;
    this.serverRequests.delete(requestId);
    const options = pending.optionIds;
    const pick = (pattern: RegExp, fallback: string | undefined): string | undefined =>
      options.find((optionId) => pattern.test(optionId)) ?? fallback;
    let result: unknown;
    if (response.cancelled) {
      result = { outcome: { outcome: "cancelled" } };
    } else if (typeof response.value === "string" && response.value !== "") {
      const optionId = options.includes(response.value)
        ? response.value
        : pick(new RegExp(response.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), undefined);
      result = optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } };
    } else if (response.confirmed === false) {
      const optionId = pick(/reject|deny|decline|refuse/i, options[options.length - 1]);
      result = optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } };
    } else {
      const optionId = pick(/allow|approve|once|accept/i, options[0]) ?? "allow";
      result = { outcome: { outcome: "selected", optionId } };
    }
    this.write({ jsonrpc: "2.0", id: requestId, result });
  }

  async stop(): Promise<void> {
    // Refuse queued turns from here on: they belong to a worker that is going away.
    this.stopped = true;
    if (!this.proc) {
      this.exited = true;
      return;
    }
    if (!this.exited && this.sessionId) {
      await this.request("session/cancel", { sessionId: this.sessionId }, 2_000).catch(() => undefined);
    }
    const proc = this.proc;
    const pid = proc.pid;
    this.proc = null;
    // Sample the tree while the root is still alive: an agent's tool children can
    // live in their own process group, and once the root exits they are
    // reparented and invisible to a later `ps`. Confirming a stop while such a
    // child still writes the worktree would release its locks early.
    const tracked = pid !== undefined ? await descendantPids(pid) : null;
    if (process.platform !== "win32" && pid) {
      try { process.kill(-pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
    } else {
      proc.kill("SIGTERM");
    }
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } resolve(false); }, 2_000);
      proc.once("exit", () => { clearTimeout(timer); resolve(true); });
    });
    // The root leaving is not proof that the rest of the tree is gone: escalate to
    // the whole group, then verify every sampled descendant individually.
    if (!exited && pid !== undefined) {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try { process.kill(-pid, 0); } catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      try { if (pid) process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    }
    if (tracked !== null && tracked.length > 0 && process.platform !== "win32") {
      const survivors = await terminateSurvivingDescendants(tracked);
      if (survivors.length > 0) {
        throw new Error(`acp shutdown confirmed the agent group but left ${survivors.length} descendant process(es) alive; retain locks`);
      }
    }
    this.exited = true;
  }

  private assertLive(): void {
    if (this.stopped) throw new Error("ACP client is stopped");
    if (this.exited) throw new Error("ACP client has exited");
    if (!this.proc || !this.sessionId) throw new Error("ACP client is not started");
  }

  /**
   * Accept one instruction. Turns run one at a time: each is chained onto the
   * previous one, so the agent never receives a second `session/prompt` while it
   * is still answering the first. `agent_start`/`agent_settled` fire on the edges
   * of the whole accepted backlog, not per turn, because a queued instruction is
   * pending work the daemon must not report as settled.
   */
  private acceptTurn(message: string): Promise<RpcResponse> {
    this.outstanding += 1;
    if (this.outstanding === 1) this.emit("event", { type: "agent_start" });
    const turn = this.chain.then(() => this.runTurn(message), () => this.runTurn(message));
    this.chain = turn.then(() => undefined, () => undefined);
    return turn.finally(() => {
      this.outstanding -= 1;
      if (this.outstanding === 0) this.emit("event", { type: "agent_settled" });
    });
  }

  private async runTurn(message: string): Promise<RpcResponse> {
    // A stop, crash or exit between accepting and running an instruction must not
    // dispatch it: the daemon has already been told the worker is going away.
    this.assertLive();
    if (this.poisoned) {
      throw new Error(`acp runner cannot accept another turn: ${this.poisoned}`);
    }
    this.lastText = "";
    try {
      const result = await this.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: message }],
      }, this.opts.promptTimeoutMs ?? PROMPT_TIMEOUT_MS);
      this.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: this.lastText }] },
      });
      return { type: "response", command: "prompt", success: true, data: result };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // A timed-out prompt leaves the agent still answering: the serialization
      // invariant ("only after the previous one answered") can no longer be
      // upheld, so refuse further turns instead of sending a second prompt.
      if (/timed out/i.test(detail)) this.poisoned = `previous turn timed out (${detail})`;
      this.emit("event", { type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } });
      throw error;
    }
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
    if (this.buffer.length > MAX_ACP_LINE_BYTES && this.buffer.indexOf(0x0a) < 0) {
      this.buffer = Buffer.alloc(0);
      this.terminate(new Error(`acp output line exceeded ${MAX_ACP_LINE_BYTES} bytes; protocol desynchronized`));
      return;
    }
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
    // An error that arrives while the agent is still running (a broken stdin
    // pipe, a spawn failure) used to emit `exit` immediately: the daemon then
    // released locks and deleted a worktree that the agent might still be
    // writing. Kill it first and only report the exit once it is really gone.
    if (error && !this.exited && this.proc) {
      const proc = this.proc;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      this.exited = true;
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("ACP agent exited"));
      this.pending.delete(id);
    }
    if (error) this.stderr += `\n${error.message}`;
    this.emit("exit");
  }
}
