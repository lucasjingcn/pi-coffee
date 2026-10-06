import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Diagnostic logging shared by the daemon, its state store and the stdio proxy.
 *
 * Every line goes to stderr — the destination the supervisor already points at
 * (`~/.pi-coffee/logs/daemon.err.log` under launchd/systemd, the container's
 * stderr, or the terminal in foreground mode) — with an ISO-8601 timestamp so
 * the log can be read without guessing when something happened.
 *
 * Tags stay stable (`pi-coffee`, `state`, `pi-coffee-proxy`) so existing greps
 * keep working; only the timestamp prefix is new.
 */
export function logLine(tag: string, ...args: unknown[]): void {
  console.error(`[${new Date().toISOString()}] [${tag}]`, ...args);
}

/** Worker lifecycle event kinds recorded in `<dataDir>/logs/workers.jsonl`. */
export type WorkerEventKind = "spawn" | "finish" | "reclaim";

/** Hard cap for one workers.jsonl line, so a stuck query can always parse the tail. */
export const WORKER_EVENT_MAX_BYTES = 4_096;

export interface WorkerEventRecord {
  ts: string;
  id: string;
  event: WorkerEventKind;
  [field: string]: unknown;
}

/**
 * Serialize one worker lifecycle event as a single JSON line.
 *
 * The envelope (ts/id/event) always survives. When optional fields would push
 * the line past the 4 KB budget they are dropped and `truncated` is set: a
 * caller that only needs "what happened to this session" still gets an answer
 * instead of an oversized line.
 */
export function encodeWorkerEvent(event: WorkerEventRecord): string {
  const line = JSON.stringify(event);
  if (Buffer.byteLength(line, "utf8") <= WORKER_EVENT_MAX_BYTES) return line;
  return JSON.stringify({ ts: event.ts, id: event.id, event: event.event, truncated: true });
}

/**
 * Append one worker lifecycle event to its append-only JSONL file, creating the
 * parent directory on first use.
 *
 * Diagnostics must never affect a worker lifecycle, so every failure is logged
 * through `logLine` exactly once and swallowed; the caller gets `false` when
 * the event was not written and can carry on.
 */
export function appendWorkerEvent(file: string, event: WorkerEventRecord): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, encodeWorkerEvent(event) + "\n", "utf8");
    return true;
  } catch (error) {
    logLine("pi-coffee", `worker event log write failed (${file}): ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
