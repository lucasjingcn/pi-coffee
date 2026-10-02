import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  /** HTTP bind host (loopback only by default). */
  host: string;
  /** HTTP port for MCP + internal coordinator API. */
  port: number;
  /** pi executable (resolved from PATH by default). */
  piBin: string;
  /** Root directory under which per-session git worktrees are created. */
  workspaceRoot: string;
  /** Default repository when a tool call omits `repo`. */
  defaultRepo: string;
  /** Default provider/model for spawned pi sessions. */
  provider: string;
  model: string;
  /** Stronger model for an explicit manual upgrade (no automatic escalation). Empty = disabled. */
  strongModel: string;
  /** pi thinking level for workers (off|minimal|low|medium|high|xhigh|max). */
  thinking: string;
  /** Hard cap on concurrent pi sessions. */
  maxSessions: number;
  /** Soft parallelism guideline: warn when this many workers are active. */
  parallelWarnThreshold: number;
  /** Path to the worker-side pi extension. */
  extensionPath: string;
  /** Optional shared secret checked on the internal API and /mcp. */
  token: string;
  /** Directory for daemon state (locks, mailbox, board, session metadata). */
  dataDir: string;
  /** Base ref used when creating a worktree branch. */
  defaultBaseRef: string;
  /** Auto-remove finished workers' worktrees (keeps branches unless deleteBranches). */
  autoClean: boolean;
  /** Minutes a finished+idle worker is kept before the sweeper cleans it. */
  worktreeTtlMin: number;
  /** Also delete the worker branch during cleanup (default false: keep branches so work is never lost). */
  deleteBranches: boolean;
  /**
   * Glob allowlist of global plugins workers may inherit: npm/git package sources,
   * external extension entries, and MCP server names. Empty denies all; `["*"]`
   * inherits everything. Core `builtin:` extensions always survive.
   */
  workerPlugins: string[];
  /** Model silence warning, terminal silence deadline and owner idle deadline (milliseconds). */
  workerWarnMs: number;
  workerStallMs: number;
  workerIdleMs: number;
}

/** Empty env vars count as unset so an exported "" doesn't shadow the default. */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** Strict decimal integer: optional sign then digits (no whitespace/exponent). */
const INTEGER_RE = /^[+-]?\d+$/;
/** Strict decimal number: optional sign, digits, optional fraction (no whitespace/exponent). */
const NUMBER_RE = /^[+-]?\d+(?:\.\d+)?$/;

function invalid(field: string, key: string, detail: string): never {
  throw new Error(`Invalid configuration for ${field} [${key}]: ${detail}`);
}

interface NumberRules {
  integer: boolean;
  min: number;
  max: number;
  description: string;
}

function validateNumber(field: string, key: string, value: number, rules: NumberRules): number {
  const ok =
    Number.isFinite(value) &&
    (!rules.integer || Number.isSafeInteger(value)) &&
    value >= rules.min &&
    value <= rules.max;
  if (!ok) invalid(field, key, `expected ${rules.description}`);
  return value;
}

/**
 * Resolve a numeric setting, preferring an explicit override over its env var.
 * That way a valid override still wins when the env var is broken.
 */
function resolveNumber(
  overrides: Partial<Config>,
  field: "port" | "maxSessions" | "parallelWarnThreshold" | "worktreeTtlMin" | "workerWarnMs" | "workerStallMs" | "workerIdleMs",
  key: string,
  fallback: number,
  rules: NumberRules,
): number {
  const override = overrides[field];
  if (override !== undefined) {
    if (typeof override !== "number") invalid(field, key, `expected ${rules.description}`);
    return validateNumber(field, key, override, rules);
  }

  const raw = env(key);
  if (raw === undefined) return fallback;

  const pattern = rules.integer ? INTEGER_RE : NUMBER_RE;
  if (!pattern.test(raw)) invalid(field, key, `expected ${rules.description}`);
  return validateNumber(field, key, Number(raw), rules);
}

/** Boolean env vars accept only "0"/"1"; overrides must be real booleans. */
function resolveBoolean(
  overrides: Partial<Config>,
  field: "autoClean" | "deleteBranches",
  key: string,
  fallback: boolean,
): boolean {
  const override = overrides[field];
  if (override !== undefined) {
    if (typeof override !== "boolean") invalid(field, key, "expected a boolean");
    return override;
  }

  const raw = env(key);
  if (raw === undefined) return fallback;
  if (raw === "0") return false;
  if (raw === "1") return true;
  invalid(field, key, "expected 0 or 1");
}

