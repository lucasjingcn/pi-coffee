import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { BoardEntry, MailMessage, MessageKind } from "./mailbox.js";
import type { Outcome, SessionMeta, SessionStatus } from "./manager.js";
import { validateCostRecord, type OrchestratorCostRecord } from "./cost-evidence.js";

/** Validated, in-memory view of the persisted coordinator state. */
export interface StateSnapshot {
  counter: number;
  mailbox: MailMessage[];
  board: BoardEntry[];
  history: SessionMeta[];
  orchestratorCosts: OrchestratorCostRecord[];
}

export interface LoadResult {
  state: StateSnapshot;
  /** True when the primary was missing/corrupt and the state came from the backup. */
  recoveredFromBackup: boolean;
}

const MESSAGE_KINDS = new Set<MessageKind>(["note", "question", "answer", "broadcast"]);
const STATUSES = new Set<SessionStatus>(["starting", "idle", "working", "error", "stopped"]);
const OUTCOMES = new Set<Outcome>(["success_first", "success_second", "taken_over", "abandoned"]);

type ReadResult = { kind: "ok"; raw: string } | { kind: "missing" } | { kind: "error"; error: unknown };
type ValidateResult = { ok: true; state: StateSnapshot } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throw a path-scoped validation error. Callers prefix the file, so messages stay contextual. */
function fail(file: string, detail: string): never {
  throw new Error(`invalid state in ${file}: ${detail}`);
}

function safeReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyState(): StateSnapshot {
  return { counter: 0, mailbox: [], board: [], history: [], orchestratorCosts: [] };
}

/**
 * Validate a whole persisted snapshot before any of it is applied to live
 * coordinator objects. Missing optional collections default to empty. Locks are
 * intentionally not validated: session locks never survive a restart, so the
 * loader drops them unconditionally.
 */
export function validateSnapshot(raw: unknown, file: string): StateSnapshot {
  if (!isRecord(raw)) fail(file, "expected a JSON object");

  let counter = 0;
  if (raw.counter !== undefined) {
    if (typeof raw.counter !== "number" || !Number.isSafeInteger(raw.counter) || raw.counter < 0) {
      fail(file, '"counter" must be a nonnegative safe integer');
    }
    counter = raw.counter;
  }

  const mailbox = optionalArray(raw.mailbox, file, "mailbox", validateMailboxEntry);
  const board = optionalArray(raw.board, file, "board", validateBoardEntry);
  const history = optionalArray(raw.history, file, "history", validateHistoryEntry);
  const orchestratorCosts = optionalArray(raw.orchestratorCosts, file, "orchestratorCosts", (entry, index) => {
    try { return validateCostRecord(entry); } catch { fail(file, `orchestratorCosts[${index}] is invalid`); }
  });
  const costIds = new Set<string>();
  for (const record of orchestratorCosts) {
    if (costIds.has(record.id)) fail(file, "duplicate orchestrator cost id");
    costIds.add(record.id);
    if (record.session_ids.some((id) => !history.some((entry) => entry.id === id))) fail(file, "cost references unknown history session");
  }

  // Session ids are allocated as s<N>. Bumping the counter to at least the
  // highest id seen in history prevents a restart from reusing an id that
  // history already records. An out-of-range numeric suffix is a shape error, so
  // a hostile/broken snapshot cannot derail future allocations.
  history.forEach((entry, index) => {
    const match = /^s(\d+)$/.exec(entry.id);
    if (!match) return;
    const n = Number(match[1]);
    if (!Number.isSafeInteger(n)) {
      fail(file, `history[${index}].id has an out-of-range session number`);
    }
    counter = Math.max(counter, n);
  });

  return { counter, mailbox, board, history, orchestratorCosts };
}

function optionalArray<T>(
  value: unknown,
  file: string,
  field: string,
  validate: (entry: unknown, index: number, file: string) => T,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(file, `"${field}" must be an array`);
  return value.map((entry, index) => validate(entry, index, file));
}

