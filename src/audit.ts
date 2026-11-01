/**
 * Hash-chained audit log for coordinator actions.
 *
 * Every state-changing action appends one JSONL entry. Entries form a chain:
 * `hash = sha256(prevHash, seq, ts, payloadSha256)`. Files rotate by size, and a
 * sidecar (`audit.head.json`) records the newest seq/hash so tail truncation is
 * detectable. The chain is written by one process at a time and appended with
 * best-effort durability; a failed append fails the guarded action.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AuditEntry {
  seq: number;
  ts: number;
  actor: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
  payloadSha256: string;
  prevHash: string;
  hash: string;
}

export interface AuditHead {
  file: string;
  seq: number;
  hash: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  entries: number;
  files: string[];
  firstBrokenSeq?: number;
  reason?: string;
  head?: AuditHead;
}

export interface AuditLogOptions {
  dir: string;
  /** Roll to a new file once the current one reaches this size. */
  maxBytes?: number;
  now?: () => number;
}

export const GENESIS_HASH = "0".repeat(64);
const FILE_RE = /^audit-(\d{4})\.jsonl$/;
const HEAD_FILE = "audit.head.json";
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** Stable JSON encoding: object keys sorted, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") {
      return input === undefined ? null : input;
    }
    if (Array.isArray(input)) return input.map(normalize);
    const record = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      out[key] = normalize(record[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function auditPayloadSha256(actor: string, action: string, target: string, detail?: Record<string, unknown>): string {
  return sha256(canonicalJson({ actor, action, target, detail: detail ?? {} }));
}

export function auditEntryHash(prevHash: string, seq: number, ts: number, payloadSha256: string): string {
  return sha256(`${prevHash}\n${seq}\n${ts}\n${payloadSha256}`);
}

export function buildAuditEntry(
  prevHash: string,
  seq: number,
  ts: number,
  actor: string,
  action: string,
  target: string,
  detail?: Record<string, unknown>,
): AuditEntry {
  const payloadSha256 = auditPayloadSha256(actor, action, target, detail);
  return {
    seq,
    ts,
    actor,
    action,
    target,
    ...(detail ? { detail } : {}),
    payloadSha256,
    prevHash,
    hash: auditEntryHash(prevHash, seq, ts, payloadSha256),
  };
}

interface ChainProblem {
  ok: boolean;
  firstBrokenSeq?: number;
  reason?: string;
}

/** Pure chain validation over already-parsed entries, in file/line order. */
export function verifyAuditEntries(entries: AuditEntry[]): ChainProblem {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const entry of entries) {
    if (typeof entry.seq !== "number" || entry.seq !== expectedSeq) {
      return { ok: false, firstBrokenSeq: entry.seq, reason: `expected seq ${expectedSeq}, got ${String(entry.seq)}` };
    }
    if (entry.prevHash !== prevHash) {
      return { ok: false, firstBrokenSeq: entry.seq, reason: "prevHash does not match the previous entry" };
    }
    const payload = auditPayloadSha256(entry.actor, entry.action, entry.target, entry.detail);
    if (payload !== entry.payloadSha256) {
      return { ok: false, firstBrokenSeq: entry.seq, reason: "payload hash mismatch" };
    }
    const hash = auditEntryHash(entry.prevHash, entry.seq, entry.ts, entry.payloadSha256);
    if (hash !== entry.hash) {
      return { ok: false, firstBrokenSeq: entry.seq, reason: "entry hash mismatch" };
    }
    prevHash = entry.hash;
    expectedSeq += 1;
  }
  return { ok: true };
}

export class AuditLog {
  readonly dir: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private cachedHead?: AuditHead;
  private closed = false;

  constructor(options: AuditLogOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes !== undefined && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  private filePath(file: string): string {
    return join(this.dir, file);
  }

  private headPath(): string {
    return join(this.dir, HEAD_FILE);
  }

  /** Keep appends serialized; a failed append does not poison the queue. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fileIndexes(): Promise<number[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    return names
      .map((name) => FILE_RE.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
  }

  private static fileName(index: number): string {
    return `audit-${String(index).padStart(4, "0")}.jsonl`;
  }

  private async readHead(): Promise<AuditHead | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.headPath(), "utf8")) as Partial<AuditHead>;
      if (typeof raw.file === "string" && typeof raw.seq === "number" && typeof raw.hash === "string") {
        return { file: raw.file, seq: raw.seq, hash: raw.hash };
      }
    } catch {
      // Missing or unreadable head: reconstruct below.
    }
    return undefined;
  }

  private async lastEntryOf(file: string): Promise<AuditEntry | undefined> {
    let text: string;
    try {
      text = await readFile(this.filePath(file), "utf8");
    } catch {
      return undefined;
    }
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]) as AuditEntry;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /** Reconstruct the head from disk when the sidecar is missing or stale. */
  private async resolveHead(): Promise<AuditHead> {
    const sidecar = await this.readHead();
    const indexes = await this.fileIndexes();
    if (indexes.length === 0) {
      return sidecar ?? { file: AuditLog.fileName(1), seq: 0, hash: GENESIS_HASH };
    }
    const newest = AuditLog.fileName(indexes[indexes.length - 1]);
    const last = await this.lastEntryOf(newest);
    if (!last) return sidecar ?? { file: AuditLog.fileName(1), seq: 0, hash: GENESIS_HASH };
    if (sidecar && sidecar.seq >= last.seq && sidecar.file === newest) return sidecar;
    const repaired: AuditHead = { file: newest, seq: last.seq, hash: last.hash };
    this.cachedHead = repaired;
    return repaired;
  }

  private async writeHead(head: AuditHead): Promise<void> {
    const target = this.headPath();
    const temp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(temp, JSON.stringify(head) + "\n", { mode: 0o600 });
    await rename(temp, target);
    this.cachedHead = head;
  }

  /** Stop accepting entries. Drained by the coordinator before tests/cleanup remove state. */
  async close(): Promise<void> {
    await this.drain();
    this.closed = true;
  }

  /** Append one entry. Rejects when the log cannot be written. */
  async append(actor: string, action: string, target: string, detail?: Record<string, unknown>): Promise<AuditEntry> {
    return this.enqueue(async () => {
      if (this.closed) throw new Error("audit log is closed");
      await mkdir(this.dir, { recursive: true });
      let head = this.cachedHead ?? (await this.resolveHead());
      let file = head.file;
      let index = Number(FILE_RE.exec(file)?.[1] ?? 1);
      try {
        const info = await stat(this.filePath(file));
        if (info.size >= this.maxBytes) {
          index += 1;
          file = AuditLog.fileName(index);
        }
      } catch {
        // Current file does not exist yet.
      }
      const entry = buildAuditEntry(head.hash, head.seq + 1, this.now(), actor, action, target, detail);
      await appendFile(this.filePath(file), JSON.stringify(entry) + "\n", { mode: 0o600 });
      head = { file, seq: entry.seq, hash: entry.hash };
      // The entry is durable from here on, so advance the cached head before the
      // sidecar write: otherwise a failed writeHead leaves the in-memory head on
      // the previous sequence and the next append reuses this seq, breaking the
      // chain permanently (`resolveHead` repairs the sidecar from the file).
      this.cachedHead = head;
      await this.writeHead(head);
      return entry;
    });
  }

  /** Parse every entry in file order. Unreadable files are reported, not skipped. */
  async entries(): Promise<{ entries: AuditEntry[]; files: string[]; error?: string }> {
    const indexes = await this.fileIndexes();
    const files = indexes.map((index) => AuditLog.fileName(index));
    const entries: AuditEntry[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = await readFile(this.filePath(file), "utf8");
      } catch (error) {
        return { entries, files, error: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` };
      }
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          entries.push(JSON.parse(line) as AuditEntry);
        } catch {
          return { entries, files, error: `malformed entry in ${file}` };
        }
      }
    }
    return { entries, files };
  }

  /** Recompute the whole chain and compare the tail against the head sidecar. */
  async verify(): Promise<AuditVerifyResult> {
    const parsed = await this.entries();
    if (parsed.error) {
      return { ok: false, entries: parsed.entries.length, files: parsed.files, reason: parsed.error };
    }
    const entries = parsed.entries;
    if (entries.length === 0) {
      const head = await this.readHead();
      return { ok: head === undefined || head.seq === 0, entries: 0, files: parsed.files, ...(head ? { head } : {}) };
    }
    const chain = verifyAuditEntries(entries);
    if (!chain.ok) {
      return { ok: false, entries: entries.length, files: parsed.files, firstBrokenSeq: chain.firstBrokenSeq, reason: chain.reason };
    }
    const last = entries[entries.length - 1];
    const sidecar = await this.readHead();
    if (!sidecar) {
      return { ok: false, entries: entries.length, files: parsed.files, reason: "audit head sidecar is missing" };
    }
    if (sidecar.seq > last.seq) {
      return {
        ok: false,
        entries: entries.length,
        files: parsed.files,
        head: sidecar,
        reason: `audit head claims seq ${sidecar.seq} but log ends at ${last.seq}`,
      };
    }
    const anchored = entries.find((entry) => entry.seq === sidecar.seq);
    if (!anchored || anchored.hash !== sidecar.hash) {
      return {
        ok: false,
        entries: entries.length,
        files: parsed.files,
        head: sidecar,
        firstBrokenSeq: sidecar.seq,
        reason: "audit head hash does not match the chained entry",
      };
    }
    return { ok: true, entries: entries.length, files: parsed.files, head: sidecar };
  }

  /** Newest `limit` entries, newest last. */
  async tail(limit = 50): Promise<AuditEntry[]> {
    const bound = Math.max(1, Math.min(1000, Math.floor(limit)));
    const parsed = await this.entries();
    return parsed.entries.slice(-bound);
  }

  /** Total bytes across audit files (for metrics and GC decisions). */
  async sizeBytes(): Promise<number> {
    let total = 0;
    for (const index of await this.fileIndexes()) {
      try {
        total += (await stat(this.filePath(AuditLog.fileName(index)))).size;
      } catch {
        continue;
      }
    }
    return total;
  }

  /** Flush helper for tests: wait for queued appends to finish. */
  async drain(): Promise<void> {
    await this.queue.catch(() => undefined);
  }
}

/** Touch a file so future compactions can distinguish an empty log from a missing one. */
export async function ensureAuditDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await open(join(dir, ".keep"), "a", 0o600);
  } catch {
    // Best effort: the directory still exists.
  }
}
