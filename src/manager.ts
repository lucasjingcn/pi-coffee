import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { acceptancePath, writeAcceptanceFile } from "./acceptance.js";
import type { Config } from "./config.js";
import { Board, Mailbox, type MessageKind } from "./mailbox.js";
import { LockManager, type ClaimResult, type LockMode } from "./locks.js";
import { resolveRepoIdentity } from "./lock-repo.js";
import { StateStore } from "./state-store.js";
import { PiRpcClient } from "./rpc-client.js";
import type { DelegationSpec, PiEvent, UiRequest, UiResponse } from "./types.js";
import {
  commitAll,
  createWorktree,
  currentBranch,
  deleteMergedBranch,
  isWorktreeClean,
  mergeBranch,
  pruneWorktrees,
  pushBranch,
  removeWorktree,
  resolveRef,
  worktreeDiff,
  type DiffSummary,
  type MergeResult,
  type WorktreeInfo,
} from "./worktree.js";

/**
 * Temporary lock owner used to precheck acceptance reservations. LockManager
 * skips locks whose owner matches the claimant, so claiming acceptance files
 * under the shared "codex" owner would silently ignore another Codex-owned
 * acceptance reservation; a distinct sentinel surfaces it.
 */
const ACCEPTANCE_PRECHECK_OWNER = "__acceptance_precheck__";

/** Workstream outcomes whose branches are eligible for safe cleanup once proven merged. */
const FINISHED_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["success_first", "success_second", "taken_over"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** Whether this session still holds its Codex-owned acceptance lock reservation (released once). */
  acceptanceReserved?: boolean;
  /** Canonical repository identity this session's locks are namespaced under. */
  repoIdentity: string;
}

