#!/usr/bin/env node
/**
 * pi-coffee runtime reconciliation — read-only.
 *
 * Scans the ledger (state.json) and the actual data directory, then reports
 * where the two disagree, so "which resources do not add up?" is one command:
 *
 *   node scripts/inspect.mjs                 # human-readable summary
 *   node scripts/inspect.mjs --json          # machine-readable {findings,summary}
 *   node scripts/inspect.mjs --data-dir /x   # explicit data directory
 *
 * Checks:
 *   1. every history entry's `worktree` path exists on disk          -> finding
 *   2. every worktree directory under the workspace root is recorded in history -> finding
 *   3. active locks (state.json `locks`)                             -> summary
 *   4. session transcript directory ages, with the daemon's 48h TTL  -> summary
 *   5. worktree sizes, top 5                                         -> summary
 *
 * Exit codes: 0 = no findings (clean), 1 = differences found (or the ledger is
 * unreadable), 2 = invalid command line.
 *
 * Read-only contract: this script never writes, creates, moves or deletes
 * anything — not state.json, not worktrees, not session directories. Remove or
 * repair whatever it reports with the tool of your choice (or `pi_gc`).
 *
 * Path comparison is purely lexical (resolve + trailing-separator/case
 * normalization) and never runs git: worktrees may belong to different
 * repositories, and a missing/odd worktree must not turn this command into a
 * mutation. Directory sizes are a best-effort recursive sum; symlinks are not
 * followed.
 *
 * dataDir resolution matches the daemon (src/config.ts): --data-dir flag, then
 * the PI_COFFEE_DATA_DIR environment variable, then ~/.pi-coffee. The worktree
 * root follows PI_COFFEE_WORKSPACE_ROOT, then <dataDir>/worktrees.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Mirrors SESSION_DIR_TTL_MS in src/manager.ts (48 hours). */
const SESSION_DIR_TTL_MS = 48 * 60 * 60 * 1000;
const TOP_WORKTREE_COUNT = 5;
/** Keep the human lock listing readable; --json always carries the full list. */
const HUMAN_LOCK_LIMIT = 10;

const USAGE = "Usage: node scripts/inspect.mjs [--json] [--data-dir <path>] [--help]";

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { json: false, dataDir: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--data-dir") {
      const value = argv[++i];
      if (!value) throw new UsageError("--data-dir requires a path");
      options.dataDir = value;
    } else if (arg.startsWith("--data-dir=")) {
      const value = arg.slice("--data-dir=".length);
      if (!value) throw new UsageError("--data-dir requires a path");
      options.dataDir = value;
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  return options;
}

const HELP = `${USAGE}

Read-only reconciliation of pi-coffee resources: state.json vs. disk.

Checks and output:
  1. history worktree paths missing on disk        (findings)
  2. on-disk worktree directories absent from history (findings)
  3. active locks                                  (summary)
  4. session directory ages incl. >48h, daemon TTL (summary)
  5. worktree sizes, top ${TOP_WORKTREE_COUNT}     (summary)

Exit status: 0 clean, 1 differences found (or unreadable ledger), 2 bad usage.
Nothing is written or deleted; act on the report manually or via pi_gc.`;

// ---------------------------------------------------------------------------
// Paths and formatting
// ---------------------------------------------------------------------------