function validateMailboxEntry(entry: unknown, index: number, file: string): MailMessage {
  const at = `mailbox[${index}]`;
  if (!isRecord(entry)) fail(file, `${at} must be an object`);
  const { id, from, to, kind, text, ts, read, readBy } = entry;

  if (typeof id !== "string") fail(file, `${at}.id must be a string`);
  if (typeof from !== "string") fail(file, `${at}.from must be a string`);
  if (typeof to !== "string") fail(file, `${at}.to must be a string`);
  if (typeof text !== "string") fail(file, `${at}.text must be a string`);
  if (typeof kind !== "string" || !MESSAGE_KINDS.has(kind as MessageKind)) {
    fail(file, `${at}.kind is not a known message kind`);
  }
  if (typeof ts !== "number" || !Number.isFinite(ts)) fail(file, `${at}.ts must be a finite number`);
  if (typeof read !== "boolean") fail(file, `${at}.read must be a boolean`);

  let normalizedReadBy: string[] | undefined;
  if (readBy !== undefined) {
    if (!Array.isArray(readBy) || !readBy.every((v) => typeof v === "string")) {
      fail(file, `${at}.readBy must be an array of strings`);
    }
    normalizedReadBy = [...readBy];
  }

  return {
    id,
    from,
    to,
    kind: kind as MessageKind,
    text,
    ts,
    read,
    ...(normalizedReadBy !== undefined ? { readBy: normalizedReadBy } : {}),
  };
}

function validateBoardEntry(entry: unknown, index: number, file: string): BoardEntry {
  const at = `board[${index}]`;
  if (!isRecord(entry)) fail(file, `${at} must be an object`);
  const { board, key, value, from, ts } = entry;

  if (typeof board !== "string") fail(file, `${at}.board must be a string`);
  if (typeof key !== "string") fail(file, `${at}.key must be a string`);
  if (typeof value !== "string") fail(file, `${at}.value must be a string`);
  if (typeof from !== "string") fail(file, `${at}.from must be a string`);
  if (typeof ts !== "number" || !Number.isFinite(ts)) fail(file, `${at}.ts must be a finite number`);

  return { board, key, value, from, ts };
}

function validateHistoryEntry(entry: unknown, index: number, file: string): SessionMeta {
  const at = `history[${index}]`;
  if (!isRecord(entry)) fail(file, `${at} must be an object`);

  const id = entry.id;
  if (typeof id !== "string" || id.length === 0) fail(file, `${at}.id must be a nonempty string`);

  for (const field of ["repo", "worktree", "branch", "cwd", "baseRef", "name"] as const) {
    if (typeof entry[field] !== "string") fail(file, `${at}.${field} must be a string`);
  }

  const status = entry.status;
  if (typeof status !== "string" || !STATUSES.has(status as SessionStatus)) {
    fail(file, `${at}.status is not a known status`);
  }

  if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt)) {
    fail(file, `${at}.createdAt must be a finite number`);
  }
  if (typeof entry.lastActivity !== "number" || !Number.isFinite(entry.lastActivity)) {
    fail(file, `${at}.lastActivity must be a finite number`);
  }
  if (!Array.isArray(entry.pendingQuestions)) fail(file, `${at}.pendingQuestions must be an array`);

  const outcome = entry.outcome;
  if (outcome !== undefined && (typeof outcome !== "string" || !OUTCOMES.has(outcome as Outcome))) {
    fail(file, `${at}.outcome is not a known outcome`);
  }

  if (entry.acceptance !== undefined) {
    if (!isRecord(entry.acceptance) || !Array.isArray(entry.acceptance.files)
      || !entry.acceptance.files.every((p) => typeof p === "string")
      || (entry.acceptance.command !== undefined && typeof entry.acceptance.command !== "string")
      || (entry.acceptance.hashes !== undefined && (!isRecord(entry.acceptance.hashes)
        || !Object.values(entry.acceptance.hashes).every((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))))) {
      fail(file, `${at}.acceptance is invalid`);
    }
  }
  if (entry.verification !== undefined) {
    const proof = entry.verification;
    if (!isRecord(proof) || typeof proof.epoch !== "string" || typeof proof.command !== "string"
      || typeof proof.targetBranch !== "string" || typeof proof.passed !== "boolean" || typeof proof.codeChanged !== "boolean"
      || typeof proof.verifiedAt !== "number" || !Number.isFinite(proof.verifiedAt)
      || ![proof.workerSha, proof.targetSha, proof.candidateTree].every((v) => typeof v === "string" && /^[a-f0-9]{40,64}$/.test(v))
      || !Array.isArray(proof.changedFiles) || !proof.changedFiles.every((v) => typeof v === "string")
      || !isRecord(proof.result) || typeof proof.result.stdout !== "string" || typeof proof.result.stderr !== "string"
      || typeof proof.result.timedOut !== "boolean" || !(proof.result.code === null || Number.isInteger(proof.result.code))) {
      fail(file, `${at}.verification is invalid`);
    }
  }
  if (entry.integration !== undefined) {
    const record = entry.integration;
    if (!isRecord(record) || typeof record.targetBranch !== "string" || typeof record.integratedAt !== "number"
      || !Number.isFinite(record.integratedAt)
      || ![record.workerSha, record.previousTargetSha, record.mergedSha, record.candidateTree]
        .every((v) => typeof v === "string" && /^[a-f0-9]{40,64}$/.test(v))) fail(file, `${at}.integration is invalid`);
  }

  return { ...(entry as unknown as SessionMeta) };
}

