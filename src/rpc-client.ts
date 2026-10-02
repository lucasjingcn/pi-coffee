import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  /** Request type that a correlated response must echo back in `command`. */
  command: string;
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
  /** Every id ever issued, so a settled/timed-out id can never be reused. */
  private usedIds = new Set<string>();
  private waiters = new Set<{ reject: (e: Error) => void }>();
  private stderr = "";
  private disposed = false;
  private streaming = false;
  private exited = false;
  private stopPromise: Promise<void> | null = null;
  private shutdownConfirmed = false;
  private processGroup = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;

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
    return this.shutdownConfirmed;
  }

  getStderr(): string {
    return this.stderr;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(timeoutMs = 30_000): Promise<void> {
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`invalid start timeout '${String(timeoutMs)}': expected a finite positive number`);
    }
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
      // Own a separate group so cancellation also stops tools spawned by pi.
      detached: process.platform !== "win32",
    });
    this.proc = proc;
    this.processGroup = process.platform !== "win32";

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
      this.exitCode = code;
      this.exitSignal = signal;
      const err = new Error(`pi rpc exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
      this.terminate(err, code, signal);
    });

    // Wait until the process is actually accepting work (probe get_state).
    // All probes share one total startup deadline, so a wedged child cannot
    // hold start() open past the configured budget.
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    try {
      while (Date.now() < deadline) {
        if (this.exited) break;
        try {
          await this.probeState(deadline - Date.now());
          // pi may accept RPC after falling back to defaults on a configuration
          // read error. That is not a usable worker with the requested contract.
          if (/Invalid settings file/i.test(this.stderr)) throw new Error("pi configuration load failed");
          return;
        } catch (e) {
          lastErr = e;
          if (/Invalid settings file/i.test(this.stderr)) break;
          if (this.exited) break;
          const pause = Math.min(200, deadline - Date.now());
          if (pause > 0) await sleep(pause);
        }
      }
      if (!lastErr && !this.exited) lastErr = new Error(`startup deadline of ${timeoutMs}ms exceeded`);
      const reason = /Lock file is already being held|ELOCKED/i.test(this.stderr)
        ? "settings_lock_contention"
        : /Invalid settings file/i.test(this.stderr) ? "configuration_load_failed"
        : this.exited ? "process_exited" : "readiness_timeout";
      // Do not attach raw stderr: extensions can print credentials or prompts.
      throw new Error(`pi rpc did not become ready: ${String(lastErr ?? "process exited")} [reason=${reason}, code=${this.exitCode}, signal=${this.exitSignal}]`);
    } catch (e) {
      // A failed start must not leak the child or leave probe work pending.
      this.terminate(e as Error);
      await this.stop();
      throw e;
    }
  }

  /** Probe get_state without outliving the remaining startup budget. */
  private async probeState(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.getState(),
        new Promise<never>((_, reject) => {
          // get_state already has a 20s command timeout; cap this timer as well
          // so very large finite startup budgets cannot overflow Node's timers.
          const probeMs = Math.min(timeoutMs, 20_000);
          timer = setTimeout(() => reject(new Error(`readiness probe timed out after ${probeMs}ms`)), probeMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    this.disposed = true;
    this.failAll(new Error("pi rpc stopped"));
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopProcess();
    try {
      await this.stopPromise;
    } catch (err) {
      // Allow an operator to retry; never claim successful shutdown on timeout.
      this.stopPromise = null;
      throw err;
    }
  }

  private async stopProcess(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.pid === undefined) {
      this.shutdownConfirmed = true;
      return;
    }
    const pid = proc.pid;
    if (process.platform === "win32") {
      // taskkill /T captures the descendant tree while its root still exists.
      // If the root already exited, that evidence is unavailable: retain locks.
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error("pi rpc cannot confirm Windows tool tree after root exit; retain locks");
      }
      await this.killWindowsTree(pid);
      const deadline = Date.now() + 3000;
      while (proc.exitCode === null && proc.signalCode === null && Date.now() < deadline) await sleep(25);
      if (proc.exitCode === null && proc.signalCode === null) {
        throw new Error("pi rpc Windows tree termination did not confirm root exit; retain locks");
      }
      this.shutdownConfirmed = true;
      return;
    }
    const alive = (): boolean => {
      if (!this.processGroup) return proc.exitCode === null && proc.signalCode === null;
      try { process.kill(-pid, 0); return true; }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
        // EPERM is not proof of absence (and can be transient during reap).
        if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
        throw err;
      }
    };
    const signal = (value: NodeJS.Signals): void => {
      try {
        if (this.processGroup) process.kill(-pid, value);
        else proc.kill(value);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    };
    const wait = async (ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      do {
        if (!alive() && (proc.exitCode !== null || proc.signalCode !== null)) return true;
        await sleep(25);
      } while (Date.now() < deadline);
      return !alive() && (proc.exitCode !== null || proc.signalCode !== null);
    };
    try { proc.stdin.end(); } catch { /* termination below still applies */ }
    if (!await wait(1000)) {
      signal("SIGTERM");
      if (!await wait(1000)) {
        signal("SIGKILL");
        if (!await wait(3000)) throw new Error("pi rpc shutdown could not confirm worker and tool process exit; retain locks");
      }
    }
    this.shutdownConfirmed = true;
  }

  private killWindowsTree(pid: number): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 5000, windowsHide: true }, (err) => {
        // Do not expose command output: only successful native tree termination
        // establishes descendant shutdown. Any failure must retain the locks.
        if (err) reject(new Error("pi rpc Windows tool tree termination failed; retain locks"));
        else resolve();
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

  private dispatch(record: unknown): void {
    // JSONL framing can surface arbitrary JSON values; only objects with a
    // non-empty string `type` are protocol records. Ignore anything else and
    // keep parsing subsequent frames.
    if (record === null || typeof record !== "object" || Array.isArray(record)) return;
    const type = (record as { type?: unknown }).type;
    if (typeof type !== "string" || type.length === 0) return;

    // UI request sub-protocol
    if (type === "extension_ui_request") {
      this.emit("ui_request", record as UiRequest);
      return;
    }

    // Command response
    if (type === "response") {
      this.dispatchResponse(record as Record<string, unknown>);
      return;
    }

    // Session event
    const event = record as PiEvent;
    if (event.type === "agent_start") this.streaming = true;
    if (event.type === "agent_settled") this.streaming = false;
    this.emit("event", event);
  }

  /**
   * Settle a pending command only when the response is well-formed:
   * `success` must be a boolean and, when `command` is present, it must match
   * the request. Minimal fixtures without `command` remain compatible.
   */
  private dispatchResponse(record: Record<string, unknown>): void {
    const response = record as unknown as RpcResponse;
    const id = response.id;
    const pending = typeof id === "string" ? this.pending.get(id) : undefined;

    if (pending) {
      this.pending.delete(id as string);
      if (typeof response.success !== "boolean") {
        pending.reject(new Error(`malformed response for command '${pending.command}': success must be boolean`));
      } else if (response.command !== undefined && response.command !== pending.command) {
        pending.reject(
          new Error(
            `malformed response for command '${pending.command}': command '${String(response.command)}' does not match`,
          ),
        );
      } else {
        pending.resolve(response);
      }
    }
    this.emit("response", response);
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

    this.failAll(err);
    // A protocol/pipe failure is not proof of process exit. Publish exit only
    // after cancellation has also confirmed that the owned tools are gone.
    void this.stop().then(() => {
      this.emit("exit", { code, signal });
    }, (stopError: Error) => {
      this.emit("shutdown_failed", { message: stopError.message });
    });
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
    const explicitId = cmd.id !== undefined ? cmd.id : undefined;
    if (explicitId !== undefined && (typeof explicitId !== "string" || explicitId.length === 0)) {
      return Promise.reject(new Error(`invalid command id '${String(explicitId)}': expected a non-empty string`));
    }

    if (!this.proc || this.disposed || this.exited) return Promise.reject(new Error("pi rpc not running"));

    let id: string;
    if (explicitId !== undefined) {
      id = explicitId;
      // Retain the historical diagnostic before checking reuse of settled ids.
      if (this.pending.has(id)) {
        return Promise.reject(new Error(`duplicate in-flight command id '${id}'`));
      }
      // An issued id is single-use even after its command settled or timed out.
      if (this.usedIds.has(id)) {
        return Promise.reject(new Error(`command id '${id}' has already been used`));
      }
    } else {
      // Auto ids must never collide with an already issued explicit id.
      do {
        id = `c${++this.seq}`;
      } while (this.usedIds.has(id) || this.pending.has(id));
    }
    this.usedIds.add(id);

    const command = typeof cmd.type === "string" ? cmd.type : "";
    const payload = { ...cmd, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command '${cmd.type}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const entry: PendingCommand = {
        command,
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