export interface SpawnOptions {
  task?: string;
  repo?: string;
  name?: string;
  baseRef?: string;
  branch?: string;
  provider?: string;
  model?: string;
  thinking?: string;
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

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export class Coordinator {
  readonly config: Config;

  private runtimes = new Map<string, Runtime>();
  private locks = new LockManager();
  private mailbox = new Mailbox();
  private board = new Board();
  private counter = 0;
  private history: SessionMeta[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private waiters = new Set<() => void>();
  /** Concurrency slots reserved by in-flight spawns that have not yet registered a runtime. */
  private reserved = 0;
  /** Serializes state writes so concurrent saves cannot interleave temp files/renames. */
  private saveChain: Promise<void> = Promise.resolve();
  /** Validated primary/backup store: atomic writes, corruption recovery, contextual errors. */
  private store: StateStore;

  constructor(config: Config) {
    this.config = config;
    this.store = new StateStore(join(config.dataDir, "state.json"));
  }

  async init(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    await mkdir(join(this.config.dataDir, "sessions"), { recursive: true });
    await mkdir(this.config.workspaceRoot, { recursive: true });
    await this.load();
    // Sessions never survive a daemon restart, so any leftover worktree is an orphan.
    await this.sweepOnStartup();
    this.startSweeper();
  }

  // -------------------------------------------------------------------------
  // Worktree cleanup
  // -------------------------------------------------------------------------

  /** Remove finished workers' worktrees left over from a previous run (branches are kept). */
  private async sweepOnStartup(): Promise<void> {
    if (!this.config.autoClean) return;

    const repos = new Set<string>();
    for (const entry of this.history) {
      if (!entry.repo) continue;
      repos.add(entry.repo);
      await this.cleanMeta(entry).catch(() => {});
    }
    for (const repo of repos) await pruneWorktrees(repo).catch(() => {});
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweep().catch(() => {}), 60_000);
    this.sweeper.unref?.();
  }

  /** Periodically stop+clean finished workers that have been idle past the TTL, and evict them. */
  private async sweep(): Promise<void> {
    if (!this.config.autoClean) return;

    const ttlMs = Math.max(1, this.config.worktreeTtlMin) * 60_000;
    const now = Date.now();

    for (const [id, rt] of [...this.runtimes]) {
      if (now - rt.meta.lastActivity < ttlMs) continue;

      const finished = rt.meta.outcome !== undefined && FINISHED_OUTCOMES.has(rt.meta.outcome);
      if (finished && (rt.meta.status === "idle" || rt.meta.status === "working")) {
        await this.stop(id).catch(() => {});
      } else if (rt.meta.status === "stopped") {
        await this.cleanMeta(rt.meta).catch(() => {});
        this.runtimes.delete(id); // already archived at stop(); report uses history
        this.notifyWaiters();
      }
    }
  }

  /**
   * Remove a finished worker's worktree if it exists and is clean. Never deletes
   * branches (gc's merged-only branch cleanup is explicit), never touches dirty
   * worktrees, and leaves unfinished/abandoned outcomes for inspection.
   */
  private async cleanMeta(meta: SessionMeta): Promise<boolean> {
    const isFinished = meta.outcome !== undefined && FINISHED_OUTCOMES.has(meta.outcome);
    if (!isFinished || !meta.worktree || !existsSync(meta.worktree)) return false;
    if (!(await isWorktreeClean(meta.worktree))) return false;

    await removeWorktree(meta.repo, meta.worktree).catch(() => {});
    if (existsSync(meta.worktree)) throw new Error(`worktree cleanup failed: ${meta.worktree}`);
    return true;
  }

  /**
   * Manual cleanup: stop+clean every finished, non-running worker and evict it
   * from memory, then safely delete branches for finished workstreams (including
   * historical ones whose worktree is already gone) whose tip is an ancestor of
   * the repo's current HEAD. Branches are deduplicated per repo+branch and
   * retained when any session for them is unfinished, active, or has a dirty
   * worktree. Nothing here depends on the legacy `deleteBranches` force setting.
   */
  async gc(): Promise<Record<string, unknown>> {
    let cleaned = 0;
    let evicted = 0;
    const cleanupErrors: { session_id: string; reason: string }[] = [];

    for (const [id, rt] of [...this.runtimes]) {
      if (!rt.meta.outcome || rt.meta.status === "working" || rt.meta.status === "starting") continue;

      const hadWorktree = !!rt.meta.worktree && existsSync(rt.meta.worktree);
      try {
        if (rt.meta.status !== "stopped") await this.stop(id);
        await this.cleanMeta(rt.meta);
      } catch (error) {
        cleanupErrors.push({ session_id: id, reason: error instanceof Error ? error.message : String(error) });
        if (rt.meta.status !== "stopped") continue;
      }

      if (hadWorktree && !existsSync(rt.meta.worktree)) cleaned++;
      this.runtimes.delete(id);
      evicted++;
    }

    let branches: {
      deleted: string[];
      retained: { repo: string; branch: string; reason: string }[];
      failure?: string;
    };
    try {
      branches = await this.gcBranches();
    } catch (error) {
      branches = { deleted: [], retained: [], failure: error instanceof Error ? error.message : String(error) };
    }

    this.notifyWaiters();
    this.scheduleSave();

    return {
      worktrees_cleaned: cleaned,
      branches_deleted: branches.deleted.length,
      branches_retained: branches.retained,
      ...(cleanupErrors.length ? { cleanup_errors: cleanupErrors } : {}),
      ...(branches.failure ? { branches_error: branches.failure } : {}),
      sessions_evicted: evicted,
      remaining_live: this.runtimes.size,
    };
  }

  private async gcBranches(): Promise<{
    deleted: string[];
    retained: { repo: string; branch: string; reason: string }[];
  }> {
    interface Candidate {
      repo: string;
      branch: string;
      blocked?: string;
    }

    const byRepoBranch = new Map<string, Candidate>();
    const identities = new Map<string, string>();
    const metas: { meta: SessionMeta; live: boolean }[] = [
      ...this.history.map((meta) => ({ meta, live: false })),
      ...[...this.runtimes.values()].map((rt) => ({ meta: rt.meta, live: true })),
    ];

    for (const { meta, live } of metas) {
      if (!meta.repo || !meta.branch) continue;

      let identity = identities.get(meta.repo);
      let identityError: string | undefined;
      if (!identity) {
        try {
          identity = resolveRepoIdentity(meta.repo);
          identities.set(meta.repo, identity);
        } catch (error) {
          if (live && meta.status !== "stopped") throw error;
          identity = JSON.stringify(["unresolved", meta.repo]);
          identityError = error instanceof Error ? error.message : String(error);
        }
      }

      const key = JSON.stringify([identity, meta.branch]);
      let candidate = byRepoBranch.get(key);
      if (!candidate) {
        candidate = { repo: meta.repo, branch: meta.branch, blocked: identityError };
        byRepoBranch.set(key, candidate);
      }
      if (candidate.blocked) continue;

      if (!meta.outcome || !FINISHED_OUTCOMES.has(meta.outcome)) {
        candidate.blocked = `outcome ${meta.outcome ?? "unrecorded"}`;
        continue;
      }
      if (live && meta.status !== "stopped") {
        candidate.blocked = "active session";
        continue;
      }
      // Missing worktrees must not block the branch check; only an existing dirty one does.
      if (meta.worktree && existsSync(meta.worktree) && !(await isWorktreeClean(meta.worktree))) {
        candidate.blocked = "dirty worktree";
      }
    }

    const deleted: string[] = [];
    const retained: { repo: string; branch: string; reason: string }[] = [];

    for (const candidate of byRepoBranch.values()) {
      if (candidate.blocked) {
        retained.push({ repo: candidate.repo, branch: candidate.branch, reason: candidate.blocked });
        continue;
      }

      const result = await deleteMergedBranch(candidate.repo, candidate.branch).catch((error) => ({
        branch: candidate.branch,
        deleted: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      if (result.deleted) deleted.push(result.branch);
      else retained.push({ repo: candidate.repo, branch: candidate.branch, reason: result.reason });
    }

    return { deleted, retained };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    const { state } = await this.store.load();
    this.counter = state.counter;
    // Locks are held by live sessions, and sessions never survive a daemon
    // restart. Drop any persisted locks instead of resurrecting orphaned locks
    // that would block new spawns.
    this.locks = new LockManager();
    this.mailbox.import(state.mailbox);
    this.board.import(state.board);
    // Any snapshot that was live when the daemon died is now stopped history;
    // completed outcomes and tests-ownership metadata on it are preserved as-is.
    this.history = state.history.map((entry) =>
      entry.status === "starting" || entry.status === "idle" || entry.status === "working"
        ? { ...entry, status: "stopped", pendingQuestions: [] }
        : entry,
    );
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // Background failures are caught only here: log context, never the payload,
      // and never an unhandled rejection. An explicit flush()/stopAll() still
      // rejects on a failed newest save.
      void this.save().catch((error) => this.reportSaveError("background save", error));
    }, 500);
  }

  /** Persist the latest state, serializing writes so concurrent saves cannot interleave. */
  private save(): Promise<void> {
    const run = this.saveChain.then(() => this.writeState());
    // Keep the chain usable after a failure so a later save (e.g. after FS recovery) can succeed.
    this.saveChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeState(): Promise<void> {
    const data = {
      counter: this.counter,
      locks: this.locks.export(),
      mailbox: this.mailbox.export(),
      board: this.board.export(),
      // Include live snapshots so a crash/restart can report in-flight work as
      // stopped history while preserving completed outcomes and tests-ownership metadata.
      history: this.mergedHistory(),
    };
    await this.store.write(data);
  }

  /** Context-only stderr diagnostic: operation, file and error code, never serialized state. */
  private reportSaveError(operation: string, error: unknown): void {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[state] ${operation} failed for ${this.store.path}${code ? ` [${code}]` : ""}: ${detail}`);
  }

  /** Persisted history overlaid with the live sessions (live wins on id collisions). */
  private mergedHistory(): SessionMeta[] {
    const byId = new Map<string, SessionMeta>();
    for (const entry of this.history) byId.set(entry.id, entry);
    for (const rt of this.runtimes.values()) {
      byId.set(rt.meta.id, { ...rt.meta, pendingQuestions: [] });
    }

    let all = [...byId.values()];
    if (all.length > 500) all = all.slice(-500);
    return all;
  }

  /** Cancel any pending debounced save and wait for the freshest state to hit disk. */
  private async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await this.save();
    } catch (error) {
      // Explicit shutdown/persistence requests must surface the failure, not swallow it.
      this.reportSaveError("save", error);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Sessions: lifecycle
  // -------------------------------------------------------------------------

  private nextId(): string {
    if (this.counter >= Number.MAX_SAFE_INTEGER) {
      throw new Error("session id space exhausted");
    }
    return `s${++this.counter}`;
  }

  private notifyWaiters(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  async spawn(opts: SpawnOptions = {}): Promise<SessionMeta> {
    // Reserve a concurrency slot synchronously, before the first await, so two
    // concurrent spawns cannot both pass the cap check and oversubscribe the
    // daemon. The slot is transferred to the runtime once it is registered;
    // until then, every failure path releases it here.
    this.reserveSlot();
    const slot = { transferred: false };
    try {
      return await this.spawnSession(opts, slot);
    } finally {
      if (!slot.transferred) this.releaseReservation();
    }
  }

  private async spawnSession(opts: SpawnOptions, slot: { transferred: boolean }): Promise<SessionMeta> {
    const repo = opts.repo ?? this.config.defaultRepo;
    if (!repo) {
      throw new Error("repo is required: pass repo to pi_spawn, or set PI_MCP_DEFAULT_REPO for the daemon");
    }
    if (!existsSync(repo)) {
      throw new Error(`repo path does not exist: ${repo}`);
    }

    // Resolve the canonical repository identity before reserving any lock.
    // Symlinks, subdirectories and linked worktrees of the same repo collapse to
    // one namespace; separate repos never share.
    let repoIdentity: string;
    try {
      repoIdentity = resolveRepoIdentity(repo);
    } catch (e) {
      throw new Error(
        `repo is not a usable git repository: ${repo} (${e instanceof Error ? e.message : String(e)})`,
      );
    }

    const id = this.nextId();
    const name = opts.name ?? `${id}-${(opts.task ?? "task").slice(0, 40)}`;
    const branch = opts.branch ?? `pi/${id}`;
    const dir = join(this.config.workspaceRoot, id);
    const requestedBase = opts.baseRef ?? this.config.defaultBaseRef;
    const acceptancePaths = (opts.acceptanceFiles ?? []).map((f) => acceptancePath(f.path));
    let acceptanceReserved = false;

    // Scope pre-claim & overlap pre-check: reserve the declared scope before
    // creating anything, so two workstreams with overlapping files are rejected
    // at dispatch instead of mid-flight.
    const scope = opts.spec?.scope ?? [];
    if (scope.length) {
      const pre = this.locks.claim(id, scope, "rw", repoIdentity);
      if (!pre.ok) {
        this.locks.releaseAll(id, repoIdentity);
        throw new Error(
          `scope conflicts with active sessions: ${pre.conflicts.map((c) => `${c.path} @ ${c.sessionId}`).join(", ")}`,
        );
      }
    }

    // Reserve Codex-owned acceptance files before creating anything. LockManager
    // skips same-owner collisions, so precheck under a temporary distinct owner
    // first: that surfaces overlaps with any existing lock (including another
    // Codex-held acceptance reservation), then re-claim under the shared "codex"
    // owner so the worker never owns its own tests.
    if (acceptancePaths.length) {
      const pre = this.locks.claim(ACCEPTANCE_PRECHECK_OWNER, acceptancePaths, "rw", repoIdentity);
      if (!pre.ok) {
        this.locks.releaseAll(id, repoIdentity);
        this.scheduleSave();
        throw new Error(
          `acceptance files conflict with active locks: ${pre.conflicts.map((c) => `${c.path} @ ${c.sessionId}`).join(", ")}`,
        );
      }
      this.locks.release(ACCEPTANCE_PRECHECK_OWNER, acceptancePaths, repoIdentity);

      const acc = this.locks.claim("codex", acceptancePaths, "rw", repoIdentity);
      if (!acc.ok) {
        // Not expected (no await between precheck and claim), but never leak partial reservations.
        this.locks.releaseAll(id, repoIdentity);
        this.scheduleSave();
        throw new Error(
          `acceptance files conflict with active locks: ${acc.conflicts.map((c) => `${c.path} @ ${c.sessionId}`).join(", ")}`,
        );
      }
      acceptanceReserved = true;
    }

    // Resolve the requested base to a concrete SHA and create the worktree on
    // that same SHA in one guarded block. A failed resolve must propagate (no
    // symbolic-ref fallback) and release locks.
    let baseSha!: string;
    let wt!: WorktreeInfo;
    try {
      baseSha = await resolveRef(repo, requestedBase);
      wt = await createWorktree({ repo, dir, branch, baseRef: baseSha });
    } catch (e) {
      this.releaseSpawnReservations(id, acceptancePaths, acceptanceReserved, repoIdentity);
      throw e;
    }

    // Test-first delegation: write Codex-authored acceptance files BEFORE the worker starts.
    try {
      for (const f of opts.acceptanceFiles ?? []) {
        await writeAcceptanceFile(wt.dir, f.path, f.content);
      }
    } catch (e) {
      this.releaseSpawnReservations(id, acceptancePaths, acceptanceReserved, repoIdentity);
      await removeWorktree(repo, wt.dir).catch(() => {});
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
      thinking: opts.thinking ?? this.config.thinking,
      name,
      sessionDir: join(this.config.dataDir, "sessions", id),
      extensionPath: this.config.extensionPath,
      env: {
        PI_COORD_URL: `http://${this.config.host}:${this.config.port}`,
        PI_COORD_SESSION_ID: id,
        PI_COORD_TOKEN: this.config.token,
      },
    });

    const rt: Runtime = { meta, client, lastNotifiedQuestionIds: new Set(), acceptanceReserved, repoIdentity };
    this.runtimes.set(id, rt);
    // The runtime now occupies the slot: stop counting it in `reserved` so it is
    // not double-counted by activeCount() while the child is starting.
    slot.transferred = true;
    this.releaseReservation();
    this.wireEvents(rt);

    try {
      await client.start();
      meta.status = "idle";
    } catch (e) {
      meta.status = "error";
      meta.error = String(e);
      // A failed startup must not leak the child process or any reservations.
      await client.stop().catch(() => {});
      this.releaseSpawnReservations(id, acceptancePaths, acceptanceReserved, repoIdentity);
      rt.acceptanceReserved = false;
      this.scheduleSave();
      this.notifyWaiters();
      throw e;
    }

    this.scheduleSave();
    this.notifyWaiters();

    // Compose the first instruction from the prompt, the spec and the acceptance note.
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
    rt.client.on("event", (event: PiEvent) => {
      rt.meta.lastActivity = Date.now();
      switch (event.type) {
        case "agent_start":
          rt.meta.status = "working";
          break;
        case "agent_settled":
          rt.meta.status = "idle";
          void this.refreshStats(rt, true);
          break;
        case "message_end": {
          const msg = event.message;
          if (msg?.role === "assistant") {
            const text = textOf(msg);
            if (text) rt.meta.lastText = text;
          }
          break;
        }
        case "entry_appended":
          if (event.entry?.id) rt.meta.lastEntryId = event.entry.id;
          break;
        default:
          break;
      }
      this.notifyWaiters();
    });

    rt.client.on("ui_request", (request: UiRequest) => {
      // Fire-and-forget UI updates never block the conversation.
      if (
        request.method === "notify" ||
        request.method === "setStatus" ||
        request.method === "setWidget" ||
        request.method === "setTitle" ||
        request.method === "set_editor_text"
      ) {
        return;
      }
      if (!rt.meta.pendingQuestions.some((q) => q.id === request.id)) {
        rt.meta.pendingQuestions.push(request);
      }
      this.notifyWaiters();
    });

    rt.client.on("exit", () => {
      if (rt.meta.status !== "stopped") {
        rt.meta.status = "error";
        rt.meta.error = rt.client.getStderr().slice(-2000) || "pi rpc exited";
      }
      this.locks.releaseAll(rt.meta.id, rt.repoIdentity);
      this.notifyWaiters();
      this.scheduleSave();
    });
  }

