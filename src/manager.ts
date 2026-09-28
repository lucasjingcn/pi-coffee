import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Config } from "./config.js";
import { Board, Mailbox, type MessageKind } from "./mailbox.js";
import { LockManager, type ClaimResult, type LockMode } from "./locks.js";
import { PiRpcClient } from "./rpc-client.js";
import type { PiEvent, UiRequest, UiResponse } from "./types.js";
import type { DelegationSpec } from "./types.js";
import { commitAll, createWorktree, currentBranch, mergeBranch, pushBranch, removeWorktree, resolveRef, worktreeDiff, type DiffSummary, type MergeResult, type WorktreeInfo } from "./worktree.js";

export type SessionStatus = "starting" | "idle" | "working" | "error" | "stopped";

export type Outcome = "success_first" | "success_second" | "taken_over" | "abandoned";

export interface SessionMeta {
  id: string;
  name: string;
  repo: string;
  worktree: string;
  branch: string;
  cwd: string;
  baseRef: string;
  status: SessionStatus;
  createdAt: number;
  lastActivity: number;
  lastText?: string;
  lastEntryId?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
  provider?: string;
  model?: string;
  pendingQuestions: UiRequest[];
  error?: string;
  /** Assistant turns seen for this session. */
  turns?: number;
  /** Number of instructions Codex has sent to this session (initial + corrections). */
  instructionsSent?: number;
  /** Final disposition of this workstream. */
  outcome?: Outcome;
  outcomeNote?: string;
  /** Whether the acceptance test was authored/owned by Codex (spec-derived) rather than the worker. */
  testsOwnedByCodex?: boolean;
  /** Coordinator-authored acceptance files written into the worktree before the worker starts. */
  acceptance?: { files: string[]; command?: string };
  /** Structured delegation spec used to spawn this workstream. */
  spec?: DelegationSpec;
  /** Characters Codex sent to this worker through the daemon (lower bound on orchestrator output). */
  orchestratorChars?: number;
  /** Set once the worker-side coordinator extension checked in. */
  extension?: boolean;
  extensionAt?: number;
}

interface Runtime {
  meta: SessionMeta;
  client: PiRpcClient;
  lastNotifiedQuestionIds: Set<string>;
}

export interface SpawnOptions {
  task?: string;
  repo?: string;
  name?: string;
  baseRef?: string;
  branch?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  initialMessage?: string;
  /** Spec-derived acceptance test files (path is relative to the worktree) written before start. */
  acceptanceFiles?: { path: string; content: string }[];
  acceptanceCommand?: string;
  /** Structured task spec (goal/scope/contracts/...). Rendered into the worker prompt. */
  spec?: DelegationSpec;
}

export interface WaitResult {
  sessions: SessionMeta[];
  timedOut: boolean;
}

