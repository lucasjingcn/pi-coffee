import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { PiEvent, PiSessionState, PiSessionStats, RpcResponse, UiRequest, UiResponse } from "./types.js";

export interface PiRpcClientOptions {
  cwd: string;
  piBin?: string;
  provider?: string;
  model?: string;
  name?: string;
  sessionDir?: string;
  extensionPath?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
}

/**
 * Long-lived `pi --mode rpc` child controlled via JSONL on stdin/stdout.
 *
 * We deliberately do NOT reuse pi's internal RpcClient: spawning the `pi`
 * binary keeps us decoupled from pi's on-disk package layout (which `pi update`
 * rewrites) and from internal module paths.
 */
export class PiRpcClient extends EventEmitter {
  readonly opts: PiRpcClientOptions;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = Buffer.alloc(0);
  private seq = 0;
  private pending = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
  private stderr = "";
  private disposed = false;
  private streaming = false;
  private exited = false;

  constructor(opts: PiRpcClientOptions) {
    super();
    this.setMaxListeners(0);
    this.opts = opts;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  getStderr(): string {
    return this.stderr;
  }

  async start(): Promise<void> {
    const args = ["--mode", "rpc"];
    if (this.opts.name) args.push("--name", this.opts.name);
    if (this.opts.provider) args.push("--provider", this.opts.provider);
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.sessionDir) args.push("--session-dir", this.opts.sessionDir);
    if (this.opts.extensionPath) args.push("--extension", this.opts.extensionPath);
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);

    const proc = spawn(this.opts.piBin ?? "pi", args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
      if (this.stderr.length > 200_000) this.stderr = this.stderr.slice(-200_000);
    });
    proc.on("error", (err) => this.failAll(err));
    proc.on("exit", (code, signal) => {
      this.exited = true;
      const err = new Error(`pi rpc exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
      this.failAll(err);
      this.emit("exit", { code, signal });
    });

    // Wait until the process is actually accepting work (probe get_state).
    const deadline = Date.now() + 30_000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        await this.getState();
        return;
      } catch (e) {
        lastErr = e;
        if (this.exited) break;
        await sleep(200);
      }
    }
    throw new Error(`pi rpc did not become ready: ${String(lastErr)}`);
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf = Buffer.concat([this.stdoutBuf, chunk]);
    // Split strictly on LF; U+2028/U+2029 are valid inside JSON strings.
    for (;;) {
      const nl = this.stdoutBuf.indexOf(0x0a);
      if (nl === -1) break;
      let line = this.stdoutBuf.subarray(0, nl);
      this.stdoutBuf = this.stdoutBuf.subarray(nl + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length === 0) continue;
      let rec: any;
      try {
        rec = JSON.parse(line.toString("utf8"));
      } catch {
        continue; // ignore non-JSON noise defensively
      }
      this.dispatch(rec);
    }
  }

  private dispatch(rec: any): void {
    // UI request sub-protocol
    if (rec?.type === "extension_ui_request") {
      this.emit("ui_request", rec as UiRequest);
      return;
    }
    // Command response
    if (rec?.type === "response") {
      const r = rec as RpcResponse;
      if (r.id && this.pending.has(r.id)) {
        const p = this.pending.get(r.id)!;
        this.pending.delete(r.id);
        p.resolve(r);
      }
      this.emit("response", r);
      return;
    }
    // Session event
    const ev = rec as PiEvent;
    if (ev.type === "agent_start") this.streaming = true;
    if (ev.type === "agent_settled") this.streaming = false;
    this.emit("event", ev);
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    this.streaming = false;
  }

  /** Send a raw command and await the correlated response. */
  command<T = any>(cmd: Record<string, any>, timeoutMs = 120_000): Promise<RpcResponse & { data: T }> {
    if (!this.proc || this.disposed) return Promise.reject(new Error("pi rpc not running"));
    const id = cmd.id ?? `c${++this.seq}`;
    const payload = { ...cmd, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command '${cmd.type}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          if (!r.success) reject(new Error(r.error || `command '${cmd.type}' failed`));
          else resolve(r as any);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc!.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  private write(rec: Record<string, any>): void {
    if (!this.proc || this.disposed) return;
    this.proc.stdin.write(JSON.stringify(rec) + "\n");
  }

  /** Resolve when an event of `type` arrives. */
  waitForEvent(type: string, timeoutMs = 120_000): Promise<PiEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("event", onEvent);
        reject(new Error(`timed out waiting for event '${type}'`));
      }, timeoutMs);
      const onEvent = (ev: PiEvent) => {
        if (ev.type === type) {
          clearTimeout(timer);
          this.off("event", onEvent);
          resolve(ev);
        }
      };
      this.on("event", onEvent);
    });
  }

  // --- typed commands -------------------------------------------------------

  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<RpcResponse> {
    return this.command({ type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) }, 60_000);
  }
  steer(message: string): Promise<RpcResponse> {
    return this.command({ type: "steer", message }, 60_000);
  }
  followUp(message: string): Promise<RpcResponse> {
    return this.command({ type: "follow_up", message }, 60_000);
  }
  abort(): Promise<RpcResponse> {
    return this.command({ type: "abort" }, 60_000);
  }
  newSession(): Promise<RpcResponse> {
    return this.command({ type: "new_session" }, 60_000);
  }
  getState(): Promise<PiSessionState> {
    return this.command<{ [k: string]: any }>({ type: "get_state" }, 20_000).then((r) => r.data as PiSessionState);
  }
  getSessionStats(): Promise<PiSessionStats> {
    return this.command<PiSessionStats>({ type: "get_session_stats" }, 20_000).then((r) => r.data);
  }
  getLastAssistantText(): Promise<string | null> {
    return this.command<{ text: string | null }>({ type: "get_last_assistant_text" }, 20_000).then((r) => r.data.text);
  }
  getEntries(since?: string): Promise<{ entries: any[]; leafId: string | null }> {
    return this.command({ type: "get_entries", ...(since ? { since } : {}) }, 20_000).then((r) => r.data);
  }
  setSessionName(name: string): Promise<RpcResponse> {
    return this.command({ type: "set_session_name", name }, 20_000);
  }
  setModel(provider: string, modelId: string): Promise<RpcResponse> {
    return this.command({ type: "set_model", provider, modelId }, 20_000);
  }
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.command<{ steering: string[]; followUp: string[] }>({ type: "clear_queue" }, 20_000).then((r) => r.data);
  }
  compact(instructions?: string): Promise<RpcResponse> {
    return this.command({ type: "compact", ...(instructions ? { customInstructions: instructions } : {}) }, 600_000);
  }
  bash(command: string): Promise<RpcResponse> {
    return this.command({ type: "bash", command }, 600_000);
  }

  /** Wait until the agent is idle. Resolves immediately if already idle. */
  async waitForSettled(timeoutMs = 300_000): Promise<void> {
    if (!this.streaming) {
      // Confirm with the authoritative state (covers races before first event).
      try {
        const st = await this.getState();
        if (!st.isStreaming) return;
      } catch {
        return;
      }
    }
    await this.waitForEvent("agent_settled", timeoutMs);
  }

  respondUi(response: UiResponse): void {
    this.write(response);
  }

  async stop(): Promise<void> {
    this.disposed = true;
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