  private async refreshStats(rt: Runtime, includeCost = false): Promise<void> {
    try {
      const state = await rt.client.getState();
      rt.meta.provider = state.model?.provider;
      rt.meta.model = state.model?.id;
      if (typeof state.sessionName === "string") rt.meta.name = state.sessionName;

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

  /** Public: number of active workers (for the parallelism advisory). */
  activeWorkers(): number {
    return this.activeCount();
  }

  /** Claim a concurrency slot synchronously; throws when the cap (including in-flight spawns) is hit. */
  private reserveSlot(): void {
    if (this.activeCount() + this.reserved >= this.config.maxSessions) {
      throw new Error(`max sessions reached (${this.config.maxSessions})`);
    }
    this.reserved++;
  }

  private releaseReservation(): void {
    if (this.reserved > 0) this.reserved--;
  }

  /** Undo all lock reservations made while starting a session that then failed. */
  private releaseSpawnReservations(
    id: string,
    acceptancePaths: string[],
    acceptanceReserved: boolean,
    repoIdentity: string,
  ): void {
    this.locks.releaseAll(id, repoIdentity);
    if (acceptanceReserved && acceptancePaths.length) this.locks.release("codex", acceptancePaths, repoIdentity);
    this.scheduleSave();
  }

  markExtension(sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    rt.meta.extension = true;
    rt.meta.extensionAt = Date.now();
    this.notifyWaiters();
  }

  list(): SessionMeta[] {
    return [...this.runtimes.values()].map((rt) => this.snapshotOf(rt));
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

  // -------------------------------------------------------------------------
  // Sessions: operations
  // -------------------------------------------------------------------------

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
    const result = await mergeBranch(rt.meta.repo, rt.meta.branch, target, { noFf });

    // A successful merge auto-records the outcome unless one was set explicitly.
    if (result.ok && !rt.meta.outcome) {
      this.setOutcome(id, (rt.meta.instructionsSent ?? 1) <= 1 ? "success_first" : "success_second");
    }
    return result;
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
    const index = rt.meta.pendingQuestions.findIndex((q) => q.id === requestId);
    if (index === -1) throw new Error(`no pending question ${requestId} for session ${sessionId}`);

    const request = rt.meta.pendingQuestions[index];
    rt.meta.pendingQuestions.splice(index, 1);

    const payload: UiResponse = { type: "extension_ui_response", id: requestId, ...response };
    if (request.method === "confirm" && payload.confirmed === undefined && payload.cancelled === undefined) {
      payload.confirmed = false;
    }
    rt.client.respondUi(payload);
    rt.meta.orchestratorChars = (rt.meta.orchestratorChars ?? 0) + (payload.value?.length ?? 0);
    this.notifyWaiters();
  }

  async stop(id: string, opts: { removeWorktree?: boolean; deleteBranch?: boolean } = {}): Promise<void> {
    const rt = this.get(id);
    await rt.client.stop();
    rt.meta.status = "stopped";
    rt.meta.lastActivity = Date.now();
    this.locks.releaseAll(id, rt.repoIdentity);

    // Also drop the Codex-held locks on this worker's acceptance files, or they
    // leak forever. Scoped to this worker's repository namespace so stopping A
    // never releases B's codex locks. Only release once: a failed startup already
    // released them, and a newer worker may have since re-acquired the same path
    // under "codex".
    if (rt.acceptanceReserved && rt.meta.acceptance?.files?.length) {
      this.locks.release("codex", rt.meta.acceptance.files, rt.repoIdentity);
      rt.acceptanceReserved = false;
    }

    this.archive(rt.meta);

    if (opts.removeWorktree) {
      // Explicit request: remove even if dirty.
      const deleteBranch = opts.deleteBranch ?? this.config.deleteBranches;
      await removeWorktree(rt.meta.repo, rt.meta.worktree, deleteBranch ? rt.meta.branch : undefined).catch(() => {});
    } else if (this.config.autoClean) {
      // Safe auto-clean: only finished + clean worktrees, branch kept.
      await this.cleanMeta(rt.meta).catch(() => {});
    }

    this.notifyWaiters();
    this.scheduleSave();
  }

  async stopAll(): Promise<void> {
    // Stop periodic work first so no timer can re-dirty state after the final flush.
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    for (const id of [...this.runtimes.keys()]) {
      await this.stop(id).catch(() => {});
    }
    await this.flush();
  }

  // -------------------------------------------------------------------------
  // Locks
  // -------------------------------------------------------------------------

  claim(sessionId: string, paths: string[], mode: LockMode, repo?: string): ClaimResult {
    const namespace = this.namespaceFor(sessionId, repo);
    const result = this.locks.claim(sessionId, this.normalizeLockPaths(sessionId, paths), mode, namespace);
    if (result.ok) this.scheduleSave();
    return result;
  }

  releaseLocks(sessionId: string, paths?: string[], repo?: string): number {
    const namespace = this.namespaceFor(sessionId, repo);
    const released = this.locks.release(
      sessionId,
      paths ? this.normalizeLockPaths(sessionId, paths) : undefined,
      namespace,
    );
    this.scheduleSave();
    return released;
  }

  /**
   * Lock namespace for a claim/release. A known worker always derives its own
   * repository identity and cannot override it. A manual claimant (e.g. "codex")
   * may select an explicit repo, else the configured default applies; an unknown
   * claimant with no resolvable repo is an error rather than silently falling
   * into a global namespace.
   */
  private namespaceFor(sessionId: string, repo?: string): string {
    const rt = this.runtimes.get(sessionId);
    if (rt) return rt.repoIdentity;

    const target = repo ?? this.config.defaultRepo;
    if (!target) {
      throw new Error(
        `cannot resolve repository for manual claimant "${sessionId}": pass repo or configure PI_MCP_DEFAULT_REPO`,
      );
    }
    try {
      return resolveRepoIdentity(target);
    } catch (e) {
      throw new Error(
        `cannot resolve repository for manual claimant "${sessionId}" from ${target}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Locks use a repo-relative key space (the extension sends relative paths). If
   * a caller passes an absolute path inside the session's worktree, strip the
   * prefix so it maps to the same key.
   */
  private normalizeLockPaths(sessionId: string, paths: string[]): string[] {
    const root = this.runtimes.get(sessionId)?.meta.worktree;
    if (!root) return paths;

    return paths.map((path) => {
      if (isAbsolute(path) && (path === root || path.startsWith(root + "/"))) {
        return relative(root, path).split("\\").join("/");
      }
      return path;
    });
  }

  locksList() {
    return this.locks.list();
  }

  // -------------------------------------------------------------------------
  // Mailbox and board
  // -------------------------------------------------------------------------

  postMessage(from: string, to: string, text: string, kind: MessageKind, deliver = true): { id: string; delivered: boolean } {
    const message = this.mailbox.post(from, to, text, kind);
    this.scheduleSave();

    let delivered = false;
    if (deliver) {
      const targets = to === "*" ? [...this.runtimes.keys()] : [to];
      for (const sid of targets) {
        const rt = this.runtimes.get(sid);
        if (!rt || rt.meta.status === "error" || rt.meta.status === "stopped") continue;

        const body = `[coordinator] message from ${from} (${kind}):\n${text}\n\n(Reply with coord_send / coord_board_post if needed.)`;
        if (from === "codex") rt.meta.orchestratorChars = (rt.meta.orchestratorChars ?? 0) + text.length;

        // Deliver immediately, then ack only on success so a failed injection is
        // retried by polling instead of being silently dropped.
        void this.send(sid, body, rt.client.isStreaming ? "steer" : "followup", false)
          .then(() => this.markRead([message.id], sid))
          .catch(() => {});
        delivered = true;
      }
    }
    return { id: message.id, delivered };
  }

  inbox(sessionId: string, unreadOnly = false) {
    return this.mailbox.inbox(sessionId, { unreadOnly });
  }

  markRead(ids: string[], sessionId?: string): void {
    this.mailbox.markRead(ids, sessionId);
    this.scheduleSave();
  }

  boardPost(board: string, key: string, value: string, from: string) {
    const entry = this.board.post(board, key, value, from);
    this.scheduleSave();
    return entry;
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

    const historic = this.history.find((entry) => entry.id === id);
    if (historic) {
      historic.outcome = outcome;
      if (note !== undefined) historic.outcomeNote = note;
    }

    this.scheduleSave();
    this.notifyWaiters();
  }

  /** Persist a finished/settled session snapshot so the scoreboard survives daemon restarts. */
  private archive(meta: SessionMeta): void {
    const snapshot: SessionMeta = { ...meta, pendingQuestions: [] };
    const index = this.history.findIndex((entry) => entry.id === meta.id);
    if (index >= 0) this.history[index] = snapshot;
    else this.history.push(snapshot);
    if (this.history.length > 500) this.history = this.history.slice(-500);
  }

  setTestsOwned(id: string, owned: boolean): void {
    const rt = this.get(id);
    rt.meta.testsOwnedByCodex = owned;
    const historic = this.history.find((entry) => entry.id === id);
    if (historic) historic.testsOwnedByCodex = owned;
    this.scheduleSave();
    this.notifyWaiters();
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  /**
   * Delegation scoreboard: how many delegated workstreams succeeded on the first
   * or second attempt, how many Codex took over after the two-strikes gate, and
   * the percentages.
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
    const activeTasks = sessions.filter(
      (s) => s.status === "starting" || s.status === "idle" || s.status === "working",
    ).length;

    // Merge live sessions with the persisted history (live wins on id collisions).
    const byId = new Map<string, SessionMeta>();
    for (const entry of this.history) byId.set(entry.id, entry);
    for (const session of sessions) byId.set(session.id, session);
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

    const tasks = all.map((session) => {
      counts[(session.outcome ?? "unrecorded") as Outcome | "unrecorded"]++;
      workerCost += session.cost ?? 0;
      workerOutput += session.tokens?.output ?? 0;
      return {
        id: session.id,
        name: session.name,
        status: session.status,
        outcome: session.outcome ?? "unrecorded",
        instructions_sent: session.instructionsSent ?? 0,
        note: session.outcomeNote,
        tests_owned_by_codex: session.testsOwnedByCodex ?? null,
        cost: session.cost,
        output_tokens: session.tokens?.output ?? 0,
      };
    });

    const total = all.length;
    const pct = (n: number) => (total > 0 ? Number(((100 * n) / total).toFixed(1)) : 0);
    const percentages = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, pct(value)]));

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
   * We can measure worker output exactly (pi session stats). Codex's own output
   * tokens are NOT observable here, so orchestrator_instruction_* is a lower
   * bound computed from the instruction text Codex sent through the daemon.
   * Higher worker_output_per_orchestrator_token is better.
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
        const meta = this.snapshot(id);
        return {
          id,
          status: meta.status,
          provider: meta.provider,
          model: meta.model,
          output_tokens: meta.tokens?.output ?? 0,
          input_tokens: meta.tokens?.input ?? 0,
          cache_read_tokens: meta.tokens?.cacheRead ?? 0,
          cost: meta.cost ?? 0,
          turns: meta.turns ?? 0,
          orchestrator_instruction_chars: meta.orchestratorChars ?? 0,
          instructions_sent: meta.instructionsSent ?? 0,
        };
      });

    const sum = (key: string) => workers.reduce((acc: number, worker: any) => acc + (worker[key] as number), 0);
    const workerOutput = sum("output_tokens");
    const orchestratorChars = sum("orchestrator_instruction_chars");
    const orchestratorTokensEst = Math.round(orchestratorChars / 4);

    return {
      workers,
      totals: {
        worker_output_tokens: workerOutput,
        worker_input_tokens: sum("input_tokens"),
        worker_cache_read_tokens: sum("cache_read_tokens"),
        worker_cost: sum("cost"),
        worker_turns: sum("turns"),
        orchestrator_instruction_chars: orchestratorChars,
        orchestrator_instruction_tokens_est: orchestratorTokensEst,
      },
      discipline: {
        worker_output_tokens: workerOutput,
        orchestrator_instruction_tokens_est: orchestratorTokensEst,
        worker_output_per_orchestrator_token:
          orchestratorTokensEst > 0 ? Number((workerOutput / orchestratorTokensEst).toFixed(2)) : null,
        note:
          "Codex's own output tokens are not observable from the daemon; orchestrator_instruction_* is a lower bound. Codex should keep its output to judgment and let workers emit code: a high worker_output_per_orchestrator_token ratio is healthy, and a rising Codex-side cost means it is writing code it should have delegated.",
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

/** Render a structured delegation spec into the binding block sent to a worker. */
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

/**
 * Run a shell command with a hard timeout. On POSIX the command runs in its own
 * process group so a timeout can kill the whole tree, not just the shell.
 */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const grouped = process.platform !== "win32";
    const proc = spawn("bash", ["-lc", command], { cwd, env: process.env, detached: grouped });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (grouped && proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        /* process already exited */
      }
      // Descendants that detached themselves must not keep this request's pipes open forever.
      proc.stdout?.destroy();
      proc.stderr?.destroy();
    }, timeoutMs);

    // Cap retained output so a chatty command cannot exhaust memory.
    proc.stdout?.on("data", (d: Buffer) => (stdout = (stdout + d.toString("utf8")).slice(-200_000)));
    proc.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-50_000)));

    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(error), timedOut });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(-200_000), stderr: stderr.slice(-50_000), timedOut });
    });
  });
}

/** Extract the text portion of a pi message content block. */
function textOf(msg: any): string {
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  }
  return "";
}
