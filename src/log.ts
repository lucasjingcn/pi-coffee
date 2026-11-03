import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Diagnostic logging shared by the daemon, its state store and the stdio proxy.
 *
 * Everything goes to stderr with an ISO-8601 timestamp: that is where the
 * supervisor already points (`~/.pi-coffee/logs/daemon.err.log`, the container's
 * stderr, or the terminal). Tags (`pi-coffee`, `state`, `pi-coffee-proxy`) are
 * stable so existing greps keep working.
 *
 * `PI_COFFEE_LOG_FORMAT=json` turns the same calls into one JSON object per line
 * for log shippers. Structured records redact credential-shaped values: machine
 * readable output must never carry a capability.
 */

/** Env var that selects the log format. Anything but `json` keeps the text format. */
export const LOG_FORMAT_ENV = "PI_COFFEE_LOG_FORMAT";

/** Level carried by structured records; text output has no level field. */
type LogLevel = "debug" | "info" | "warn" | "error";

/** Placeholder that replaces any value that looked like a credential. */
export const REDACTED = "[redacted]";

/** Longest string kept in one structured record's `details`, so a chatty value cannot flood the log. */
const MAX_DETAIL_CHARS = 2_000;

/** Depth and breadth caps for `details`, so a cyclic/huge object cannot hang or flood the log. */
const MAX_DETAIL_DEPTH = 6;
const MAX_DETAIL_ENTRIES = 100;

/** Keys whose *value* is a credential: never emitted, whatever the value looks like. */
const SECRET_KEY_RE = /(token|secret|passw|api[-_]?key|authori[sz]ation|credential|cookie|control[-_]?key|scope[-_]?key|private[-_]?key)/i;

/**
 * Inline `name=value` / `name: value` pairs for the credential names above.
 * A scheme word (`Bearer …`, `Basic …`) is left for `BEARER_RE`, so the pair
 * `authorization: Bearer <secret>` loses only the secret.
 */
const INLINE_SECRET_RE = /\b(token|secret|password|passwd|api[-_]?key|control[-_]?key|scope[-_]?key|authorization)\b(\s*[:=]\s*)(?!(?:bearer|basic)\b)("[^"]*"|'[^']*'|[^\s"',;()[\]{}]+)/gi;

/** `Bearer <credential>` headers pasted into a message. */
const BEARER_RE = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi;

/** Bare SHA-256 digests — the shape control and scope key hashes take (git SHAs are shorter). */
const HEX_SECRET_RE = /\b[0-9a-f]{64}\b/gi;

/** True when structured JSON logging is enabled for this process. */
export function isJsonLoggingEnabled(): boolean {
  return (process.env[LOG_FORMAT_ENV] ?? "").trim().toLowerCase() === "json";
}

/**
 * Scrub credential-shaped substrings from free text.
 *
 * Best effort by design: it removes the shapes the coordinator actually handles
 * (inline `token=…`/`control_key=…`, bearer headers, bare SHA-256 digests)
 * rather than trying to detect "a secret" in general. Redaction is idempotent:
 * text that already reads `token=[redacted]` is left alone.
 */
