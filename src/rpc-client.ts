import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { PiEvent, PiSessionState, PiSessionStats, RpcResponse, UiRequest, UiResponse } from "./types.js";

export interface PiRpcClientOptions {
  cwd: string;
  piBin?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  name?: string;
  sessionDir?: string;
  extensionPath?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
}

interface PendingCommand {
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
}

/**
 * Long-lived `pi --mode rpc` child controlled via JSONL on stdin/stdout.
 *
 * We deliberately do NOT reuse pi's internal RpcClient: spawning the `pi` binary
 * keeps us decoupled from pi's on-disk package layout (which `pi update`
 * rewrites) and from internal module paths.
 */
export class PiRpcClient extends EventEmitter {
  readonly opts: PiRpcClientOptions;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = Buffer.alloc(0);
  private seq = 0;
  private pending = new Map<string, PendingCommand>();
  private waiters = new Set<{ reject: (e: Error) => void }>();
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

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.disposed) throw new Error("pi rpc client has been disposed");
    if (this.proc) throw new Error("pi rpc client already started");

    const args = ["--mode", "rpc"];
    if (this.opts.name) args.push("--name", this.opts.name);
    if (this.opts.provider) args.push("--provider", this.opts.provider);
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.thinking) args.push("--thinking", this.opts.thinking);
    if (this.opts.sessionDir) args.push("--session-dir", this.opts.sessionDir);
    if (this.opts.extensionPath) args.push("--extension", this.opts.extensionPath);
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);

    const piBin = this.opts.piBin ?? "pi";
    const isNodeScript = piBin.toLowerCase().endsWith(".js");
    const proc = spawn(isNodeScript ? process.execPath : piBin, isNodeScript ? [piBin, ...args] : args, {
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
    proc.stderr.on("error", () => {});

    // A broken pipe on stdin/stdout is terminal: outstanding work can never be
    // completed, so reject it and notify exit consumers instead of swallowing
    // the error. stderr is diagnostics-only, so a failure there is not fatal.
    proc.stdin.on("error", (err: Error) => this.terminate(err));
    proc.stdout.on("error", (err: Error) => this.terminate(err));
    proc.on("error", (err) => {
      // A spawn/pipe error is terminal: the child will not accept work.
      this.terminate(err);
    });
    proc.on("exit", (code, signal) => {
      const err = new Error(`pi rpc exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
      this.terminate(err, code, signal);
    });

    // Wait until the process is actually accepting work (probe get_state).
    const deadline = Date.now() + 30_000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      if (this.exited) break;
      try {
        await this.getState();
        return;
      } catch (e) {
        lastErr = e;
        if (this.exited) break;
        await sleep(200);
      }
    }
    throw new Error(`pi rpc did not become ready: ${String(lastErr ?? "process exited")}`);
  }

  async stop(): Promise<void> {
    this.disposed = true;
    const proc = this.proc;

    // Reject any outstanding work immediately, even before the child exits.
    this.failAll(new Error("pi rpc stopped"));
    if (!proc || this.exited) return;

    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }

    await new Promise<void>((resolve) => {
      if (this.exited) {
        resolve();
        return;
      }
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

  // -------------------------------------------------------------------------
  // Output parsing and dispatch
  // -------------------------------------------------------------------------

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

      let record: any;
      try {
        record = JSON.parse(line.toString("utf8"));
      } catch {
        continue; // ignore non-JSON noise defensively
      }
      this.dispatch(record);
    }
  }

  private dispatch(record: any): void {
    // UI request sub-protocol
    if (record?.type === "extension_ui_request") {
      this.emit("ui_request", record as UiRequest);
      return;
    }

    // Command response
    if (record?.type === "response") {
      const response = record as RpcResponse;
      if (response.id && this.pending.has(response.id)) {
        const pending = this.pending.get(response.id)!;
        this.pending.delete(response.id);
        pending.resolve(response);
      }
      this.emit("response", response);
      return;
    }

    // Session event
    const event = record as PiEvent;
    if (event.type === "agent_start") this.streaming = true;
    if (event.type === "agent_settled") this.streaming = false;
    this.emit("event", event);
  }

  // -------------------------------------------------------------------------
  // Failure handling
  // -------------------------------------------------------------------------

  private failAll(err: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(err);

    this.streaming = false;
    this.rejectWaiters(err);
  }

  /**
   * Mark the client terminal exactly once. Rejects all outstanding work and
   * notifies `exit` consumers so callers are not left waiting on a dead child.
   */
  private terminate(err: Error, code: number | null = null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;

    // A pipe failure is terminal for RPC even if the child is still alive.
    if (this.proc?.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGKILL");

    this.failAll(err);
    this.emit("exit", { code, signal });
  }

  private rejectWaiters(err: Error): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter.reject(err);
  }

  // -------------------------------------------------------------------------
  // Commands and events
  // -------------------------------------------------------------------------

  /** Send a raw command and await the correlated response. */
  command<T = any>(cmd: Record<string, any>, timeoutMs = 120_000): Promise<RpcResponse & { data: T }> {
    if (!this.proc || this.disposed || this.exited) return Promise.reject(new Error("pi rpc not running"));

    const id = cmd.id ?? `c${++this.seq}`;
    // Never let a duplicate id overwrite (and thereby orphan) an in-flight command.
    if (this.pending.has(id)) {
      return Promise.reject(new Error(`duplicate in-flight command id '${id}'`));
    }

    const payload = { ...cmd, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command '${cmd.type}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const entry: PendingCommand = {
        resolve: (response: RpcResponse) => {
          clearTimeout(timer);
          this.pending.delete(id);
          if (!response.success) reject(new Error(response.error || `command '${cmd.type}' failed`));
          else resolve(response as any);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(e);
        },
      };
      this.pending.set(id, entry);

      try {
        this.proc!.stdin.write(JSON.stringify(payload) + "\n", (err) => {
          if (err) entry.reject(err);
        });
      } catch (e) {
        entry.reject(e as Error);
      }
    });
  }

  private write(record: Record<string, any>): void {
    if (!this.proc || this.disposed || this.exited) return;
    try {
      this.proc.stdin.write(JSON.stringify(record) + "\n");
    } catch (e) {
      this.terminate(e as Error);
    }
  }

  /** Resolve when an event of `type` arrives. */
  waitForEvent(type: string, timeoutMs = 120_000): Promise<PiEvent> {
    if (!this.proc || this.disposed || this.exited) return Promise.reject(new Error("pi rpc not running"));

    return new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.off("event", onEvent);
        this.waiters.delete(waiter);
      };

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error(`timed out waiting for event '${type}'`));
      }, timeoutMs);

      const onEvent = (event: PiEvent) => {
        if (done || event.type !== type) return;
        done = true;
        cleanup();
        resolve(event);
      };

      const waiter = {
        reject: (e: Error) => {
          if (done) return;
          done = true;
          cleanup();
          reject(e);
        },
      };

      this.waiters.add(waiter);
      this.on("event", onEvent);
    });
  }

  // -------------------------------------------------------------------------
  // Typed commands
  // -------------------------------------------------------------------------

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

  /**
   * Wait until the agent is idle. Resolves immediately if already idle.
   *
   * The `agent_settled` listener is installed *before* probing authoritative
   * state, so an event that lands while `get_state` is in flight is never lost.
   * The listener, timer and waiter entry are always torn down, including when
   * state already reports idle.
   */
  async waitForSettled(timeoutMs = 300_000): Promise<void> {
    if (!this.proc || this.disposed || this.exited) throw new Error("pi rpc not running");

    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    let resolveSettled!: () => void;
    let rejectSettled!: (e: Error) => void;

    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    // The state probe may still be awaiting a response when termination rejects this wait.
    void settled.catch(() => {});

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      this.off("event", onEvent);
      this.waiters.delete(waiter);
    };

    const onEvent = (event: PiEvent) => {
      if (finished || event.type !== "agent_settled") return;
      finished = true;
      cleanup();
      resolveSettled();
    };

    const waiter = {
      reject: (e: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        rejectSettled(e);
      },
    };

    this.waiters.add(waiter);
    this.on("event", onEvent);

    try {
      if (!this.streaming) {
        // Probe authoritative state. A settled event may arrive while this is
        // in flight; `onEvent` above captures it so it cannot be missed.
        let state: PiSessionState | null = null;
        try {
          state = await this.getState();
        } catch {
          state = null;
        }

        if (finished) {
          // Settled (or terminated) while the probe was in flight.
          await settled;
          return;
        }
        if (!this.exited && !this.disposed && state && !state.isStreaming) {
          // Authoritative idle: done even though no event arrived.
          finished = true;
          cleanup();
          return;
        }
      }

      // Arm the timeout only once we are actually waiting for the event; the
      // probe has its own command timeout.
      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        cleanup();
        rejectSettled(new Error(`timed out waiting for event 'agent_settled'`));
      }, timeoutMs);

      await settled;
    } finally {
      if (!finished) {
        finished = true;
        cleanup();
      }
    }
  }

  respondUi(response: UiResponse): void {
    this.write(response);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