/**
 * Owns the primary state file and its atomic backup. Every read validates the
 * whole snapshot; every write backs up a previously validated primary, then
 * swaps a uniquely named temp file into place.
 */
export class StateStore {
  private seq = 0;

  constructor(readonly path: string) {}

  get backupPath(): string {
    return `${this.path}.bak`;
  }

  async load(): Promise<LoadResult> {
    const primary = await this.readIfExists(this.path);
    if (primary.kind === "error") this.readError(this.path, primary.error);

    if (primary.kind === "ok") {
      const parsed = this.tryValidate(primary.raw, this.path);
      // Happy path: a valid primary is authoritative.
      if (parsed.ok) return { state: parsed.state, recoveredFromBackup: false };

      const backup = await this.readIfExists(this.backupPath);
      if (backup.kind === "error") this.readError(this.backupPath, backup.error);
      if (backup.kind === "missing") {
        this.logLoadFailure(this.path, parsed.reason, "no usable backup present");
        throw new Error(`cannot load state: ${this.path} is invalid (${parsed.reason}) and no backup exists`);
      }

      const recovered = this.tryValidate(backup.raw, this.backupPath);
      if (!recovered.ok) {
        this.logLoadFailure(this.path, parsed.reason, `backup ${this.backupPath} is invalid: ${recovered.reason}`);
        throw new Error(`cannot load state: ${this.path} and its backup are both invalid`);
      }
      this.warnRecovered(parsed.reason, this.backupPath);
      return { state: recovered.state, recoveredFromBackup: true };
    }

    // Primary is missing: a valid backup still recovers; both missing is a
    // quiet fresh boot.
    const backup = await this.readIfExists(this.backupPath);
    if (backup.kind === "error") this.readError(this.backupPath, backup.error);
    if (backup.kind === "missing") return { state: emptyState(), recoveredFromBackup: false };

    const recovered = this.tryValidate(backup.raw, this.backupPath);
    if (!recovered.ok) {
      this.logLoadFailure(this.backupPath, "primary state is missing", recovered.reason);
      throw new Error(`cannot load state from ${this.backupPath}: ${recovered.reason}`);
    }
    this.warnRecovered("primary state file is missing", this.backupPath);
    return { state: recovered.state, recoveredFromBackup: true };
  }

  async write(data: unknown): Promise<void> {
    await this.backupValidPrimary();
    await this.atomicWrite(this.path, JSON.stringify(data, null, 2));
  }

  private async readIfExists(path: string): Promise<ReadResult> {
    try {
      return { kind: "ok", raw: await readFile(path, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "missing" };
      return { kind: "error", error };
    }
  }

  /** Log a contextual read failure (operation/path/code) before surfacing the underlying error. */
  private readError(path: string, error: unknown): never {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = safeReason(error);
    console.error(`[state] load failed for ${path}${code ? ` [${code}]` : ""}: ${detail}`);
    throw error;
  }

  private tryValidate(raw: string, file: string): ValidateResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Never echo the raw payload (it may contain secrets/state); a fixed reason is enough.
      return { ok: false, reason: "malformed JSON" };
    }
    try {
      return { ok: true, state: validateSnapshot(parsed, file) };
    } catch (error) {
      return { ok: false, reason: safeReason(error) };
    }
  }

  /**
   * Snapshot a valid primary to the backup before overwriting it. A corrupt or
   * missing primary never replaces an existing good backup: the previous write
   * already captured that state.
   */
  private async backupValidPrimary(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    try {
      validateSnapshot(parsed, this.path);
    } catch {
      return;
    }

    await this.atomicWrite(this.backupPath, JSON.stringify(parsed, null, 2));
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const tmp = `${target}.${process.pid}.${++this.seq}.tmp`;
    try {
      await writeFile(tmp, content);
      await rename(tmp, target);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  private warnRecovered(reason: string, backupPath: string): void {
    console.error(`[state] recovered ${this.path} from backup ${backupPath} (${reason})`);
  }

  private logLoadFailure(file: string, reason: string, detail: string): void {
    console.error(`[state] failed to load ${file}: ${reason}; ${detail}`);
  }
}
