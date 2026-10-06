import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, createReadStream, readdirSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { acceptancePath, writeAcceptanceFile } from "./acceptance.js";
import type { Config } from "./config.js";
import { Board, Mailbox, type MessageKind } from "./mailbox.js";
import { LockManager, type ClaimResult, type LockMode, type Lock } from "./locks.js";
import { resolveRepoIdentity } from "./lock-repo.js";
import { captureWorkerProcess, stopOwnedWorker, type WorkerProcessIdentity } from "./worker-process.js";
import { ControlVault } from "./control-vault.js";
import { StateStore } from "./state-store.js";
import { acceptanceHashes, checkChanges, IntegrationGate, normalizedScope, type Verification, type IntegrationRecord } from "./integration.js";
import { summarizeCostEvidence, validateCostRecord, type OrchestratorCostRecord } from "./cost-evidence.js";
import { PiRpcClient } from "./rpc-client.js";
import { prepareWorkerAgentDir } from "./worker-agent-dir.js";
import type { DelegationSpec, PiEvent, UiRequest, UiResponse } from "./types.js";
import { WORKSTREAM_PURPOSES, type WorkstreamPurpose } from "./types.js";
import { validateReviewSpec, validateCandidateReview, type CandidateReview, type CandidateReviewInput } from "./candidate-review.js";
import { appendWorkerEvent, logLine, type WorkerEventKind } from "./log.js";
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

/**
 * Bulk evidence kept for a session that can no longer be resumed. A session whose
 * worktree and transcript are both gone cannot be re-verified, re-merged or
 * resumed, so its long strings only make state.json grow: keep a tail for context.
 */
const RECLAIM_LAST_TEXT_CHARS = 500;
const RECLAIM_OUTPUT_CHARS = 2_000;

/** Retention for a stopped worker's transcript directory (48 hours). */
const SESSION_DIR_TTL_MS = 48 * 60 * 60 * 1000;

/** Minimum interval between mid-run turns/tokens refreshes for one worker. */
const STATS_REFRESH_THROTTLE_MS = 15_000;

/**
 * Tool-result text a coordinator-guarded tool call reports when the worker
 * extension blocks it. Every marker comes from the extension's block reasons;
 * a guard block is counted apart from the tool's own errors.
 */
const GUARD_BLOCK_MARKERS = [
  "Write target must be inside the worker worktree",
  "Recognized shell write target escapes the worker worktree",
  "File is claimed by another worker",
  "Coordinator could not authorize the write",
] as const;

/** Flatten a transcript `toolResult` message into searchable text. */
function toolResultText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("\n");
}

/** True when a failed toolResult is the coordination guard blocking a write. */
function isGuardBlock(message: any): boolean {
  const text = toolResultText(message);
  return GUARD_BLOCK_MARKERS.some((marker) => text.includes(marker));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionStatus = "starting" | "idle" | "working" | "error" | "stopping" | "stopped";

export type Outcome = "success_first" | "success_second" | "taken_over" | "abandoned";

export const HANDOFF_KINDS = ["provider_wait", "provider_timeout", "provider_error", "worker_exited", "shutdown_failed", "awaiting_acceptance", "owner_timeout"] as const;
export interface WorkerHandoff {
  id: string;
  kind: typeof HANDOFF_KINDS[number];
  at: number;
  safeToTakeOver: boolean;
  locksReleased: boolean;
  action: "wait_or_stop" | "accept_and_finish" | "take_over" | "resolve_shutdown";
}

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
  /** pi thinking level the worker is running at; resume reuses it unless overridden. */
  thinking?: string;
  pendingQuestions: UiRequest[];
  error?: string;
  /** Assistant turns seen for this session. */
  turns?: number;
  /** When turns/tokens were last read from the worker; absent/null means never. */
  statsAt?: number;
  /** Number of instructions Codex has sent to this session (initial + corrections). */
  instructionsSent?: number;
  /** Final disposition of this workstream. */
  outcome?: Outcome;
  outcomeNote?: string;
  /**
   * Set once a session that can no longer be resumed has had its control credential
   * deleted and its bulk evidence trimmed, so the sweeper never repeats the work.
   */
  reclaimed?: { at: number; credential: boolean; fields: string[] };
  /** Whether the acceptance test was authored/owned by Codex (spec-derived) rather than the worker. */
  testsOwnedByCodex?: boolean;
  /** Coordinator-authored acceptance files written into the worktree before the worker starts. */
  acceptance?: { files: string[]; command?: string; hashes?: Record<string, string> };
  verification?: Verification;
  integration?: IntegrationRecord;
  /** Orchestrator acceptance of a settled, unchanged read-only review/investigation. */
  reviewAcceptance?: { acceptedAt: number; workerSha: string; note: string };
  /** Structured orchestrator review bound to one exact verification candidate. */
  candidateReview?: CandidateReview;
  /** Structured delegation spec used to spawn this workstream. */
  spec?: DelegationSpec;
  /** Characters Codex sent to this worker through the daemon (lower bound on orchestrator output). */
  orchestratorChars?: number;
  /** Set once the worker-side coordinator extension checked in. */
  extension?: boolean;
  extensionAt?: number;
  handoff?: WorkerHandoff;
  /** True until the owned process group/tree is proven stopped. Survives daemon crashes. */
  shutdownUnconfirmed?: boolean;
  workerProcess?: WorkerProcessIdentity;
  lockRepoIdentity?: string;
  heldLocks?: Lock[];
  /** SHA-256 of the control key; credentials remain separate from reports/history. */
  controlKeyHash?: string;
  /** Shared scope capability hash for workers intentionally grouped by one chat. */
  scopeKeyHash?: string;
}

interface Runtime {
  lastProgressAt?: number;
  activeTools?: Set<string>;
  providerFailed?: boolean;
  stopping?: Promise<void>;
  meta: SessionMeta;
  client: PiRpcClient;
  lastNotifiedQuestionIds: Set<string>;
  /** Whether this session still holds its Codex-owned acceptance lock reservation (released once). */
  acceptanceReserved?: boolean;
  /** Throttle clock for mid-run stats refreshes triggered by message_end. */
  lastStatsRefreshAt?: number;
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
  controlKeyHash?: string;
  scopeKeyHash?: string;
  controlKey?: string;
  scopeKey?: string;
}

export interface ResumeOptions {
  /** Optional first instruction after resuming; the original contract is not re-sent. */
  prompt?: string;
  /** Override the recorded/last-known model; defaults to the session's own model, then the daemon default. */
  provider?: string;
  model?: string;
  thinking?: string;
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
  private workerTokens = new Map<string, string>();
  private saveTimer: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private healthChecking = false;
  private vault: ControlVault;
  private waiters = new Set<() => void>();
  /** Concurrency slots reserved by in-flight spawns that have not yet registered a runtime. */
  private reserved = 0;
  /** Serializes state writes so concurrent saves cannot interleave temp files/renames. */
  private saveChain: Promise<void> = Promise.resolve();
  /** Validated primary/backup store: atomic writes, corruption recovery, contextual errors. */
  private store: StateStore;
  private integrationGate = new IntegrationGate();
  private busyRepos = new Set<string>();
  private dispatchingRepos = new Map<string, number>();
  private orchestratorCosts: OrchestratorCostRecord[] = [];