export class Coordinator {
  readonly config: Config;
  private runtimes = new Map<string, Runtime>();
  private locks = new LockManager();
  private mailbox = new Mailbox();
  private board = new Board();
  private counter = 0;
  private history: SessionMeta[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  private waiters = new Set<() => void>();

  constructor(config: Config) {
    this.config = config;
  }

  async init(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    await mkdir(join(this.config.dataDir, "sessions"), { recursive: true });
    await mkdir(this.config.workspaceRoot, { recursive: true });
    await this.load();
  }

  // --- persistence ----------------------------------------------------------

  private stateFile(): string {
    return join(this.config.dataDir, "state.json");
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.stateFile(), "utf8"));
      if (raw.counter) this.counter = raw.counter;
      if (raw.locks) this.locks.import(raw.locks);
      if (raw.mailbox) this.mailbox.import(raw.mailbox);
      if (raw.board) this.board.import(raw.board);
      if (Array.isArray(raw.history)) this.history = raw.history;
    } catch {
      /* fresh start */
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 500);
  }

  private async save(): Promise<void> {
    const data = {
      counter: this.counter,
      locks: this.locks.export(),
      mailbox: this.mailbox.export(),
      board: this.board.export(),
      history: this.history,
    };
    try {
      await writeFile(this.stateFile(), JSON.stringify(data, null, 2));
    } catch {
      /* best effort */
    }
  }

  // --- sessions -------------------------------------------------------------

  private nextId(): string {
    return `s${++this.counter}`;
  }

  private notifyWaiters(): void {
    for (const w of [...this.waiters]) w();
  }

  async spawn(opts: SpawnOptions = {}): Promise<SessionMeta> {
    if (this.activeCount() >= this.config.maxSessions) {
      throw new Error(`max sessions reached (${this.config.maxSessions})`);
    }
    const repo = opts.repo ?? this.config.defaultRepo;
    if (!repo) {
      throw new Error("repo is required: pass repo to pi_spawn, or set PI_MCP_DEFAULT_REPO for the daemon");
    }
    if (!existsSync(repo)) {
      throw new Error(`repo path does not exist: ${repo}`);
    }
    const id = this.nextId();
    const name = opts.name ?? `${id}-${(opts.task ?? "task").slice(0, 40)}`;
    const branch = opts.branch ?? `pi/${id}`;
    const dir = join(this.config.workspaceRoot, id);
    const requestedBase = opts.baseRef ?? this.config.defaultBaseRef;

    // Scope pre-claim & overlap pre-check: reserve the declared scope before creating anything, so
    // two workstreams with overlapping files are rejected at dispatch instead of mid-flight.
    const scope = opts.spec?.scope ?? [];
    if (scope.length) {
      const pre = this.locks.claim(id, scope, "rw");
      if (!pre.ok) {
        this.locks.releaseAll(id);
        throw new Error(
          `scope conflicts with active sessions: ${pre.conflicts.map((c) => `${c.path} @ ${c.sessionId}`).join(", ")}`,
        );
      }
    }

    let wt: WorktreeInfo;
    try {
      wt = await createWorktree({ repo, dir, branch, baseRef: requestedBase });
    } catch (e) {
      this.locks.releaseAll(id);
      throw e;
    }
    // Store a concrete SHA, not "HEAD": a symbolic ref would make `base...HEAD` empty after
    // the worker commits, hiding committed changes from pi_diff.
    const baseSha = await resolveRef(repo, requestedBase).catch(() => requestedBase);

    // Test-first delegation: write Codex-authored acceptance files BEFORE the worker starts.
    const acceptancePaths: string[] = [];
    try {
      if (opts.acceptanceFiles?.length) {
        for (const f of opts.acceptanceFiles) {
          const abs = join(wt.dir, f.path);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, f.content, "utf8");
          acceptancePaths.push(f.path);
        }
      }
    } catch (e) {
      this.locks.releaseAll(id);
      await removeWorktree(repo, wt.dir, branch).catch(() => {});
      throw e;
    }

    const meta: SessionMeta = {
      id,
      name,
      repo,
      worktree: wt.dir,
      branch: wt.branch,
      cwd: wt.dir,
      baseRef: baseSha,
      acceptance: acceptancePaths.length ? { files: acceptancePaths, command: opts.acceptanceCommand } : undefined,
      spec: opts.spec,
      status: "starting",
      createdAt: Date.now(),
      lastActivity: Date.now(),
      pendingQuestions: [],
    };

    const client = new PiRpcClient({
      cwd: wt.dir,
      piBin: this.config.piBin,
      provider: opts.provider ?? this.config.provider,
      model: opts.model ?? this.config.model,
      name,
      sessionDir: join(this.config.dataDir, "sessions", id),
      extensionPath: this.config.extensionPath,
      env: {
        PI_COORD_URL: `http://${this.config.host}:${this.config.port}`,
        PI_COORD_SESSION_ID: id,
        PI_COORD_TOKEN: this.config.token,
      },
    });

    const rt: Runtime = { meta, client, lastNotifiedQuestionIds: new Set() };
    this.runtimes.set(id, rt);
    this.wireEvents(rt);

    // Reserve the acceptance files for Codex so worker edits to them are blocked (immutable tests).
    if (acceptancePaths.length) this.locks.claim("codex", acceptancePaths, "rw");

    try {
      await client.start();
      meta.status = "idle";
    } catch (e) {
      meta.status = "error";
      meta.error = String(e);
      this.locks.releaseAll(id);
      this.scheduleSave();
      this.notifyWaiters();
      throw e;
    }

    this.scheduleSave();
    this.notifyWaiters();

    const parts: string[] = [];
    if (opts.prompt) parts.push(opts.prompt);
    const specBlock = renderSpec(opts.spec);
    if (specBlock) parts.push(specBlock);
    if (acceptancePaths.length) {
      let note =
        `A coordinator-authored acceptance test is already in the worktree at: ${acceptancePaths.join(", ")}. ` +
        `Your job is to make it pass. Do NOT modify those files.`;
      if (opts.acceptanceCommand) note += ` Verification command: ${opts.acceptanceCommand}`;
      parts.push(note);
    }
    const first = parts.join("\n\n");
    if (first) await this.send(id, first, "prompt");
    return meta;
  }

  private wireEvents(rt: Runtime): void {
    rt.client.on("event", (ev: PiEvent) => {
      rt.meta.lastActivity = Date.now();
      switch (ev.type) {
        case "agent_start":
          rt.meta.status = "working";
          break;
        case "agent_settled":
          rt.meta.status = "idle";
          void this.refreshStats(rt, true);
          break;
        case "message_end": {
          const msg = ev.message;
          if (msg?.role === "assistant") {
            const text = textOf(msg);
            if (text) rt.meta.lastText = text;
          }
          break;
        }
        case "entry_appended":
          if (ev.entry?.id) rt.meta.lastEntryId = ev.entry.id;
          break;
        default:
          break;
      }
      this.notifyWaiters();
    });

    rt.client.on("ui_request", (req: UiRequest) => {
      if (req.method === "notify" || req.method === "setStatus" || req.method === "setWidget" || req.method === "setTitle" || req.method === "set_editor_text") {
        return; // fire-and-forget
      }
      if (!rt.meta.pendingQuestions.some((q) => q.id === req.id)) {
        rt.meta.pendingQuestions.push(req);
      }
      this.notifyWaiters();
    });

    rt.client.on("exit", () => {
      if (rt.meta.status !== "stopped") {
        rt.meta.status = "error";
        rt.meta.error = rt.client.getStderr().slice(-2000) || "pi rpc exited";
      }
      this.locks.releaseAll(rt.meta.id);
      this.notifyWaiters();
      this.scheduleSave();
    });
  }

  private async refreshStats(rt: Runtime, includeCost = false): Promise<void> {
    try {
      const st = await rt.client.getState();
      rt.meta.provider = st.model?.provider;
      rt.meta.model = st.model?.id;
      if (typeof st.sessionName === "string") rt.meta.name = st.sessionName;
      if (includeCost) {
        const stats = await rt.client.getSessionStats();
        rt.meta.cost = stats.cost;
        rt.meta.tokens = stats.tokens;
        rt.meta.context = stats.contextUsage;
        rt.meta.turns = stats.assistantMessages ?? rt.meta.turns;
      }
    } catch {
      /* ignore */
    }
  }

  get(id: string): Runtime {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(`unknown session: ${id}`);
    return rt;
  }

  /** Sessions that still occupy a concurrency slot (stopped/errored ones do not). */
  private activeCount(): number {
    let n = 0;
    for (const rt of this.runtimes.values()) {
      if (rt.meta.status === "starting" || rt.meta.status === "idle" || rt.meta.status === "working") n++;
    }
    return n;
  }

  markExtension(sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    rt.meta.extension = true;
    rt.meta.extensionAt = Date.now();
    this.notifyWaiters();
  }

  list(): SessionMeta[] {
    return [...this.runtimes.values()].map((r) => this.snapshotOf(r));
  }

  snapshot(id: string): SessionMeta {
    return this.snapshotOf(this.get(id));
  }

  private snapshotOf(rt: Runtime): SessionMeta {
    return { ...rt.meta, pendingQuestions: [...rt.meta.pendingQuestions] };
  }

  async send(
    id: string,
    message: string,
    mode: "prompt" | "steer" | "followup" = "prompt",
    countInstruction = true,
    opts: { provider?: string; model?: string } = {},
  ): Promise<void> {
    const rt = this.get(id);
    if (rt.meta.status === "error" || rt.meta.status === "stopped") {
      throw new Error(`session ${id} is ${rt.meta.status}`);
    }
    if (opts.model) {
      const provider = opts.provider ?? rt.meta.provider ?? this.config.provider;
      await rt.client.setModel(provider, opts.model).catch(() => undefined);
    }
    if (mode === "steer") await rt.client.steer(message);
    else if (mode === "followup") await rt.client.followUp(message);
    else if (rt.client.isStreaming) await rt.client.prompt(message, "followUp");
    else await rt.client.prompt(message);
    if (countInstruction) {
      rt.meta.orchestratorChars = (rt.meta.orchestratorChars ?? 0) + message.length;
      rt.meta.instructionsSent = (rt.meta.instructionsSent ?? 0) + 1;
    }
    rt.meta.lastActivity = Date.now();
    this.notifyWaiters();
  }

  async wait(ids: string[], until: "settled" | "idle" | "question", timeoutMs: number): Promise<WaitResult> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sessions = ids.map((id) => this.snapshot(id));
      const done =
        until === "question"
          ? sessions.some((s) => s.pendingQuestions.length > 0)
          : sessions.every((s) => s.status !== "working" && s.status !== "starting");
      const terminal = sessions.some((s) => s.status === "error" || s.status === "stopped");
      if (done || terminal) {
        // Make sure fresh cost/context is reflected in the returned snapshot.
        await Promise.all(sessions.map((s) => this.refreshStats(this.get(s.id), true)));
        return { sessions: ids.map((id) => this.snapshot(id)), timedOut: false };
      }
      if (Date.now() >= deadline) return { sessions, timedOut: true };
      await this.sleepWithWake(Math.min(400, Math.max(20, deadline - Date.now())));
    }
  }

  private sleepWithWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      const waiter = () => finish();
      this.waiters.add(waiter);
    });
  }

  async tail(id: string, since?: string, max = 40): Promise<{ entries: any[]; leafId: string | null }> {
    const rt = this.get(id);
    const { entries, leafId } = await rt.client.getEntries(since);
    const sliced = entries.slice(-max);
    if (sliced.length > 0) rt.meta.lastEntryId = leafId ?? rt.meta.lastEntryId;
    return { entries: sliced, leafId };
  }

  async diff(id: string): Promise<DiffSummary> {
    const rt = this.get(id);
    return worktreeDiff(rt.meta.worktree, rt.meta.baseRef);
  }

  async commit(id: string, message: string): Promise<string> {
    const rt = this.get(id);
    return commitAll(rt.meta.worktree, message);
  }

  /** Merge a worker branch into a branch of the main repo (default: its current branch). */
  async merge(id: string, into?: string, noFf = true): Promise<MergeResult> {
    const rt = this.get(id);
    const target = into ?? (await currentBranch(rt.meta.repo));
    const res = await mergeBranch(rt.meta.repo, rt.meta.branch, target, { noFf });
    if (res.ok && !rt.meta.outcome) {
      this.setOutcome(id, (rt.meta.instructionsSent ?? 1) <= 1 ? "success_first" : "success_second");
    }
    return res;
  }

  async push(id: string, remote = "origin", branch?: string): Promise<string> {
    const rt = this.get(id);
    return pushBranch(rt.meta.repo, remote, branch);
  }

  /** Run a shell command inside a worker's worktree (independent verification by Codex). */
  async exec(
    id: string,
    command: string,
    timeoutMs = 600_000,
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    const rt = this.get(id);
    return runCommand(command, rt.meta.worktree, timeoutMs);
  }

  async answer(sessionId: string, requestId: string, response: Partial<UiResponse>): Promise<void> {
    const rt = this.get(sessionId);
    const idx = rt.meta.pendingQuestions.findIndex((q) => q.id === requestId);
    if (idx === -1) throw new Error(`no pending question ${requestId} for session ${sessionId}`);
    const req = rt.meta.pendingQuestions[idx];
    rt.meta.pendingQuestions.splice(idx, 1);
    const payload: UiResponse = { type: "extension_ui_response", id: requestId, ...response };
    if (req.method === "confirm" && payload.confirmed === undefined && payload.cancelled === undefined) {
      payload.confirmed = false;
    }
    rt.client.respondUi(payload);
    rt.meta.orchestratorChars = (rt.meta.orchestratorChars ?? 0) + (payload.value?.length ?? 0);
    this.notifyWaiters();
  }

  async stop(id: string, opts: { removeWorktree?: boolean } = {}): Promise<void> {
    const rt = this.get(id);
    await rt.client.stop();
    rt.meta.status = "stopped";
    this.locks.releaseAll(id);
    this.archive(rt.meta);
    if (opts.removeWorktree) {
      await removeWorktree(rt.meta.repo, rt.meta.worktree, rt.meta.branch).catch(() => {});
    }
    this.notifyWaiters();
    this.scheduleSave();
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) {
      await this.stop(id).catch(() => {});
    }
  }

  // --- locks ----------------------------------------------------------------

  claim(sessionId: string, paths: string[], mode: LockMode): ClaimResult {
    const res = this.locks.claim(sessionId, this.normalizeLockPaths(sessionId, paths), mode);
    if (res.ok) this.scheduleSave();
    return res;
  }

  releaseLocks(sessionId: string, paths?: string[]): number {
    const n = this.locks.release(sessionId, paths ? this.normalizeLockPaths(sessionId, paths) : undefined);
    this.scheduleSave();
    return n;
  }

  /**
   * Locks use a repo-relative key space (the extension sends relative paths). If a caller passes an
   * absolute path inside the session's worktree, strip the prefix so it maps to the same key.
   */
  private normalizeLockPaths(sessionId: string, paths: string[]): string[] {
    const root = this.runtimes.get(sessionId)?.meta.worktree;
    if (!root) return paths;
    return paths.map((p) => {
      if (isAbsolute(p) && (p === root || p.startsWith(root + "/"))) {
        return relative(root, p).split("\\").join("/");
      }
      return p;
    });
  }

  locksList() {
    return this.locks.list();
  }

  // --- mailbox / board ------------------------------------------------------

  postMessage(from: string, to: string, text: string, kind: MessageKind, deliver = true): { id: string; delivered: boolean } {
    const m = this.mailbox.post(from, to, text, kind);
    this.scheduleSave();
    let delivered = false;
    if (deliver) {
      const targets = to === "*" ? [...this.runtimes.keys()] : [to];
      for (const sid of targets) {
        const rt = this.runtimes.get(sid);
        if (!rt || rt.meta.status === "error" || rt.meta.status === "stopped") continue;
        const body = `[coordinator] message from ${from} (${kind}):\n${text}\n\n(Reply with coord_send / coord_board_post if needed.)`;
        if (from === "codex") rt.meta.orchestratorChars = (rt.meta.orchestratorChars ?? 0) + text.length;
        void this.send(sid, body, rt.client.isStreaming ? "steer" : "followup", false).catch(() => {});
        delivered = true;
      }
    }
    return { id: m.id, delivered };
  }

  inbox(sessionId: string, unreadOnly = false) {
    return this.mailbox.inbox(sessionId, { unreadOnly });
  }

  markRead(ids: string[]): void {
    this.mailbox.markRead(ids);
    this.scheduleSave();
  }

  boardPost(board: string, key: string, value: string, from: string) {
    const e = this.board.post(board, key, value, from);
    this.scheduleSave();
    return e;
  }

  boardRead(board?: string, key?: string) {
    return this.board.read(board, key);
  }

  boardLatest(board: string) {
    return this.board.latest(board);
  }

  setOutcome(id: string, outcome: Outcome, note?: string): void {
    const rt = this.get(id);
    rt.meta.outcome = outcome;
    if (note !== undefined) rt.meta.outcomeNote = note;
    const h = this.history.find((x) => x.id === id);
    if (h) {
      h.outcome = outcome;
      if (note !== undefined) h.outcomeNote = note;
    }
    this.notifyWaiters();
  }

  /** Persist a finished/settled session snapshot so the scoreboard survives daemon restarts. */
  private archive(meta: SessionMeta): void {
    const snapshot: SessionMeta = { ...meta, pendingQuestions: [] };
    const idx = this.history.findIndex((h) => h.id === meta.id);
    if (idx >= 0) this.history[idx] = snapshot;
    else this.history.push(snapshot);
    if (this.history.length > 500) this.history = this.history.slice(-500);
  }

  setTestsOwned(id: string, owned: boolean): void {
    const rt = this.get(id);
    rt.meta.testsOwnedByCodex = owned;
    this.notifyWaiters();
  }

  /**
   * Delegation scoreboard: how many delegated workstreams succeeded on the first or second
   * attempt, how many Codex took over after the two-strikes gate, and the percentages.
   */
  async report(): Promise<Record<string, unknown>> {
    const ids = [...this.runtimes.keys()];
    await Promise.all(
      ids.map((id) => {
        const rt = this.runtimes.get(id);
        return rt ? this.refreshStats(rt, true).catch(() => {}) : Promise.resolve();
      }),
    );
    const sessions = this.list();
    const activeTasks = sessions.filter((s) => s.status === "starting" || s.status === "idle" || s.status === "working").length;
    // Merge live sessions with the persisted history (live wins on id collisions).
    const byId = new Map<string, SessionMeta>();
    for (const h of this.history) byId.set(h.id, h);
    for (const s of sessions) byId.set(s.id, s);
    const all = [...byId.values()];
    const counts: Record<Outcome | "unrecorded", number> = {
      success_first: 0,
      success_second: 0,
      taken_over: 0,
      abandoned: 0,
      unrecorded: 0,
    };
    let workerCost = 0;
    let workerOutput = 0;
    const tasks = all.map((s) => {
      counts[(s.outcome ?? "unrecorded") as Outcome | "unrecorded"]++;
      workerCost += s.cost ?? 0;
      workerOutput += s.tokens?.output ?? 0;
      return {
        id: s.id,
        name: s.name,
        status: s.status,
        outcome: s.outcome ?? "unrecorded",
        instructions_sent: s.instructionsSent ?? 0,
        note: s.outcomeNote,
        tests_owned_by_codex: s.testsOwnedByCodex ?? null,
        cost: s.cost,
        output_tokens: s.tokens?.output ?? 0,
      };
    });
    const total = all.length;
    const pct = (n: number) => (total > 0 ? Number(((100 * n) / total).toFixed(1)) : 0);
    const percentages = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, pct(v)]));
    return {
      total_tasks: total,
      active_tasks: activeTasks,
      archived_tasks: this.history.length,
      counts,
      percentages,
      delegated_success_rate: pct(counts.success_first + counts.success_second),
      first_try_rate: pct(counts.success_first),
      take_over_rate: pct(counts.taken_over),
      worker_cost: Number(workerCost.toFixed(4)),
      worker_output_tokens: workerOutput,
      tasks,
      note: "One 'task' = one worker workstream/session. outcomes come from pi_finish (or are auto-recorded by pi_merge). unrecorded means the workstream was never closed with an outcome.",
    };
  }

  /**
   * Aggregate output-discipline metrics.
   *
   * We can measure worker output exactly (pi session stats). Codex's own output tokens are NOT
   * observable here, so orchestrator_instruction_* is a lower bound computed from the instruction
   * text Codex sent through the daemon. Higher worker_output_per_orchestrator_token is better.
   */
  async metrics(): Promise<Record<string, unknown>> {
    const ids = [...this.runtimes.keys()];
    await Promise.all(
      ids.map((id) => {
        const rt = this.runtimes.get(id);
        return rt ? this.refreshStats(rt, true) : Promise.resolve();
      }),
    );
    const workers = ids
      .filter((id) => this.runtimes.has(id))
      .map((id) => {
        const m = this.snapshot(id);
      return {
        id,
        status: m.status,
        provider: m.provider,
        model: m.model,
        output_tokens: m.tokens?.output ?? 0,
        input_tokens: m.tokens?.input ?? 0,
        cache_read_tokens: m.tokens?.cacheRead ?? 0,
        cost: m.cost ?? 0,
        turns: m.turns ?? 0,
        orchestrator_instruction_chars: m.orchestratorChars ?? 0,
        instructions_sent: m.instructionsSent ?? 0,
      };
    });
    const sum = (k: string) => workers.reduce((a: number, w: any) => a + (w[k] as number), 0);
    const workerOutput = sum("output_tokens");
    const orchChars = sum("orchestrator_instruction_chars");
    const orchTokensEst = Math.round(orchChars / 4);
    return {
      workers,
      totals: {
        worker_output_tokens: workerOutput,
        worker_input_tokens: sum("input_tokens"),
        worker_cache_read_tokens: sum("cache_read_tokens"),
        worker_cost: sum("cost"),
        worker_turns: sum("turns"),
        orchestrator_instruction_chars: orchChars,
        orchestrator_instruction_tokens_est: orchTokensEst,
      },
      discipline: {
        worker_output_tokens: workerOutput,
        orchestrator_instruction_tokens_est: orchTokensEst,
        worker_output_per_orchestrator_token:
          orchTokensEst > 0 ? Number((workerOutput / orchTokensEst).toFixed(2)) : null,
        note:
          "Codex's own output tokens are not observable from the daemon; orchestrator_instruction_* is a lower bound. Codex should keep its output to judgment and let workers emit code: a high worker_output_per_orchestrator_token ratio is healthy, and a rising Codex-side cost means it is writing code it should have delegated.",
      },
    };
  }
}

function renderSpec(spec?: DelegationSpec): string {
  if (!spec) return "";
  const lines = [
    "TASK SPEC (coordinator-authored - treat as binding):",
    `Goal: ${spec.goal}`,
    `Scope (ONLY touch these paths): ${spec.scope.join(", ")}`,
  ];
  if (spec.non_goals?.length) lines.push(`Out of scope / do NOT touch: ${spec.non_goals.join(", ")}`);
  if (spec.contracts?.length) lines.push(`Contracts to honor: ${spec.contracts.join("; ")}`);
  if (spec.constraints?.length) lines.push(`Constraints: ${spec.constraints.join("; ")}`);
  if (spec.task_type) lines.push(`Task type: ${spec.task_type}`);
  return lines.join("\n");
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-lc", command], { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(e), timedOut });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(-200_000), stderr: stderr.slice(-50_000), timedOut });
    });
  });
}

function textOf(msg: any): string {
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");
  }
  return "";
}