function envValue(name) {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** Absolute, trailing-separator-free path used only for lexical comparison. */
function normalizePath(path) {
  const absolute = resolve(path);
  return absolute.replace(/[/\\]+$/, "") || absolute;
}

/** Comparison key; folded on Windows because its file systems are case-insensitive. */
function pathKey(path) {
  const normalized = normalizePath(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function formatAge(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "unknown";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours <= 48) return `${hours}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * readdir that distinguishes "nothing there" from "could not scan". A missing
 * directory is normal (fresh data dir); any other failure means the scan is
 * incomplete and reconciliation against it would be misleading.
 */
function readEntries(directory) {
  try {
    return { entries: readdirSync(directory, { withFileTypes: true }) };
  } catch (error) {
    if (error && error.code === "ENOENT") return { entries: [] };
    return { entries: [], error };
  }
}

/** Best-effort recursive byte sum; symlinks contribute their own size, never the target. */
function directorySize(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const dirent of readEntries(current).entries) {
      const full = join(current, dirent.name);
      if (dirent.isSymbolicLink()) {
        try {
          total += statSync(full, { throwIfNoEntry: false })?.size ?? 0;
        } catch {
          /* unreadable entry: count nothing */
        }
      } else if (dirent.isDirectory()) {
        stack.push(full);
      } else if (dirent.isFile()) {
        try {
          total += statSync(full, { throwIfNoEntry: false })?.size ?? 0;
        } catch {
          /* unreadable entry: count nothing */
        }
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Ledger (state.json)
// ---------------------------------------------------------------------------

/**
 * Parse state.json tolerantly. Missing files are a fresh boot, not a finding;
 * unreadable or structurally broken ledgers are findings because nothing can be
 * reconciled against them. Individual malformed history entries are skipped —
 * this is a diagnostic, not the daemon's strict validator.
 */
function readLedger(statePath, findings) {
  if (!existsSync(statePath)) return { status: "missing", history: [], locks: [] };

  let raw;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch (error) {
    findings.push({ kind: "state_unreadable", id: "state.json", detail: `${statePath}: ${errorMessage(error)}` });
    return { status: "unreadable", history: [], locks: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    findings.push({ kind: "state_unreadable", id: "state.json", detail: `${statePath}: malformed JSON` });
    return { status: "unreadable", history: [], locks: [] };
  }
  if (!isRecord(parsed)) {
    findings.push({ kind: "state_unreadable", id: "state.json", detail: `${statePath}: expected a JSON object` });
    return { status: "unreadable", history: [], locks: [] };
  }

  let status = "ok";
  const malformed = (detail) => {
    findings.push({ kind: "state_unreadable", id: "state.json", detail });
    status = "malformed";
  };

  let history = [];
  if (parsed.history !== undefined && !Array.isArray(parsed.history)) {
    malformed(`${statePath}: "history" is not an array`);
  } else if (Array.isArray(parsed.history)) {
    history = parsed.history.filter(isRecord);
  }

  let locks = [];
  if (parsed.locks !== undefined && !Array.isArray(parsed.locks)) {
    malformed(`${statePath}: "locks" is not an array`);
  } else if (Array.isArray(parsed.locks)) {
    locks = parsed.locks.filter(isRecord);
  }

  return { status, history, locks };
}

/** Check 1: ledger entries whose worktree path is gone from disk. */
function checkMissingWorktrees(history, findings) {
  const ledger = new Map();
  for (const entry of history) {
    if (typeof entry.worktree !== "string" || entry.worktree.trim() === "") continue;
    const path = normalizePath(entry.worktree);
    const id = typeof entry.id === "string" && entry.id !== "" ? entry.id : path;
    ledger.set(pathKey(path), { id, path });
    if (existsSync(path)) continue;

    const status = typeof entry.status === "string" ? entry.status : "unknown";
    const outcome = typeof entry.outcome === "string" ? entry.outcome : "none";
    findings.push({
      kind: "missing_worktree",
      id,
      detail: `${path} (status=${status}, outcome=${outcome})`,
    });
  }
  return ledger;
}

// ---------------------------------------------------------------------------
// Disk: worktrees
// ---------------------------------------------------------------------------

/** Check 2 + check 5: scan the workspace root for worktree directories and sizes. */
function scanWorktrees(workspaceRoot, ledger, findings) {
  const worktrees = [];
  const { entries, error } = readEntries(workspaceRoot);
  if (error) {
    findings.push({ kind: "unreadable_directory", id: "worktrees", detail: `${workspaceRoot}: ${errorMessage(error)}` });
  }
  for (const dirent of entries) {
    const path = normalizePath(join(workspaceRoot, dirent.name));
    let stat;
    try {
      stat = statSync(path); // follows symlinks: a linked worktree still exists
    } catch {
      continue; // broken symlink / vanished entry: nothing to reconcile by path
    }
    if (!stat.isDirectory()) continue;

    const bytes = directorySize(path);
    worktrees.push({ id: dirent.name, path, bytes, mtimeMs: stat.mtimeMs });
    if (!ledger.has(pathKey(path))) {
      findings.push({
        kind: "orphan_worktree",
        id: dirent.name,
        detail: `${path} (${formatBytes(bytes)}, mtime ${new Date(stat.mtimeMs).toISOString()})`,
      });
    }
  }
  worktrees.sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return worktrees;
}

// ---------------------------------------------------------------------------
// Summary sections
// ---------------------------------------------------------------------------

/** Check 3: active locks as recorded in the last persisted state. */
function collectLocks(locks, now) {
  return locks
    .map((lock) => {
      const ts = Number.isFinite(lock.ts) ? lock.ts : null;
      return {
        sessionId: typeof lock.sessionId === "string" ? lock.sessionId : "unknown",
        mode: typeof lock.mode === "string" ? lock.mode : "unknown",
        path: typeof lock.path === "string" ? lock.path : "",
        repo: typeof lock.repo === "string" ? lock.repo : "",
        ts,
        ageMs: ts === null ? null : Math.max(0, now - ts),
      };
    })
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

/**
 * Check 4: session directory age distribution.
 *
 * The reference time is max(history.lastActivity, directory mtime), matching the
 * daemon's sweepSessionDirs eligibility check; a directory with no ledger entry
 * falls back to its mtime alone. `sweepCandidates` are the stopped sessions the
 * daemon would reclaim on its next sweep (age > 48h).
 */
function collectSessionAge(sessionsRoot, historyById, now, findings) {
  const buckets = { under6h: 0, under24h: 0, under48h: 0, over48h: 0 };
  const summary = { total: 0, buckets, over48h: 0, sweepCandidates: 0, untracked: 0, oldestMs: null, ttlMs: SESSION_DIR_TTL_MS };

  const { entries, error } = readEntries(sessionsRoot);
  if (error) {
    findings.push({ kind: "unreadable_directory", id: "sessions", detail: `${sessionsRoot}: ${errorMessage(error)}` });
  }

  for (const dirent of entries) {
    const path = join(sessionsRoot, dirent.name);
    let mtimeMs;
    try {
      const stat = statSync(path);
      if (!stat.isDirectory()) continue;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }

    const meta = historyById.get(dirent.name);
    const lastActivity = meta && Number.isFinite(meta.lastActivity) ? meta.lastActivity : 0;
    const ageMs = Math.max(0, now - Math.max(lastActivity, mtimeMs));
    summary.total += 1;
    summary.oldestMs = Math.max(summary.oldestMs ?? 0, ageMs);
    if (!meta) summary.untracked += 1;

    if (ageMs > SESSION_DIR_TTL_MS) {
      buckets.over48h += 1;
      if (meta && meta.status === "stopped") summary.sweepCandidates += 1;
    } else if (ageMs >= 24 * 60 * 60 * 1000) {
      buckets.under48h += 1;
    } else if (ageMs >= 6 * 60 * 60 * 1000) {
      buckets.under24h += 1;
    } else {
      buckets.under6h += 1;
    }
  }
  summary.over48h = buckets.over48h;
  return summary;
}

function historyIndex(history) {
  const byId = new Map();
  for (const entry of history) {
    if (typeof entry.id === "string" && entry.id !== "") byId.set(entry.id, entry);
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function sortFindings(findings) {
  const compare = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
  findings.sort((a, b) => (a.kind === b.kind ? compare(a.id, b.id) : a.kind.localeCompare(b.kind)));
}

function findingsBreakdown(findings) {
  const counts = new Map();
  for (const finding of findings) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => `${kind} ${count}`).join(", ");
}

function printHuman(report) {
  const { findings, summary } = report;
  console.log("pi-coffee inspect (read-only reconciliation)");
  console.log(`  dataDir:       ${summary.dataDir}`);
  console.log(`  workspaceRoot: ${summary.workspaceRoot}`);
  console.log(`  state:         ${summary.stateStatus} (${summary.stateFile})`);
  console.log(`  ledger:        ${summary.historySessions} sessions / ${summary.historyWorktrees} recorded worktrees; disk: ${summary.worktreesOnDisk} worktrees`);

  console.log("");
  if (findings.length === 0) {
    console.log("findings: none — ledger and disk reconcile");
  } else {
    console.log(`findings: ${findings.length}`);
    for (const finding of findings) console.log(`  [${finding.kind}] ${finding.id}: ${finding.detail}`);
  }

  console.log("");
  const locks = summary.activeLocks;
  console.log(`locks: ${locks.length} active`);
  for (const lock of locks.slice(0, HUMAN_LOCK_LIMIT)) {
    const repo = lock.repo ? ` repo=${lock.repo}` : "";
    console.log(`  ${lock.sessionId}  ${lock.mode}  ${lock.path}  (age ${formatAge(lock.ageMs)})${repo}`);
  }
  if (locks.length > HUMAN_LOCK_LIMIT) console.log(`  ... ${locks.length - HUMAN_LOCK_LIMIT} more (use --json for the full list)`);

  console.log("");
  const age = summary.sessionAge;
  console.log(`sessions: ${age.total} dirs (TTL ${formatAge(age.ttlMs)})`);
  console.log(`  buckets: <6h ${age.buckets.under6h} | 6-24h ${age.buckets.under24h} | 24-48h ${age.buckets.under48h} | >=48h ${age.buckets.over48h}`);
  if (age.over48h > 0) {
    console.log(`  >=48h: ${age.over48h} (daemon sweep candidates: ${age.sweepCandidates}; no ledger entry: ${age.untracked})`);
  }

  console.log("");
  const sizes = summary.worktreeSizes;
  if (sizes.length === 0) {
    console.log("worktrees by size: none on disk");
  } else {
    console.log(`worktrees by size (top ${sizes.length} of ${summary.worktreesOnDisk}, total ${formatBytes(summary.worktreeBytesTotal)}):`);
    for (const item of sizes) console.log(`  ${formatBytes(item.bytes).padStart(9)}  ${item.id}  ${item.path}`);
  }

  console.log("");
  console.log(findings.length === 0
    ? "result: no differences — clean (exit 0)"
    : `result: ${findings.length} difference(s) (${findingsBreakdown(findings)}) — exit 1`);
}

function run() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`inspect: ${errorMessage(error)}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }

  const now = Date.now();
  const dataDir = resolve(options.dataDir ?? envValue("PI_COFFEE_DATA_DIR") ?? join(homedir(), ".pi-coffee"));
  const workspaceRoot = resolve(envValue("PI_COFFEE_WORKSPACE_ROOT") ?? join(dataDir, "worktrees"));
  const sessionsRoot = join(dataDir, "sessions");
  const stateFile = join(dataDir, "state.json");

  const findings = [];
  const ledger = readLedger(stateFile, findings);
  const ledgerWorktrees = checkMissingWorktrees(ledger.history, findings);
  const diskWorktrees = scanWorktrees(workspaceRoot, ledgerWorktrees, findings);
  const sessionAge = collectSessionAge(sessionsRoot, historyIndex(ledger.history), now, findings);
  sortFindings(findings);

  const report = {
    findings,
    summary: {
      dataDir,
      workspaceRoot,
      stateFile,
      stateStatus: ledger.status,
      historySessions: ledger.history.length,
      historyWorktrees: ledgerWorktrees.size,
      worktreesOnDisk: diskWorktrees.length,
      activeLocks: collectLocks(ledger.locks, now),
      sessionAge,
      worktreeSizes: diskWorktrees.slice(0, TOP_WORKTREE_COUNT).map(({ id, path, bytes }) => ({ id, path, bytes })),
      worktreeBytesTotal: diskWorktrees.reduce((total, item) => total + item.bytes, 0),
    },
  };

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);

  process.exitCode = findings.length > 0 ? 1 : 0;
}

run();