  constructor(config: Config) {
    this.config = config;
    this.vault = new ControlVault(config.dataDir);
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
    this.healthTimer = setInterval(() => void this.checkWorkerHealth().catch(() => {}),
      Math.min(5000, this.config.workerWarnMs));
    this.healthTimer.unref?.();
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
      await this.cleanSessionDir(entry).catch(() => {});
    }
    for (const repo of repos) await pruneWorktrees(repo).catch(() => {});
    await this.sweepFinalRetention().catch(() => {});
    await this.reclaimStale().catch(() => {});
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
        await this.cleanSessionDir(rt.meta).catch(() => {});
        // Only drop the registration this sweep decided about: a resume may have
        // replaced it with a live runtime while the cleanups above were awaited.
        if (this.runtimes.get(id) === rt) this.runtimes.delete(id); // already archived at stop(); report uses history
        this.notifyWaiters();
      }
    }
    await this.sweepFinalRetention(now).catch(() => {});
    await this.reclaimStale().catch(() => {});
    await this.sweepSessionDirs(now).catch(() => {});
  }

  /** An abandoned branch with no commit beyond its dispatch base has no worker code to retain. */
  private async emptyAbandoned(meta: SessionMeta): Promise<boolean> {
    if (meta.outcome !== "abandoned" || !/^[a-f0-9]{40,64}$/.test(meta.baseRef)) return false;
    try {
      return await resolveRef(meta.repo, `refs/heads/${meta.branch}`) === meta.baseRef;
    } catch {
      return false;
    }
  }

  /**
   * True when a session has a runtime that is not stopped. Reclamation paths read
   * history as well, and a resumed session's history copy must never authorize
   * removing the worktree or transcript of the worker that is running again.
   */
  private isLive(id: string): boolean {
    const rt = this.runtimes.get(id);
    return rt !== undefined && rt.meta.status !== "stopped";
  }

  /**
   * Remove a stopped, clean worktree only after success or a proven empty abandonment.
   * Dirty or unrecorded work remains available for recovery. Branch deletion is gc-only.
   */
  private async cleanMeta(meta: SessionMeta): Promise<boolean> {
    if (this.isLive(meta.id)) return false;
    if (meta.handoff && meta.handoff.kind !== "awaiting_acceptance") return false;
    const isFinished = meta.outcome !== undefined && FINISHED_OUTCOMES.has(meta.outcome);
    if ((!isFinished && !(await this.emptyAbandoned(meta))) || meta.status !== "stopped"
      || !meta.worktree || !existsSync(meta.worktree)) return false;
    if (!(await isWorktreeClean(meta.worktree))) return false;

    await removeWorktree(meta.repo, meta.worktree).catch(() => {});
    if (existsSync(meta.worktree)) throw new Error(`worktree cleanup failed: ${meta.worktree}`);
    return true;
  }

  /**
   * Remove the pi transcript directory for a finished, stopped session whose
   * retention has lapsed. Tied to the same autoClean lifecycle as the worktree;
   * lastText/lastEntryId live in state, so no report or resume data is lost.
   * This path only touches finished sessions; the reclaimStale sweep also removes
   * the transcript of an unfinished session whose work is beyond recovery (no
   * worktree and no live branch), but leaves a live-branch transcript alone.
   */
  private async cleanSessionDir(meta: SessionMeta): Promise<boolean> {
    if (this.isLive(meta.id)) return false;
    if (meta.status !== "stopped") return false;
    const finished = meta.outcome !== undefined && FINISHED_OUTCOMES.has(meta.outcome);
    if (!finished) return false;
    const dir = join(this.config.dataDir, "sessions", meta.id);
    if (!existsSync(dir)) return false;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      return false;
    }
    this.logWorkerEvent(meta.id, "reclaim", { transcript: true, reason: "clean" });
    return true;
  }

  /**
   * Delete transcript directories of stopped sessions past the retention TTL.
   *
   * Eligibility requires the session to be stopped: active and not-yet-stopped
   * workers are never touched. The reference time is the later of the recorded
   * last activity and the directory mtime, so a worker that just stopped after a
   * long run is not mistaken for an abandoned one. Directories with no state
   * entry are left alone: nothing here knows whether they are still wanted.
   */
  private async sweepSessionDirs(now = Date.now()): Promise<number> {
    const sessionsRoot = join(this.config.dataDir, "sessions");
    if (!existsSync(sessionsRoot)) return 0;
    let names: string[];
    try {
      names = readdirSync(sessionsRoot);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const meta = this.runtimes.get(name)?.meta ?? this.history.find((entry) => entry.id === name);
      if (!meta || meta.status !== "stopped") continue;
      const dir = join(sessionsRoot, name);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (now - Math.max(meta.lastActivity ?? 0, mtimeMs) <= SESSION_DIR_TTL_MS) continue;
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        continue; // retry on the next sweep
      }
      removed += 1;
      this.logWorkerEvent(name, "reclaim", { transcript: true, reason: "ttl" });
    }
    return removed;
  }

  /**
   * Drop clean worktrees of unfinished (None/abandoned) stopped sessions past the
   * final retention. Dirty trees are preserved; branches are always kept, so no
   * committed work is lost. Bounds disk growth from worktrees the normal sweep
   * must never auto-remove.
   */
  private async sweepFinalRetention(now = Date.now()): Promise<void> {
    const finalTtlMs = this.config.worktreeFinalTtlMin <= 0 ? 0 : this.config.worktreeFinalTtlMin * 60_000;
    if (finalTtlMs <= 0) return;
    for (const meta of this.history) {
      if (meta.status !== "stopped") continue;
      if (meta.outcome !== undefined && FINISHED_OUTCOMES.has(meta.outcome)) continue;
      if (now - (meta.lastActivity ?? 0) < finalTtlMs) continue;
      await this.cleanUnfinishedWorktree(meta).catch(() => {});
    }
  }

  /** Remove a clean worktree for an unfinished (None/abandoned) stopped session. */
  private async cleanUnfinishedWorktree(meta: SessionMeta): Promise<boolean> {
    const dir = meta.worktree;
    if (this.isLive(meta.id)) return false;
    if (!dir || meta.status !== "stopped" || !existsSync(dir)) return false;
    if (!(await isWorktreeClean(dir))) return false;
    await removeWorktree(meta.repo, dir).catch(() => {});
    if (existsSync(dir)) return false;
    return true;
  }

  /**
   * True once a session's work is beyond recovery: its worktree is gone and it either
   * already has an outcome, or its worker branch is gone so there is no committed work
   * left to resurrect. Only then are its transcript, control credential and history
   * bulk dead weight. An unrecorded session with a live branch is kept, because the
   * branch could still be checked out to continue the work.
   */
  private async dead(meta: SessionMeta): Promise<boolean> {
    if (this.isLive(meta.id)) return false;
    // An unconfirmed shutdown still has an open ownership question to resolve.
    if (meta.shutdownUnconfirmed) return false;
    if (meta.worktree && existsSync(meta.worktree)) return false;
    if (meta.outcome !== undefined) return true;
    // No outcome: keep the transcript only while a live branch could still be checked out.
    if (!meta.repo || !existsSync(meta.repo) || !meta.branch) return true;
    try {
      await resolveRef(meta.repo, `refs/heads/${meta.branch}`);
      return false;
    } catch {
      return true;
    }
  }

  // -------------------------------------------------------------------------
  // Worker lifecycle events
  // -------------------------------------------------------------------------

  /** Append one lifecycle event; diagnostics never throw into a worker path. */
  private logWorkerEvent(id: string, event: WorkerEventKind, fields: Record<string, unknown> = {}): void {
    appendWorkerEvent(join(this.config.dataDir, "logs", "workers.jsonl"), {
      ts: new Date().toISOString(),
      id,
      event,
      ...fields,
    });
  }

  /**
   * Best-effort guard/tool error counters from the worker's own transcripts.
   *
   * Only top-level `*.jsonl` files are the worker's conversation (`agent/` holds
   * pi's internal run history). A missing, unreadable or partially corrupted
   * transcript yields null instead of a misleading zero, and never throws: a
   * finish event must not fail because diagnostics could not be derived.
   */
  private async countWorkerToolErrors(id: string): Promise<{ guard_blocks: number; tool_errors: number } | null> {
    const dir = join(this.config.dataDir, "sessions", id);
    let files: string[];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return null;
    }
    if (!files.length) return null;

    let guardBlocks = 0;
    let toolErrors = 0;
    try {
      for (const name of files) {
        const lines = createInterface({ input: createReadStream(join(dir, name), { encoding: "utf8" }), crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line.trim()) continue;
          let entry: any;
          try { entry = JSON.parse(line); } catch { continue; } // tolerate a torn tail
          const message = entry?.message;
          if (message?.role !== "toolResult" || message.isError !== true) continue;
          if (isGuardBlock(message)) guardBlocks += 1;
          else toolErrors += 1;
        }
      }
    } catch {
      return null;
    }
    return { guard_blocks: guardBlocks, tool_errors: toolErrors };
  }

  /** Record the final disposition of a workstream with what its evidence still shows. */
  private async emitFinishEvent(meta: SessionMeta, outcome: Outcome): Promise<void> {
    const counts = await this.countWorkerToolErrors(meta.id);
    let dirty: boolean | null = null;
    if (meta.worktree && existsSync(meta.worktree)) {
      try { dirty = !(await isWorktreeClean(meta.worktree)); } catch { dirty = null; }
    }
    this.logWorkerEvent(meta.id, "finish", {
      outcome,
      turns: typeof meta.turns === "number" ? meta.turns : null,
      cost: typeof meta.cost === "number" ? meta.cost : null,
      guard_blocks: counts?.guard_blocks ?? null,
      tool_errors: counts?.tool_errors ?? null,
      dirty,
    });
  }

  /**
   * Trim what only a recoverable session needs, keeping every field the scoreboard
   * reads (outcome, purpose, cost, tokens, counters, review records) and every field
   * the state validator enforces (requirements, validation paths, candidate review).
   * Returns the field names that changed.
   */
  private compactStale(meta: SessionMeta): string[] {
    const fields: string[] = [];
    // Trim to the limit exactly and keep the strings clean: the audit trail of what
    // was reclaimed lives in `meta.reclaimed.fields`, so a second pass finds nothing
    // left to cut and never re-trims its own output.
    const tail = (text: string, limit: number) => text.slice(-limit);

    if (meta.lastText && meta.lastText.length > RECLAIM_LAST_TEXT_CHARS) {
      meta.lastText = tail(meta.lastText, RECLAIM_LAST_TEXT_CHARS);
      fields.push("lastText");
    }

    const result = meta.verification?.result;
    if (result && !result.compacted
      && (result.stdout.length > RECLAIM_OUTPUT_CHARS || result.stderr.length > RECLAIM_OUTPUT_CHARS)) {
      result.stdout = tail(result.stdout, RECLAIM_OUTPUT_CHARS);
      result.stderr = tail(result.stderr, RECLAIM_OUTPUT_CHARS);
      result.compacted = true;
      fields.push("verification.result");
    }

    // Free-text contract fields are never validated on reload; requirements and
    // validation paths must stay, because the candidate review verdicts bind to them.
    if (meta.spec) {
      const bulk = meta.spec.goal || meta.spec.contracts?.length || meta.spec.constraints?.length || meta.spec.non_goals?.length;
      if (bulk) {
        meta.spec = { ...meta.spec, goal: "", contracts: undefined, constraints: undefined, non_goals: undefined };
        fields.push("spec");
      }
    }

    if (meta.acceptance?.hashes && Object.keys(meta.acceptance.hashes).length) {
      meta.acceptance = { ...meta.acceptance, hashes: {} };
      fields.push("acceptance.hashes");
    }

    if (meta.heldLocks?.length) {
      meta.heldLocks = [];
      fields.push("heldLocks");
    }

    if (meta.workerProcess) {
      // Nothing owns this pid any more, and it must not stay kill-authority.
      meta.workerProcess = undefined;
      fields.push("workerProcess");
    }

    return fields;
  }

  /**
   * Reclaim what sessions beyond recovery still hold: their control credential, their
   * transcript directory and the bulk evidence in their history entry. Runs from the
   * sweeper under the same autoClean lifecycle as worktree cleanup, and on demand from
   * pi_gc (which reports the counts).
   */
  private async reclaimStale(selected?: Set<string>): Promise<{ credentials: number; compacted: number; transcripts: number }> {
    // One bucket per session: the archived history copy and, when it still exists, the
    // runtime meta. The runtime wins in persisted state and the copy takes over once
    // the sweeper evicts it, so both are compacted and neither can resurrect the bulk.
    const byId = new Map<string, SessionMeta[]>();
    const add = (meta: SessionMeta) => {
      if (selected && !selected.has(meta.id)) return;
      const bucket = byId.get(meta.id);
      if (bucket) {
        if (!bucket.includes(meta)) bucket.push(meta);
      } else byId.set(meta.id, [meta]);
    };
    for (const meta of this.history) add(meta);
    for (const rt of this.runtimes.values()) add(rt.meta);

    let credentials = 0;
    let compacted = 0;
    let transcripts = 0;
    for (const [id, metas] of byId) {
      const stale: SessionMeta[] = [];
      for (const meta of metas) if (await this.dead(meta)) stale.push(meta);
      if (!stale.length) continue;

      const sessionDir = join(this.config.dataDir, "sessions", id);
      let transcriptRemoved = false;
      if (existsSync(sessionDir)) {
        try { await rm(sessionDir, { recursive: true, force: true }); transcriptRemoved = true; transcripts += 1; }
        catch { /* retry on the next sweep */ }
      }
      const removedFields = transcriptRemoved ? ["transcript"] : [];

      let credentialRemoved = false;
      if (stale.some((meta) => !(meta.reclaimed?.credential ?? false))) {
        if (await this.vault.remove(id)) { credentials += 1; credentialRemoved = true; }
        for (const meta of stale) meta.reclaimed = this.reclaimedMarker(meta, true, removedFields);
      }

      // Record the transcript removal even when the credential and bulk were already
      // reclaimed in a prior pass (e.g. a transcript that could only be removed now):
      // otherwise the marker would silently claim nothing was trimmed. This must run
      // after the credential branch, or the premature credential flag would stop the
      // real credential removal above.
      if (transcriptRemoved && !stale.some((meta) => meta.reclaimed?.fields.includes("transcript"))) {
        stale[0].reclaimed = this.reclaimedMarker(stale[0], true, ["transcript"]);
      }

      const trimmed = stale
        .map((meta) => [meta, this.compactStale(meta)] as const)
        .filter(([, fields]) => fields.length > 0);
      for (const [meta, fields] of trimmed) meta.reclaimed = this.reclaimedMarker(meta, true, [...fields, ...removedFields]);
      if (trimmed.length) compacted += 1;

      if (transcriptRemoved || credentialRemoved || trimmed.length) {
        this.logWorkerEvent(id, "reclaim", {
          transcript: transcriptRemoved,
          credential: credentialRemoved,
          fields: [...new Set([...(transcriptRemoved ? ["transcript"] : []), ...trimmed.flatMap(([, names]) => names)])],
        });
      }
    }

    if (credentials || compacted || transcripts) {
      this.scheduleSave();
      logLine("pi-coffee", `reclaimed ${credentials} credential(s), ${transcripts} transcript(s), compacted ${compacted} history entr${compacted === 1 ? "y" : "ies"}`);
    }
    return { credentials, compacted, transcripts };
  }

  private reclaimedMarker(meta: SessionMeta, credential: boolean, fields: string[]): NonNullable<SessionMeta["reclaimed"]> {
    return {
      at: Date.now(),
      credential: credential || Boolean(meta.reclaimed?.credential),
      fields: [...new Set([...(meta.reclaimed?.fields ?? []), ...fields])],
    };
  }

  /**
   * Manual cleanup: stop+clean every finished, non-running worker and evict it
   * from memory, then safely delete branches for finished workstreams (including
   * historical ones whose worktree is already gone) whose tip is an ancestor of
   * the repo's current HEAD. Branches are deduplicated per repo+branch and
   * retained when any session for them is unfinished, active, or has a dirty
   * worktree. Nothing here depends on the legacy `deleteBranches` force setting.
   */
  async gc(sessionIds?: string[]): Promise<Record<string, unknown>> {
    const selected = sessionIds === undefined ? undefined : new Set(sessionIds);
    let cleaned = 0;
    let evicted = 0;
    const cleanupErrors: { session_id: string; reason: string }[] = [];

    for (const [id, rt] of [...this.runtimes]) {
      if (selected && !selected.has(id)) continue;
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
      if (this.runtimes.get(id) === rt) this.runtimes.delete(id);
      evicted++;
    }

    // Restarted workers are in history, not runtimes. They still need safe
    // worktree cleanup; otherwise an empty abandoned review survives forever.
    for (const meta of this.history) {
      if (selected && !selected.has(meta.id)) continue;
      if (this.runtimes.has(meta.id) || meta.status !== "stopped") continue;
      try {
        if (await this.cleanMeta(meta)) cleaned++;
      } catch (error) {
        cleanupErrors.push({ session_id: meta.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    let branches: {
      deleted: string[];
      retained: { repo: string; branch: string; reason: string }[];
      failure?: string;
    };
    try {
      branches = await this.gcBranches(selected);
    } catch (error) {
      branches = { deleted: [], retained: [], failure: error instanceof Error ? error.message : String(error) };
    }

    const reclaimed = await this.reclaimStale(selected).catch(() => ({ credentials: 0, compacted: 0, transcripts: 0 }));

    this.notifyWaiters();
    this.scheduleSave();

    return {
      worktrees_cleaned: cleaned,
      branches_deleted: branches.deleted.length,
      branches_retained: branches.retained,
      ...(cleanupErrors.length ? { cleanup_errors: cleanupErrors } : {}),
      ...(branches.failure ? { branches_error: branches.failure } : {}),
      sessions_evicted: evicted,
      credentials_reclaimed: reclaimed.credentials,
      transcripts_reclaimed: reclaimed.transcripts,
      history_compacted: reclaimed.compacted,
      remaining_live: this.runtimes.size,
    };
  }

  private async gcBranches(selected?: Set<string>): Promise<{
    deleted: string[];
    retained: { repo: string; branch: string; reason: string }[];
  }> {
    interface Candidate {
      repo: string;
      branch: string;
      blocked?: string;
      sessionIds: Set<string>;
      emptyAbandoned: boolean;
      selectedOwner: boolean;
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
        candidate = { repo: meta.repo, branch: meta.branch, blocked: identityError,
          sessionIds: new Set(), emptyAbandoned: false, selectedOwner: false };
        byRepoBranch.set(key, candidate);
      }
      candidate.sessionIds.add(meta.id);
      if (!selected || selected.has(meta.id)) candidate.selectedOwner = true;
      if (candidate.blocked) continue;

      if (selected && !selected.has(meta.id)) {
        candidate.blocked = "session not selected for cleanup";
        continue;
      }

      if (meta.outcome === "abandoned" && await this.emptyAbandoned(meta)) {
        candidate.emptyAbandoned = true;
      } else if (!meta.outcome || !FINISHED_OUTCOMES.has(meta.outcome)) {
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
      if (selected && !candidate.selectedOwner) continue;
      if (!candidate.blocked && candidate.emptyAbandoned && candidate.sessionIds.size > 1) {
        candidate.blocked = "outcome abandoned on shared branch";
      }
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
    this.orchestratorCosts = state.orchestratorCosts;
    this.locks = new LockManager();
    this.mailbox.import(state.mailbox);
    this.board.import(state.board);
    this.history = [];
    for (const original of state.history) {
      const entry = { ...original, pendingQuestions: [] };
      if (entry.shutdownUnconfirmed) {
        try {
          if (!entry.workerProcess) throw new Error("missing process ownership proof");
          await stopOwnedWorker(entry.workerProcess);
          entry.shutdownUnconfirmed = false;
          entry.heldLocks = [];
          entry.status = "stopped";
          entry.handoff = { id: randomBytes(12).toString("hex"), kind: "worker_exited", at: Date.now(),
            safeToTakeOver: true, locksReleased: true, action: "take_over" };
        } catch {
          entry.status = "error";
          entry.error = "orphan worker shutdown unconfirmed; scope locks retained";
          entry.handoff = { id: randomBytes(12).toString("hex"), kind: "shutdown_failed", at: Date.now(),
            safeToTakeOver: false, locksReleased: false, action: "resolve_shutdown" };
          this.locks.import([...this.locks.export(), ...(entry.heldLocks ?? [])]);
          // Also reconstruct declared scope if the last snapshot missed a dynamic lock update.
          if (entry.lockRepoIdentity) {
            this.locks.claim(entry.id, normalizedScope(entry.spec?.scope ?? []), "rw", entry.lockRepoIdentity);
          }
        }
      } else if (["starting", "idle", "working", "stopping"].includes(entry.status)) entry.status = "stopped";
      this.history.push(entry);
    }
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
      orchestratorCosts: this.orchestratorCosts,
    };
    await this.store.write(data);
  }

  /** Context-only stderr diagnostic: operation, file and error code, never serialized state. */
  private reportSaveError(operation: string, error: unknown): void {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = error instanceof Error ? error.message : String(error);
    logLine("state", `${operation} failed for ${this.store.path}${code ? ` [${code}]` : ""}: ${detail}`);
  }

  /** Persisted history overlaid with the live sessions (live wins on id collisions). */
  private mergedHistory(): SessionMeta[] {
    const byId = new Map<string, SessionMeta>();
    for (const entry of this.history) byId.set(entry.id, entry);
    for (const rt of this.runtimes.values()) {
      byId.set(rt.meta.id, { ...rt.meta, pendingQuestions: [], heldLocks: this.locks.list().filter(lock =>
        lock.sessionId === rt.meta.id || (lock.sessionId === "codex" && rt.acceptanceReserved
          && lock.repo === rt.repoIdentity && normalizedScope(rt.meta.acceptance?.files ?? []).includes(lock.path))) });
    }

    return [...byId.values()];
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
    let dispatchIdentity: string | undefined;
    try {
      const repo = opts.repo ?? this.config.defaultRepo;
      if (repo && existsSync(repo)) {
        dispatchIdentity = resolveRepoIdentity(repo);
        this.assertRepoAvailable(dispatchIdentity);
        this.dispatchingRepos.set(dispatchIdentity, (this.dispatchingRepos.get(dispatchIdentity) ?? 0) + 1);
      }
      return await this.spawnSession(opts, slot);
    } finally {
      if (dispatchIdentity) {
        const remaining = (this.dispatchingRepos.get(dispatchIdentity) ?? 0) - 1;
        if (remaining > 0) this.dispatchingRepos.set(dispatchIdentity, remaining);
        else this.dispatchingRepos.delete(dispatchIdentity);
      }
      if (!slot.transferred) this.releaseReservation();
    }
  }

  private async spawnSession(opts: SpawnOptions, slot: { transferred: boolean }): Promise<SessionMeta> {
    validateReviewSpec(opts.spec);
    const repo = opts.repo ?? this.config.defaultRepo;
    if (!repo) {
      throw new Error("repo is required: pass repo to pi_spawn, or set PI_COFFEE_DEFAULT_REPO for the daemon");
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
    this.assertRepoAvailable(repoIdentity);
    const scope = normalizedScope(opts.spec?.scope ?? []);
    if (scope.length) {
      const pre = this.locks.claim(id, scope, "rw", repoIdentity);
      if (!pre.ok) {
        this.locks.releaseAll(id, repoIdentity);
        throw new Error(
          `scope conflicts with active sessions: ${pre.conflicts.map((c) => `${c.path} @ ${c.sessionId}`).join(", ")}`,
        );
      }
    }

    // Reserve Codex-owned acceptance files before creating anything.
    acceptanceReserved = this.reserveAcceptanceLocks(id, acceptancePaths, repoIdentity);

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

    let originalAcceptanceHashes: Record<string, string>;
    // Test-first delegation: write Codex-authored acceptance files BEFORE the worker starts.
    try {
      for (const f of opts.acceptanceFiles ?? []) {
        await writeAcceptanceFile(wt.dir, f.path, f.content);
      }
      originalAcceptanceHashes = await acceptanceHashes(wt.dir, acceptancePaths);
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
      controlKeyHash: opts.controlKeyHash,
      scopeKeyHash: opts.scopeKeyHash,
      acceptance: acceptancePaths.length || opts.acceptanceCommand ? {
        files: acceptancePaths, command: opts.acceptanceCommand,
        hashes: originalAcceptanceHashes,
      } : undefined,
      spec: opts.spec ? structuredClone(opts.spec) : undefined,
      thinking: opts.thinking ?? this.config.thinking,
      status: "starting",
      createdAt: Date.now(),
      lastActivity: Date.now(),
      pendingQuestions: [],
    };

    const workerToken = randomBytes(32).toString("base64url");
    const workerAgentDir = join(this.config.dataDir, "sessions", id, "agent");
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
        PI_CODING_AGENT_DIR: workerAgentDir,
        PI_COORD_URL: `http://${this.config.host}:${this.config.port}`,
        PI_COORD_SESSION_ID: id,
        PI_COORD_TOKEN: workerToken,
      },
    });

    const rt: Runtime = { meta, client, lastNotifiedQuestionIds: new Set(), acceptanceReserved, repoIdentity };
    // Persist before the first prompt; never return a live worker whose control credential was lost.
    if (opts.controlKey && opts.scopeKey) {
      try { await this.vault.save(id, opts.controlKey, opts.scopeKey); }
      catch { this.releaseRuntimeReservations(rt); throw new Error("worker control credential persistence failed"); }
    }
    this.runtimes.set(id, rt);
    this.workerTokens.set(workerToken, id);
    // The runtime now occupies the slot: stop counting it in `reserved` so it is
    // not double-counted by activeCount() while the child is starting.
    slot.transferred = true;
    this.releaseReservation();
    this.wireEvents(rt);

    try {
      await prepareWorkerAgentDir(workerAgentDir, undefined, this.config.workerPlugins);
      meta.shutdownUnconfirmed = true;
      meta.lockRepoIdentity = repoIdentity;
      // Durable ownership precedes spawn; a crash before PID capture fails closed on recovery.
      await this.flush();
      await client.start();
      if (client.pid !== undefined) meta.workerProcess = await captureWorkerProcess(client.pid);
      await this.flush();
      if (meta.status === "stopped") throw new Error(`session ${id} stopped during startup`);
      meta.status = "idle";
    } catch (e) {
      if (meta.status !== "stopped") {
        meta.status = "error";
        meta.error = String(e);
      }
      // A failed startup must not leak the child process or any reservations.
      try { await client.stop(); }
      catch { this.publishHandoff(rt, "shutdown_failed", false); throw new Error("worker startup failed and shutdown is unconfirmed; locks retained"); }
      meta.shutdownUnconfirmed = false;
      this.workerTokens.delete(workerToken);
      this.releaseRuntimeReservations(rt);
      this.scheduleSave();
      this.notifyWaiters();
      throw e;
    }

    this.scheduleSave();
    this.notifyWaiters();

    this.logWorkerEvent(id, "spawn", {
      name: meta.name,
      repo,
      task_type: opts.spec?.task_type ?? null,
      purpose: opts.spec?.purpose ?? null,
    });

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
    if (first) {
      try { await this.send(id, first, "prompt"); }
      catch (error) { await this.failWorker(rt, "provider_error"); throw error; }
    }
    return meta;
  }

  // -------------------------------------------------------------------------
  // Sessions: resume a stopped worker on its own transcript
  // -------------------------------------------------------------------------

  /**
   * Restart a stopped worker on the transcript it already has, instead of
   * dispatching a fresh session that would have to rediscover its context.
   *
   * Worktree, branch, spec, acceptance record and control credential all survive a
   * stop, so resume rebuilds only the pi process, its worker token and the scope
   * locks. Everything an earlier run proved is dropped: a resumed worker is not the
   * settled worker that verification described.
   *
   * Refuses instead of guessing when the transcript, agent directory or worktree is
   * gone, when an outcome is already recorded, or when a shutdown is unconfirmed.
   */
  async resume(id: string, opts: ResumeOptions = {}): Promise<SessionMeta> {
    const running = this.runtimes.get(id);
    if (running && running.meta.status !== "stopped") {
      throw new Error(`session ${id} is ${running.meta.status}; stop it before resuming`);
    }
    // A stopped worker keeps its runtime until the sweeper evicts it; that meta is
    // at least as fresh as the archived copy and is the one this resume replaces.
    const entry = running?.meta ?? this.history.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`unknown session: ${id}`);
    if (entry.outcome !== undefined) throw new Error(`session ${id} is finished (${entry.outcome}); re-dispatch instead of resuming`);
    if (entry.reclaimed) throw new Error(`session ${id} had its evidence reclaimed; re-dispatch instead of resuming`);
    if (entry.status !== "stopped") throw new Error(`session ${id} is ${entry.status}; only a stopped worker can be resumed`);
    if (entry.shutdownUnconfirmed) throw new Error(`session ${id} has an unconfirmed worker shutdown; stop it before resuming`);
    if (!entry.repo || !existsSync(entry.repo)) throw new Error(`session ${id} lost its repository; re-dispatch instead of resuming`);
    if (!entry.worktree || !existsSync(entry.worktree)) throw new Error(`session ${id} lost its worktree; re-dispatch instead of resuming`);
    const transcript = this.resumableTranscript(id);
    const repoIdentity = resolveRepoIdentity(entry.repo);

    // Same slot discipline as spawn: reserve before the first await so two
    // concurrent resumes cannot both pass the cap check.
    this.reserveSlot();
    const slot = { transferred: false };
    let dispatchIdentity: string | undefined;
    try {
      if (!await this.vault.read(id)) {
        throw new Error(`session ${id} has no stored control credential; re-dispatch instead of resuming`);
      }
      this.assertRepoAvailable(repoIdentity);
      this.dispatchingRepos.set(repoIdentity, (this.dispatchingRepos.get(repoIdentity) ?? 0) + 1);
      dispatchIdentity = repoIdentity;
      return await this.resumeSession(entry, transcript, repoIdentity, opts, slot);
    } finally {
      if (dispatchIdentity) {
        const remaining = (this.dispatchingRepos.get(dispatchIdentity) ?? 0) - 1;
        if (remaining > 0) this.dispatchingRepos.set(dispatchIdentity, remaining);
        else this.dispatchingRepos.delete(dispatchIdentity);
      }
      if (!slot.transferred) this.releaseReservation();
    }
  }

  /**
   * The single transcript a resumable worker owns. Several candidates are refused
   * rather than guessed: continuing the wrong branch of a worker's history would
   * silently detach it from its contract.
   */
  private resumableTranscript(id: string): string {
    const dir = join(this.config.dataDir, "sessions", id);
    let transcripts: string[];
    try {
      transcripts = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      throw new Error(`session ${id} has no transcript directory; re-dispatch instead of resuming`);
    }
    if (!transcripts.length) throw new Error(`session ${id} has no transcript; re-dispatch instead of resuming`);
    if (transcripts.length > 1) throw new Error(`session ${id} has ${transcripts.length} transcripts; resume is ambiguous`);
    if (!existsSync(join(dir, "agent"))) {
      throw new Error(`session ${id} lost its worker agent directory; re-dispatch instead of resuming`);
    }
    return join(dir, transcripts[0]);
  }

  private async resumeSession(
    entry: SessionMeta,
    transcript: string,
    repoIdentity: string,
    opts: ResumeOptions,
    slot: { transferred: boolean },
  ): Promise<SessionMeta> {
    const id = entry.id;
    const acceptancePaths = entry.acceptance?.files ?? [];

    // The spec still owns the scope: re-claim it before the process starts, so a
    // concurrent dispatch cannot take files this worker is about to edit again.
    const scope = normalizedScope(entry.spec?.scope ?? []);
    if (scope.length) {
      const claim = this.locks.claim(id, scope, "rw", repoIdentity);
      if (!claim.ok) {
        this.locks.releaseAll(id, repoIdentity);
        throw new Error(`scope conflicts with active sessions: ${this.conflictSummary(claim.conflicts)}`);
      }
    }
    const acceptanceReserved = this.reserveAcceptanceLocks(id, acceptancePaths, repoIdentity);

    const meta: SessionMeta = { ...entry, pendingQuestions: [] };
    // Nothing that described the settled previous run still applies once the
    // worker can write again, and the previous pid must never be kill-authority.
    meta.verification = undefined;
    meta.integration = undefined;
    meta.candidateReview = undefined;
    meta.reviewAcceptance = undefined;
    meta.handoff = undefined;
    meta.error = undefined;
    meta.extension = undefined;
    meta.extensionAt = undefined;
    meta.workerProcess = undefined;
    meta.shutdownUnconfirmed = true;
    meta.lockRepoIdentity = repoIdentity;
    meta.status = "starting";
    meta.lastActivity = Date.now();

    const workerToken = randomBytes(32).toString("base64url");
    const sessionDir = join(this.config.dataDir, "sessions", id);
    const client = new PiRpcClient({
      cwd: meta.worktree,
      piBin: this.config.piBin,
      provider: opts.provider ?? entry.provider ?? this.config.provider,
      model: opts.model ?? entry.model ?? this.config.model,
      thinking: opts.thinking ?? entry.thinking ?? this.config.thinking,
      name: meta.name,
      sessionDir,
      resumeSession: transcript,
      extensionPath: this.config.extensionPath,
      env: {
        PI_CODING_AGENT_DIR: join(sessionDir, "agent"),
        PI_COORD_URL: `http://${this.config.host}:${this.config.port}`,
        PI_COORD_SESSION_ID: id,
        PI_COORD_TOKEN: workerToken,
      },
    });

    const rt: Runtime = { meta, client, lastNotifiedQuestionIds: new Set(), acceptanceReserved, repoIdentity };
    this.runtimes.set(id, rt);
    this.workerTokens.set(workerToken, id);
    slot.transferred = true;
    this.releaseReservation();
    this.wireEvents(rt);
    // Reclamation and report paths read history too: it must not keep describing
    // this session as stopped while a worker is running again.
    this.archive(meta);

    // Read the runtime's status as it is now: a concurrent pi_stop can change it
    // while this worker is starting up.
    const currentStatus = (): SessionStatus => this.runtimes.get(id)?.meta.status ?? "stopped";

    try {
      // Durable ownership precedes start; a crash before PID capture fails closed.
      await this.flush();
      await client.start();
      if (client.pid !== undefined) meta.workerProcess = await captureWorkerProcess(client.pid);
      await this.flush();
      if (currentStatus() === "stopped") throw new Error(`session ${id} stopped during resume`);
      meta.status = "idle";
    } catch (e) {
      if (currentStatus() !== "stopped") {
        meta.status = "error";
        meta.error = String(e);
      }
      try { await client.stop(); }
      catch {
        this.publishHandoff(rt, "shutdown_failed", false);
        this.archive(meta);
        throw new Error("worker resume failed and shutdown is unconfirmed; locks retained");
      }
      meta.shutdownUnconfirmed = false;
      this.workerTokens.delete(workerToken);
      this.releaseRuntimeReservations(rt);
      this.archive(meta);
      this.scheduleSave();
      this.notifyWaiters();
      throw e;
    }

    this.scheduleSave();
    this.notifyWaiters();

    // The contract is already in the transcript; only an explicit nudge is sent.
    if (opts.prompt) {
      try { await this.send(id, opts.prompt, "prompt"); }
      catch (error) { await this.failWorker(rt, "provider_error"); throw error; }
    }
    return meta;
  }

  private wireEvents(rt: Runtime): void {
    rt.client.on("event", (event: PiEvent) => {
      if (rt.meta.status === "stopped" || rt.meta.status === "stopping" || rt.stopping) return;
      rt.meta.lastActivity = Date.now();
      switch (event.type) {
        case "agent_start":
          rt.lastProgressAt ??= Date.now();
          rt.activeTools ??= new Set();
          rt.meta.handoff = undefined;
          if (rt.meta.outcome === undefined) rt.meta.status = "working";
          break;
        case "agent_settled":
          if (rt.stopping) break;
          if (rt.providerFailed) { void this.failWorker(rt, "provider_error"); break; }
          if (rt.meta.outcome === undefined) rt.meta.status = "idle";
          if (rt.meta.outcome === undefined && rt.meta.lastText?.trim()) this.publishHandoff(rt, "awaiting_acceptance", false);
          void this.refreshStats(rt, true);
          break;
        case "message_update":
          if (["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent?.type)) {
            rt.lastProgressAt = Date.now();
            if (rt.meta.handoff?.kind === "provider_wait") rt.meta.handoff = undefined;
          }
          break;
        case "tool_execution_start":
          (rt.activeTools ??= new Set()).add(event.toolCallId);
          rt.lastProgressAt = Date.now();
          // A worker that starts executing a tool is demonstrably active again;
          // drop a stale stall warning that a previous quiet period published.
          if (rt.meta.handoff?.kind === "provider_wait") rt.meta.handoff = undefined;
          break;
        case "tool_execution_end":
          rt.activeTools?.delete(event.toolCallId);
          rt.lastProgressAt = Date.now();
          break;
        case "auto_retry_start":
          rt.providerFailed = false;
          break;
        case "auto_retry_end":
          if (event.success === false) {
            rt.providerFailed = true;
            void this.failWorker(rt, "provider_error");
          }
          break;
        case "message_end": {
          const msg = event.message;
          if (msg?.role === "assistant") {
            rt.providerFailed = msg.stopReason === "error" || msg.stopReason === "aborted";
            if (!rt.providerFailed) rt.lastProgressAt = Date.now();
            const text = textOf(msg);
            if (text) rt.meta.lastText = text;
          }
          // A long turn must not hide turns/tokens until agent_settled.
          this.refreshRunningStats(rt);
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
      if (rt.meta.status === "stopped" || rt.meta.status === "error" || rt.meta.status === "stopping" || rt.meta.outcome !== undefined) return;
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

    rt.client.on("shutdown_failed", () => {
      rt.meta.status = "error";
      rt.meta.error = "worker shutdown could not be confirmed; locks retained";
      this.publishHandoff(rt, "shutdown_failed", false);
    });
    rt.client.on("exit", () => {
      if (rt.meta.status !== "stopped" && !rt.stopping) {
        rt.meta.status = "error";
        rt.meta.error = "pi rpc exited";
      }
      rt.meta.shutdownUnconfirmed = false;
      rt.meta.pendingQuestions = [];
      this.releaseRuntimeReservations(rt);
      if (!rt.stopping && rt.meta.outcome === undefined) this.publishHandoff(rt, "worker_exited", true);
      for (const [token, sid] of this.workerTokens) if (sid === rt.meta.id) this.workerTokens.delete(token);
      this.notifyWaiters();
      this.scheduleSave();
    });
  }

  private publishHandoff(rt: Runtime, kind: WorkerHandoff["kind"], safe: boolean): void {
    rt.meta.handoff = { id: randomBytes(12).toString("hex"), kind, at: Date.now(),
      safeToTakeOver: safe, locksReleased: safe,
      action: kind === "provider_wait" ? "wait_or_stop" : kind === "awaiting_acceptance" ? "accept_and_finish"
        : safe ? "take_over" : "resolve_shutdown" };
    this.scheduleSave();
    this.notifyWaiters();
  }

  /** The daemon owns this watchdog; it never asks the stalled model to report its own failure. */
  private async checkWorkerHealth(now = Date.now()): Promise<void> {
    if (this.healthChecking) return;
    this.healthChecking = true;
    try {
      for (const rt of this.runtimes.values()) {
        if (rt.stopping || rt.meta.outcome !== undefined || rt.meta.pendingQuestions.length) continue;
        if (rt.meta.status === "working" && !rt.activeTools?.size) {
          const quiet = now - (rt.lastProgressAt ?? rt.meta.lastActivity);
          if (quiet >= this.config.workerStallMs) await this.failWorker(rt, "provider_timeout");
          else if (quiet >= this.config.workerWarnMs && rt.meta.handoff?.kind !== "provider_wait")
            this.publishHandoff(rt, "provider_wait", false);
        } else if (rt.meta.status === "idle" && now - rt.meta.lastActivity >= this.config.workerIdleMs) {
          await this.failWorker(rt, "owner_timeout");
        }
      }
    } finally { this.healthChecking = false; }
  }

  private async failWorker(rt: Runtime, reason: WorkerHandoff["kind"]): Promise<void> {
    try {
      await this.stop(rt.meta.id, { preserveWorktree: true });
      this.publishHandoff(rt, reason, true);
      this.archive(rt.meta);
      this.scheduleSave();
    } catch {
      rt.meta.status = "error";
      rt.meta.error = "worker shutdown could not be confirmed; locks retained";
      this.publishHandoff(rt, "shutdown_failed", false);
    }
  }

  async recoverControl(id: string, scopeKey: string): Promise<{ controlKey: string; scopeKey: string }> {
    const meta = this.snapshot(id);
    if (!meta.scopeKeyHash || createHash("sha256").update(scopeKey).digest("hex") !== meta.scopeKeyHash)
      throw new Error("invalid scope_key for worker recovery");
    const keys = await this.vault.read(id);
    if (!keys || createHash("sha256").update(keys.controlKey).digest("hex") !== meta.controlKeyHash
      || keys.scopeKey !== scopeKey) throw new Error("worker credentials unavailable; use authorized local administration");
    return keys;
  }

  private async refreshStats(rt: Runtime, includeCost = false): Promise<void> {
    try {
      const state = await rt.client.getState();
      rt.meta.provider = state.model?.provider;
      rt.meta.model = state.model?.id;
      if (typeof state.thinkingLevel === "string" && state.thinkingLevel) rt.meta.thinking = state.thinkingLevel;
      if (typeof state.sessionName === "string") rt.meta.name = state.sessionName;

      if (includeCost) {
        const stats = await rt.client.getSessionStats();
        rt.meta.cost = stats.cost;
        rt.meta.tokens = stats.tokens;
        rt.meta.context = stats.contextUsage;
        rt.meta.turns = stats.assistantMessages ?? rt.meta.turns;
        rt.meta.statsAt = Date.now();
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Mid-run stats refresh while a worker is not stopped. Long turns otherwise
   * show stale turns/tokens until agent_settled; throttle per worker so a busy
   * live worker costs at most one stats round-trip per window. Settled, stop,
   * wait and report reads stay unthrottled.
   */
  private refreshRunningStats(rt: Runtime): void {
    if (rt.meta.status === "stopped" || rt.meta.status === "stopping" || rt.stopping) return;
    const now = Date.now();
    if (now - (rt.lastStatsRefreshAt ?? 0) < STATS_REFRESH_THROTTLE_MS) return;
    rt.lastStatsRefreshAt = now;
    void this.refreshStats(rt, true);
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
      if (rt.meta.status === "starting" || rt.meta.status === "idle" || rt.meta.status === "working"
        || rt.meta.status === "stopping" || (rt.meta.status === "error" && !rt.client.hasExited)) n++;
    }
    n += this.history.filter(entry => entry.shutdownUnconfirmed && !this.runtimes.has(entry.id)).length;
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
  /** `path @ session` list for a rejected claim, without leaking anything else. */
  private conflictSummary(conflicts: Lock[]): string {
    return conflicts.map((c) => `${c.path} @ ${c.sessionId}`).join(", ");
  }

  /**
   * Reserve Codex-owned acceptance paths for a session. LockManager skips
   * same-owner collisions, so precheck under a temporary distinct owner first:
   * that surfaces overlaps with any existing lock (including another Codex-held
   * acceptance reservation), then re-claim under the shared "codex" owner so the
   * worker never owns its own tests. Returns whether the reservation was taken.
   */
  private reserveAcceptanceLocks(sessionId: string, acceptancePaths: string[], repoIdentity: string): boolean {
    if (!acceptancePaths.length) return false;
    const pre = this.locks.claim(ACCEPTANCE_PRECHECK_OWNER, acceptancePaths, "rw", repoIdentity);
    if (!pre.ok) {
      this.locks.releaseAll(sessionId, repoIdentity);
      this.scheduleSave();
      throw new Error(`acceptance files conflict with active locks: ${this.conflictSummary(pre.conflicts)}`);
    }
    this.locks.release(ACCEPTANCE_PRECHECK_OWNER, acceptancePaths, repoIdentity);

    const claimed = this.locks.claim("codex", acceptancePaths, "rw", repoIdentity);
    if (!claimed.ok) {
      // Not expected (no await between precheck and claim), but never leak partial reservations.
      this.locks.releaseAll(sessionId, repoIdentity);
      this.scheduleSave();
      throw new Error(`acceptance files conflict with active locks: ${this.conflictSummary(claimed.conflicts)}`);
    }
    return true;
  }

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

  /** Drop live reservations once, before a later worker can acquire the same codex paths. */
  private releaseRuntimeReservations(rt: Runtime): void {
    const reserved = Boolean(rt.acceptanceReserved);
    rt.acceptanceReserved = false;
    this.releaseSpawnReservations(rt.meta.id, rt.meta.acceptance?.files ?? [], reserved, rt.repoIdentity);
  }

  markExtension(sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    rt.meta.extension = true;
    rt.meta.extensionAt = Date.now();
    this.notifyWaiters();
  }

  list(): SessionMeta[] {
    return [...this.runtimes.values()].map((rt) => this.snapshotOf(rt))
      .concat(this.history.filter(meta => meta.shutdownUnconfirmed && !this.runtimes.has(meta.id)));
  }

  snapshot(id: string): SessionMeta {
    const rt = this.runtimes.get(id);
    if (rt) return this.snapshotOf(rt);
    const historic = this.history.find((entry) => entry.id === id);
    if (historic) return { ...historic, pendingQuestions: [...historic.pendingQuestions] };
    throw new Error(`unknown session: ${id}`);
  }

  /** Enforce a worker capability without ever persisting or echoing its plaintext. */
  assertControl(id: string, controlKey?: string): void {
    const hash = this.snapshot(id).controlKeyHash;
    if (!hash) return; // Sessions created before capability rollout remain legacy-unprotected.
    if (!controlKey) throw new Error(`control_key required for session ${id}`);
    const expected = Buffer.from(hash, "hex");
    const actual = createHash("sha256").update(controlKey).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error(`invalid control_key for session ${id}`);
    }
  }

  assertControlsForAll(controlKeys: Record<string, string> = {}): void {
    for (const meta of this.mergedHistory()) this.assertControl(meta.id, controlKeys[meta.id]);
  }

  assertControlsForActiveRepo(id: string, controlKeys: Record<string, string> = {}): void {
    const repoIdentity = resolveRepoIdentity(this.snapshot(id).repo);
    for (const rt of this.runtimes.values()) {
      if (rt.repoIdentity === repoIdentity && rt.meta.status !== "stopped") {
        this.assertControl(rt.meta.id, controlKeys[rt.meta.id]);
      }
    }
  }

  workerSessionForToken(token: string): string | undefined {
    return this.workerTokens.get(token);
  }

  hasProtectedSessions(): boolean {
    return this.mergedHistory().some((meta) => meta.controlKeyHash !== undefined);
  }

  assertSameScope(from: string, to: string): void {
    const source = this.snapshot(from);
    const target = this.snapshot(to);
    if (!source.scopeKeyHash || !target.scopeKeyHash || source.scopeKeyHash !== target.scopeKeyHash) {
      throw new Error("worker target is outside this session scope");
    }
  }

  scopedBoardName(id: string, board: string): string {
    const scope = this.snapshot(id).scopeKeyHash;
    if (!scope) throw new Error("legacy worker has no scoped board");
    return `${scope}:${board}`;
  }

  private snapshotOf(rt: Runtime): SessionMeta {
    return { ...rt.meta, pendingQuestions: [...rt.meta.pendingQuestions] };
  }

  private assertUnfinished(rt: Runtime): void {
    if (rt.meta.outcome !== undefined) throw new Error(`session ${rt.meta.id} is finished`);
    if (rt.meta.status === "stopping") throw new Error("session is stopping; worker is not writable");
    if (rt.meta.handoff?.kind === "shutdown_failed") throw new Error("worker shutdown is unconfirmed; resolve shutdown before further mutations");
  }

  async send(
    id: string,
    message: string,
    mode: "prompt" | "steer" | "followup" = "prompt",
    countInstruction = true,
    opts: { provider?: string; model?: string } = {},
  ): Promise<void> {
    const rt = this.get(id);
    this.assertRepoAvailable(rt.repoIdentity);
    this.assertUnfinished(rt);
    rt.meta.verification = undefined;
    rt.meta.integration = undefined;
    rt.meta.candidateReview = undefined;
    if (rt.meta.status === "error" || rt.meta.status === "stopped") {
      throw new Error(`session ${id} is ${rt.meta.status}`);
    }

    const previousStatus = rt.meta.status;
    if (previousStatus !== "working") {
      rt.lastProgressAt = Date.now();
      rt.meta.handoff = undefined;
      rt.providerFailed = false;
    }
    rt.meta.status = "working"; // Reserve the pending instruction before the first RPC await.
    try {
      if (opts.model) {
        const provider = opts.provider ?? rt.meta.provider ?? this.config.provider;
        await rt.client.setModel(provider, opts.model);
      }
      if (mode === "steer") await rt.client.steer(message);
      else if (mode === "followup") await rt.client.followUp(message);
      else if (rt.client.isStreaming) await rt.client.prompt(message, "followUp");
      else await rt.client.prompt(message);
    } catch (error) {
      if (rt.meta.status === "working" && !rt.client.isStreaming) rt.meta.status = previousStatus;
      throw error;
    }

    if (countInstruction) {
      rt.meta.orchestratorChars = (rt.meta.orchestratorChars ?? 0) + message.length;
      rt.meta.instructionsSent = (rt.meta.instructionsSent ?? 0) + 1;
    }
    rt.meta.lastActivity = Date.now();
    this.notifyWaiters();
  }

  async wait(ids: string[], until: "settled" | "idle" | "question", timeoutMs: number, afterNoticeIds: string[] = []): Promise<WaitResult> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sessions = ids.map((id) => this.snapshot(id));
      const done =
        until === "question"
          ? sessions.some((s) => s.pendingQuestions.length > 0)
          : sessions.every((s) => s.status !== "working" && s.status !== "starting" && s.status !== "stopping");
      const terminal = sessions.some((s) => s.status === "error" || s.status === "stopped");

      const attention = sessions.some((s) => s.handoff && !afterNoticeIds.includes(s.handoff.id));
      if (done || terminal || attention) {
        // Make sure fresh cost/context is reflected in the returned snapshot.
        await Promise.all(sessions.filter((s) => this.runtimes.has(s.id) && s.status !== "stopped").map((s) => this.refreshStats(this.get(s.id), true)));
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
    this.assertUnfinished(rt);
    return this.withRepoGuard(rt, async () => {
      if (rt.meta.status !== "idle" && rt.meta.status !== "stopped") throw new Error("settle the worker before committing");
      await checkChanges(rt.meta);
      rt.meta.verification = undefined;
      rt.meta.integration = undefined;
      rt.meta.candidateReview = undefined;
      return commitAll(rt.meta.worktree, message);
    });
  }

  /** Record a complete orchestrator judgment; this does not replace the actual acceptance command. */
  async review(id: string, verificationId: string, input: CandidateReviewInput): Promise<CandidateReview> {
    const rt = this.get(id);
    this.assertUnfinished(rt);
    return this.withRepoGuard(rt, async () => {
      if (!verificationId || rt.meta.verification?.id !== verificationId) throw new Error("review verification ID does not match the current candidate");
      await rt.client.refreshStreaming();
      if (rt.client.isStreaming || rt.meta.pendingQuestions.length) throw new Error("settle worker and questions before review");
      const proof = await this.integrationGate.assertCurrent(rt.meta, rt.meta.verification.targetBranch, false, false);
      validateCandidateReview(rt.meta.spec, proof.existingValidationChanges, input);
      const record = { ...structuredClone(input), verificationId, reviewedAt: Date.now() };
      rt.meta.candidateReview = record;
      this.scheduleSave();
      return structuredClone(record);
    });
  }

  private assertRepoAvailable(identity: string): void {
    if (this.busyRepos.has(identity)) throw new Error("repository is verifying or integrating; retry after it completes");
  }

  authorizeWrite(id: string): void {
    const rt = this.get(id);
    this.assertRepoAvailable(rt.repoIdentity);
    this.assertUnfinished(rt);
    if (rt.meta.status === "stopped" || rt.meta.status === "error" || rt.meta.status === "stopping") throw new Error("worker is not writable");
    rt.meta.verification = undefined;
    rt.meta.integration = undefined;
    rt.meta.candidateReview = undefined;
  }

  private async withRepoGuard<T>(rt: Runtime, fn: () => Promise<T>): Promise<T> {
    this.assertRepoAvailable(rt.repoIdentity);
    if (this.dispatchingRepos.has(rt.repoIdentity)) throw new Error("repository has a dispatch in flight; retry after it settles");
    this.busyRepos.add(rt.repoIdentity);
    try { return await fn(); } finally { this.busyRepos.delete(rt.repoIdentity); }
  }

  async verify(id: string, into?: string, timeoutMs = 600_000): Promise<Verification> {
    const rt = this.get(id);
    this.assertUnfinished(rt);
    return this.withRepoGuard(rt, async () => {
      await rt.client.refreshStreaming();
      if (rt.client.isStreaming || rt.meta.pendingQuestions.length) throw new Error("settle the worker and its questions before verification");
      rt.meta.verification = undefined;
      rt.meta.integration = undefined;
      rt.meta.candidateReview = undefined;
      const proof = await this.integrationGate.verify(rt.meta, into ?? await currentBranch(rt.meta.repo),
        (cwd, command) => runCommand(command, cwd, timeoutMs));
      rt.meta.verification = proof;
      this.scheduleSave();
      return proof;
    });
  }

  /** Merge a worker branch into a branch of the main repo (default: its current branch). */
  async merge(id: string, into?: string, noFf = true): Promise<MergeResult> {
    const rt = this.get(id);
    this.assertUnfinished(rt);
    return this.withRepoGuard(rt, async () => {
      const target = into ?? await currentBranch(rt.meta.repo);
      const proof = await this.integrationGate.assertCurrent(rt.meta, target);
      const result = await mergeBranch(rt.meta.repo, proof.workerSha, target, { noFf });
      if (result.ok) {
        const mergedSha = await resolveRef(rt.meta.repo, "HEAD");
        const tree = await resolveRef(rt.meta.repo, "HEAD^{tree}");
        if (tree !== proof.candidateTree) throw new Error("integrated tree differs from tested candidate; no success recorded");
        rt.meta.integration = { workerSha: proof.workerSha, targetBranch: target, previousTargetSha: proof.targetSha,
          mergedSha, candidateTree: tree, integratedAt: Date.now() };
        this.scheduleSave();
      }
      return { ...result, branch: rt.meta.branch };
    });
  }

  async push(id: string, remote = "origin", branch?: string): Promise<string> {
    const rt = this.get(id);
    if (branch && branch !== rt.meta.branch && branch !== await currentBranch(rt.meta.repo)) {
      throw new Error("pi_push may only push the controlled worker branch or the repository's current branch");
    }
    return pushBranch(rt.meta.repo, remote, branch);
  }

  /** Run a shell command inside a worker's worktree (independent verification by Codex). */
  async exec(
    id: string,
    command: string,
    timeoutMs = 600_000,
    login = false,
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    const rt = this.get(id);
    this.assertUnfinished(rt);
    return this.withRepoGuard(rt, async () => {
      rt.meta.verification = undefined;
      rt.meta.integration = undefined;
      rt.meta.candidateReview = undefined;
      return runCommand(command, rt.meta.worktree, timeoutMs, login);
    });
  }

  async answer(sessionId: string, requestId: string, response: Partial<UiResponse>): Promise<void> {
    const rt = this.get(sessionId);
    this.assertRepoAvailable(rt.repoIdentity);
    this.assertUnfinished(rt);
    if (rt.meta.status === "stopped" || rt.meta.status === "error" || rt.client.hasExited) {
      throw new Error(`session ${sessionId} is ${rt.meta.status} or exited`);
    }
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

  async stop(id: string, opts: { removeWorktree?: boolean; deleteBranch?: boolean; preserveWorktree?: boolean } = {}): Promise<void> {
    if (!this.runtimes.has(id)) {
      const meta = this.history.find(entry => entry.id === id);
      if (!meta) throw new Error(`unknown session: ${id}`);
      if (meta.shutdownUnconfirmed) {
        if (!meta.workerProcess) throw new Error("orphan worker lacks process ownership proof; locks retained");
        await stopOwnedWorker(meta.workerProcess);
        meta.shutdownUnconfirmed = false;
        this.locks.releaseAll(id, meta.lockRepoIdentity);
        for (const lock of meta.heldLocks ?? []) this.locks.release(lock.sessionId, [lock.path], lock.repo);
        meta.heldLocks = [];
        meta.status = "stopped";
        meta.handoff = { id: randomBytes(12).toString("hex"), kind: "worker_exited", at: Date.now(),
          safeToTakeOver: true, locksReleased: true, action: "take_over" };
        this.scheduleSave();
        this.notifyWaiters();
      }
      return;
    }
    const rt = this.get(id);
    if (rt.stopping) return rt.stopping;
    this.assertRepoAvailable(rt.repoIdentity);
    // Block writes before the first await; only confirmed shutdown releases ownership.
    rt.meta.status = "stopping";
    rt.meta.pendingQuestions = [];
    const stopping = Promise.resolve().then(async () => {
      await rt.client.stop();
      rt.meta.shutdownUnconfirmed = false;
      for (const [token, sid] of this.workerTokens) if (sid === id) this.workerTokens.delete(token);
      rt.meta.status = "stopped";
      rt.meta.handoff = undefined;
      rt.meta.lastActivity = Date.now();
      this.releaseRuntimeReservations(rt);
      this.archive(rt.meta);
      if (opts.removeWorktree) {
        const deleteBranch = opts.deleteBranch ?? this.config.deleteBranches;
        await removeWorktree(rt.meta.repo, rt.meta.worktree, deleteBranch ? rt.meta.branch : undefined);
      } else if (!opts.preserveWorktree && this.config.autoClean) {
        await this.cleanMeta(rt.meta).catch(() => {});
      }
      this.notifyWaiters();
      this.scheduleSave();
    });
    rt.stopping = stopping;
    try { await stopping; }
    catch (error) {
      if (rt.meta.shutdownUnconfirmed === false) {
        rt.meta.error = "worker stopped; requested cleanup failed";
        this.publishHandoff(rt, "worker_exited", true);
      } else {
        rt.meta.status = "error";
        this.publishHandoff(rt, "shutdown_failed", false);
      }
      throw error;
    }
    finally { rt.stopping = undefined; }
  }

  async stopAll(): Promise<void> {
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    // Stop periodic work first so no timer can re-dirty state after the final flush.
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    let shutdownFailed = false;
    const ids = new Set([...this.runtimes.keys(), ...this.history.filter(meta => meta.shutdownUnconfirmed).map(meta => meta.id)]);
    for (const id of ids) {
      try { await this.stop(id); } catch { shutdownFailed = true; }
    }
    await this.flush();
    if (shutdownFailed) throw new Error("worker shutdown unconfirmed; persisted reservations retained");
  }

  // -------------------------------------------------------------------------
  // Locks
  // -------------------------------------------------------------------------

  claim(sessionId: string, paths: string[], mode: LockMode, repo?: string): ClaimResult {
    const namespace = this.namespaceFor(sessionId, repo);
    this.assertRepoAvailable(namespace);
    const result = this.locks.claim(sessionId, this.normalizeLockPaths(sessionId, paths), mode, namespace);
    if (result.ok) this.scheduleSave();
    return result;
  }

  releaseLocks(sessionId: string, paths?: string[], repo?: string): number {
    const meta = this.runtimes.get(sessionId)?.meta ?? this.history.find(entry => entry.id === sessionId);
    if (meta?.handoff?.kind === "shutdown_failed") throw new Error("worker shutdown unconfirmed; locks retained");
    const namespace = this.namespaceFor(sessionId, repo);
    if (this.history.some(entry => entry.shutdownUnconfirmed && entry.heldLocks?.some(lock =>
      lock.sessionId === sessionId && lock.repo === namespace))) throw new Error("orphan reservation shutdown unconfirmed; locks retained");
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
        `cannot resolve repository for manual claimant "${sessionId}": pass repo or configure PI_COFFEE_DEFAULT_REPO`,
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
        // Global broadcasts have no scope identity. Protected workers receive only
        // explicitly addressed messages, including when old callers still broadcast.
        if (to === "*" && rt.meta.controlKeyHash) continue;

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
    const meta = this.runtimes.get(sessionId)?.meta ?? this.history.find(s => s.id === sessionId);
    return this.mailbox.inbox(sessionId, { unreadOnly }).filter(message => !meta?.controlKeyHash || message.to !== "*");
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

  async setOutcome(id: string, outcome: Outcome, note?: string): Promise<void> {
    if (outcome === "taken_over" && !note?.trim()) {
      throw new Error("taken_over requires a nonempty note explaining the takeover reason");
    }
    const rt = this.runtimes.get(id);
    if (!rt) {
      const historic = this.history.find((entry) => entry.id === id);
      if (!historic) throw new Error(`unknown session: ${id}`);
      if (historic.shutdownUnconfirmed) throw new Error("orphan worker shutdown unconfirmed; stop it before recording outcomes");
      if (historic.outcome !== undefined) throw new Error(`session ${id} is already finished`);
      if (outcome !== "abandoned") {
        throw new Error("archived sessions without a live verification gate can only be marked abandoned");
      }
      historic.outcome = outcome;
      if (note !== undefined) historic.outcomeNote = note;
      await this.emitFinishEvent(historic, outcome);
      this.scheduleSave();
      this.notifyWaiters();
      return;
    }
    this.assertUnfinished(rt);
    await this.withRepoGuard(rt, async () => {
      const readonlySuccess = (outcome === "success_first" || outcome === "success_second")
        && (rt.meta.spec?.purpose === "review" || rt.meta.spec?.purpose === "investigation");
      if (readonlySuccess) {
        if (!note?.trim()) throw new Error("read-only success requires an orchestrator acceptance note");
        if (rt.meta.status !== "idle" && rt.meta.status !== "stopped") throw new Error("settle the read-only worker before acceptance");
        await rt.client.refreshStreaming();
        if (rt.client.isStreaming || rt.meta.pendingQuestions.length) throw new Error("settle worker questions before acceptance");
        if (!rt.meta.lastText?.trim()) throw new Error("read-only success requires a delivered worker report");
        const diff = await worktreeDiff(rt.meta.worktree, rt.meta.baseRef);
        if (diff.files.length || !(await isWorktreeClean(rt.meta.worktree))) {
          throw new Error("read-only success requires an unchanged, clean worker worktree");
        }
        rt.meta.reviewAcceptance = {
          acceptedAt: Date.now(), workerSha: await resolveRef(rt.meta.worktree, "HEAD"), note: note.trim(),
        };
      } else if (FINISHED_OUTCOMES.has(outcome)) {
        const proof = rt.meta.verification;
        if (!proof) throw new Error("successful outcome requires current pi_verify evidence");
        await this.integrationGate.assertCurrent(rt.meta, proof.targetBranch, proof.codeChanged);
      }
      rt.meta.outcome = outcome;
      if (note !== undefined) rt.meta.outcomeNote = note;

      const historic = this.history.find((entry) => entry.id === id);
      if (historic) {
        historic.outcome = outcome;
        if (note !== undefined) historic.outcomeNote = note;
      }

      this.scheduleSave();
      this.notifyWaiters();
    });
    await this.emitFinishEvent(rt.meta, outcome);
    if (rt.meta.status === "stopped") {
      this.archive(rt.meta);
      this.scheduleSave();
    } else {
      await this.stop(id);
    }
  }

  /** Persist a finished/settled session snapshot so the scoreboard survives daemon restarts. */
  private archive(meta: SessionMeta): void {
    const snapshot: SessionMeta = { ...meta, pendingQuestions: [] };
    const index = this.history.findIndex((entry) => entry.id === meta.id);
    if (index >= 0) this.history[index] = snapshot;
    else this.history.push(snapshot);
  }

  setTestsOwned(id: string, owned: boolean): void {
    const rt = this.runtimes.get(id);
    const historic = this.history.find((entry) => entry.id === id);
    if (!rt && !historic) throw new Error(`unknown session: ${id}`);
    if (rt) rt.meta.testsOwnedByCodex = owned;
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
  async report(sessionIds?: string[]): Promise<Record<string, unknown>> {
    const selected = sessionIds === undefined ? undefined : new Set(sessionIds);
    const knownIds = new Set(this.mergedHistory().map((entry) => entry.id));
    const unknownIds = sessionIds?.filter((id) => !knownIds.has(id)) ?? [];
    if (unknownIds.length) throw new Error(`unknown session ids: ${[...new Set(unknownIds)].join(", ")}`);
    const ids = [...this.runtimes.keys()].filter((id) => selected === undefined || selected.has(id));
    await Promise.all(
      ids.map((id) => {
        const rt = this.runtimes.get(id);
        return rt ? this.refreshStats(rt, true).catch(() => {}) : Promise.resolve();
      }),
    );

    const sessions = this.list().filter((session) => selected === undefined || selected.has(session.id));
    const history = this.history.filter((session) => selected === undefined || selected.has(session.id));
    const activeTasks = sessions.filter(
      (s) => s.status === "starting" || s.status === "idle" || s.status === "working",
    ).length;

    // Merge live sessions with the persisted history (live wins on id collisions).
    const byId = new Map<string, SessionMeta>();
    for (const entry of history) byId.set(entry.id, entry);
    for (const session of sessions) byId.set(session.id, session);
    const all = [...byId.values()];

    const counts: Record<Outcome | "unrecorded", number> = {
      success_first: 0,
      success_second: 0,
      taken_over: 0,
      abandoned: 0,
      unrecorded: 0,
    };
    let workerOutput = 0;
    const byPurpose = Object.fromEntries(
      [...WORKSTREAM_PURPOSES, "unspecified"].map((purpose) => [purpose, { total: 0, counts: { ...counts } }]),
    ) as Record<WorkstreamPurpose | "unspecified", { total: number; counts: typeof counts }>;

    const inconsistentOutcomes: { id: string; reasons: string[] }[] = [];
    const tasks = all.map((session) => {
      const outcome = session.outcome ?? "unrecorded";
      if (FINISHED_OUTCOMES.has(outcome as Outcome)) {
        const reasons: string[] = [];
        if (!session.reviewAcceptance && !session.verification?.passed) reasons.push("missing passing verification or read-only acceptance");
        if (session.reviewAcceptance && session.spec?.purpose !== "review" && session.spec?.purpose !== "investigation") {
          reasons.push("read-only acceptance on non-review workstream");
        }
        if (session.verification?.codeChanged && !session.integration) reasons.push("missing integration");
        if (!session.reviewAcceptance && (session.spec?.requirements?.length || session.verification?.existingValidationChanges?.length)
          && (!session.candidateReview || session.candidateReview.verificationId !== session.verification?.id)) reasons.push("missing candidate review");
        if (session.status === "starting" || session.status === "working") reasons.push("worker still active");
        if (reasons.length) inconsistentOutcomes.push({ id: session.id, reasons });
      }
      const purpose = session.spec?.purpose ?? "unspecified";
      counts[outcome]++;
      byPurpose[purpose].total++;
      byPurpose[purpose].counts[outcome]++;
      workerOutput += session.tokens?.output ?? 0;
      return {
        id: session.id,
        name: session.name,
        status: session.status,
        outcome: session.outcome ?? "unrecorded",
        purpose,
        instructions_sent: session.instructionsSent ?? 0,
        note: session.outcomeNote,
        tests_owned_by_codex: session.testsOwnedByCodex ?? null,
        review_accepted: session.reviewAcceptance !== undefined,
        candidate_reviewed: !!session.candidateReview && session.candidateReview.verificationId === session.verification?.id,
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
      archived_tasks: history.length,
      counts,
      inconsistent_outcomes: inconsistentOutcomes,
      workstreams_by_purpose: byPurpose,
      percentages,
      delegated_success_rate: pct(counts.success_first + counts.success_second),
      first_try_rate: pct(counts.success_first),
      take_over_rate: pct(counts.taken_over),
      cost_evidence: await this.metrics(sessionIds),
      worker_output_tokens: workerOutput,
      tasks,
      note: "One 'task' = one worker workstream/session. Overall counts and rates include all purposes, not implementation contribution. Purpose is assigned by spec, not inferred from names or outcomes; unspecified means it was not recorded. Actual code contribution requires diff and integration evidence; direct orchestrator work is not measured here. Recorded successes with missing current proof or active workers appear in inconsistent_outcomes and must not be treated as verified current evidence. unrecorded means the workstream was never closed with an outcome.",
    };
  }

  /** Register sourced orchestrator accounting data without inventing missing costs. */
  recordCost(value: unknown): OrchestratorCostRecord {
    const record = validateCostRecord(value);
    record.session_ids.sort();
    const knownIds = new Set(this.mergedHistory().map((entry) => entry.id));
    if (record.session_ids.some((id) => !knownIds.has(id))) throw new Error("cost references an unknown session");
    const previous = this.orchestratorCosts.find((entry) => entry.id === record.id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(record)) throw new Error("cost record id already has different data");
      return previous;
    }
    this.orchestratorCosts.push(record);
    this.scheduleSave();
    return record;
  }

  async metrics(sessionIds?: string[]): Promise<Record<string, unknown>> {
    await Promise.all([...this.runtimes.values()].map((rt) => this.refreshStats(rt, true)));
    return summarizeCostEvidence({ active: this.list(), history: this.history,
      orchestrator_records: this.orchestratorCosts, session_ids: sessionIds });
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
  if (spec.purpose) lines.push(`Workstream purpose: ${spec.purpose}`);
  if (spec.requirements?.length) lines.push(`Hard requirements (preserve each one): ${JSON.stringify(spec.requirements)}`);
  if (spec.validation_paths?.length) lines.push(`Additional validation definitions: ${JSON.stringify(spec.validation_paths)}`);
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
  login = false,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const grouped = process.platform !== "win32";
    const proc = spawn(process.env.PI_COFFEE_BASH_BIN || "bash", [login ? "-lc" : "-c", command], { cwd, env: process.env, detached: grouped });

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