/** Plugin allowlist env var: comma-separated globs; `*` allows everything. */
function resolvePlugins(overrides: Partial<Config>, field: "workerPlugins", key: string, fallback: string[]): string[] {
  const override = overrides[field];
  if (override !== undefined) {
    if (!Array.isArray(override) || override.some(value => typeof value !== "string" || value.trim() === "")) {
      invalid(field, key, "expected a list of non-empty pattern strings");
    }
    return (override as string[]).map(value => value.trim());
  }

  const raw = env(key);
  if (raw === undefined) return fallback;
  const patterns = raw.split(",").map(value => value.trim()).filter(value => value !== "");
  if (patterns.length === 0) invalid(field, key, "expected comma-separated patterns (use * to allow all)");
  return [...new Set(patterns)];
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  // dataDir is resolved first because workspaceRoot defaults to a subdirectory of it.
  const dataDir =
    overrides.dataDir !== undefined
      ? overrides.dataDir
      : env("PI_COFFEE_DATA_DIR") ?? join(homedir(), ".pi-coffee");

  // dist/ or src/ at runtime; the worker extension ships next to the compiled output.
  const here = dirname(fileURLToPath(import.meta.url));

  const base: Config = {
    host: env("PI_COFFEE_HOST") ?? "127.0.0.1",
    port: resolveNumber(overrides, "port", "PI_COFFEE_PORT", 8787, {
      integer: true,
      min: 1,
      max: 65535,
      description: "an integer between 1 and 65535",
    }),
    piBin: env("PI_COFFEE_PI_BIN") ?? "pi",
    workspaceRoot: env("PI_COFFEE_WORKSPACE_ROOT") ?? join(dataDir, "worktrees"),
    defaultRepo: env("PI_COFFEE_DEFAULT_REPO") ?? "",
    provider: env("PI_COFFEE_PROVIDER") ?? "deepseek",
    model: env("PI_COFFEE_MODEL") ?? "deepseek-flash",
    strongModel: env("PI_COFFEE_STRONG_MODEL") ?? "",
    thinking: env("PI_COFFEE_THINKING") ?? "xhigh",
    maxSessions: resolveNumber(overrides, "maxSessions", "PI_COFFEE_MAX_SESSIONS", 8, {
      integer: true,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      description: "a positive safe integer",
    }),
    parallelWarnThreshold: resolveNumber(
      overrides,
      "parallelWarnThreshold",
      "PI_COFFEE_PARALLEL_WARN",
      4,
      {
        integer: true,
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
        description: "a positive safe integer",
      },
    ),
    extensionPath:
      env("PI_COFFEE_EXTENSION") ?? resolve(here, "..", "extensions", "pi-coordinator.ts"),
    token: env("PI_COFFEE_TOKEN") ?? "",
    dataDir,
    defaultBaseRef: env("PI_COFFEE_BASE_REF") ?? "HEAD",
    autoClean: resolveBoolean(overrides, "autoClean", "PI_COFFEE_AUTO_CLEAN", true),
    worktreeTtlMin: resolveNumber(overrides, "worktreeTtlMin", "PI_COFFEE_WORKTREE_TTL_MIN", 60, {
      integer: false,
      min: 1,
      max: Number.MAX_SAFE_INTEGER / 60000,
      description: "a finite number between 1 and MAX_SAFE_INTEGER/60000",
    }),
    workerWarnMs: resolveNumber(overrides, "workerWarnMs", "PI_COFFEE_WORKER_WARN_MS", 60_000,
      { integer: true, min: 1, max: 2_147_483_647, description: "a positive timer-safe integer" }),
    workerStallMs: resolveNumber(overrides, "workerStallMs", "PI_COFFEE_WORKER_STALL_MS", 600_000,
      { integer: true, min: 1, max: 2_147_483_647, description: "a positive timer-safe integer" }),
    workerIdleMs: resolveNumber(overrides, "workerIdleMs", "PI_COFFEE_WORKER_IDLE_MS", 1_800_000,
      { integer: true, min: 1, max: 2_147_483_647, description: "a positive timer-safe integer" }),
    deleteBranches: resolveBoolean(overrides, "deleteBranches", "PI_COFFEE_DELETE_BRANCHES", false),
    workerPlugins: resolvePlugins(overrides, "workerPlugins", "PI_COFFEE_WORKER_PLUGINS", []),
  };

  if (base.workerStallMs <= base.workerWarnMs) invalid("workerStallMs", "PI_COFFEE_WORKER_STALL_MS", "must exceed workerWarnMs");
  // Apply caller overrides last; undefined means "keep the default".
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  return { ...base, ...defined };
}