function redactText(value: string): string {
  // Bearer first: an inline `authorization: Bearer …` pair would otherwise consume
  // only the scheme word and leave the credential behind.
  return value
    .replace(BEARER_RE, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(INLINE_SECRET_RE, (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`)
    .replace(HEX_SECRET_RE, REDACTED);
}

/** Turn anything into a JSON-safe, redacted, size-bounded clone. */
function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
      return redactText(value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}…` : value);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return String(value);
    case "symbol":
      return String(value);
    case "function":
      return "[function]";
    default:
      break;
  }
  if (value instanceof Error) {
    const withCode = value as Error & { code?: unknown };
    return {
      name: value.name,
      message: redactText(value.message),
      ...(withCode.code === undefined ? {} : { code: sanitize(withCode.code, depth + 1, seen) }),
    };
  }
  if (depth >= MAX_DETAIL_DEPTH) return "[truncated]";
  const object = value as object;
  if (seen.has(object)) return "[circular]";
  seen.add(object);
  if (Array.isArray(object)) {
    const items = object.slice(0, MAX_DETAIL_ENTRIES).map((item) => sanitize(item, depth + 1, seen));
    if (object.length > MAX_DETAIL_ENTRIES) items.push("[truncated]");
    return items;
  }
  const result: Record<string, unknown> = {};
  let count = 0;
  for (const [key, entry] of Object.entries(object as Record<string, unknown>)) {
    if (count++ >= MAX_DETAIL_ENTRIES) {
      result["…"] = "[truncated]";
      break;
    }
    result[key] = SECRET_KEY_RE.test(key) ? REDACTED : sanitize(entry, depth + 1, seen);
  }
  return result;
}

/**
 * Text rendering of one non-string argument for a JSON record's `message`.
 * It starts from the *sanitized* clone, so the human-readable field is redacted
 * exactly like `details` is.
 */
function textOf(value: unknown): string {
  const safe = sanitize(value);
  if (typeof safe === "string") return safe;
  try {
    return JSON.stringify(safe) ?? String(safe);
  } catch {
    return String(safe);
  }
}

/** One structured record, before the timestamp is stamped on. */
interface StructuredLogEntry {
  level?: LogLevel;
  /** Stable event/tag name: the text format's bracketed tag. */
  event: string;
  message?: string;
  details?: unknown;
}

/**
 * Emit one structured record.
 *
 * With `PI_COFFEE_LOG_FORMAT=json` this is a single JSON object per line, always
 * carrying `ts`, `level`, `event`, `message` and `details`. Otherwise it renders
 * the familiar `[ts] [event] message` text line. Either way the payload is
 * redacted first: logging must never leak a credential.
 */
export function logStructured(entry: StructuredLogEntry): void {
  const level: LogLevel = entry.level ?? "info";
  const event = entry.event;
  const message = entry.message === undefined ? "" : redactText(entry.message);
  const details = entry.details === undefined ? undefined : sanitize(entry.details);

  if (!isJsonLoggingEnabled()) {
    console.error(`[${new Date().toISOString()}] [${event}]`, details === undefined ? message : `${message} ${JSON.stringify(details)}`);
    return;
  }

  writeJsonRecord({ level, event, message, details: details === undefined ? {} : details });
}

/**
 * Serialize one already-redacted record as a single stderr line.
 *
 * Callers pass sanitized data: re-running redaction over JSON-shaped text would
 * mangle it (a `"` inside an escaped string is not a delimiter).
 */
function writeJsonRecord(record: { level: LogLevel; event: string; message: string; details: unknown }): void {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: record.level,
    event: record.event,
    message: record.message,
    details: record.details,
  }));
}

/**
 * Log one diagnostic line. The API and the default text output are unchanged;
 * `PI_COFFEE_LOG_FORMAT=json` re-renders the same call as a single JSON record
 * (`level: "info"`, `event` = tag, `message` = the text, `details.args` = the
 * arguments as data).
 */
export function logLine(tag: string, ...args: unknown[]): void {
  if (!isJsonLoggingEnabled()) {
    console.error(`[${new Date().toISOString()}] [${tag}]`, ...args);
    return;
  }
  // Every piece is redacted before it is joined, so the readable `message` and
  // the structured `details` tell the same (secret-free) story.
  writeJsonRecord({
    level: "info",
    event: tag,
    message: redactText(args.map((argument) => (typeof argument === "string" ? argument : textOf(argument))).join(" ")),
    details: { args: args.map((argument) => sanitize(argument)) },
  });
}

/** Worker lifecycle event kinds recorded in `<dataDir>/logs/workers.jsonl`. */
export type WorkerEventKind = "spawn" | "finish" | "reclaim";

/** Hard cap for one workers.jsonl line, so a stuck query can always parse the tail. */
export const WORKER_EVENT_MAX_BYTES = 4_096;

interface WorkerEventRecord {
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
function encodeWorkerEvent(event: WorkerEventRecord): string {
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
