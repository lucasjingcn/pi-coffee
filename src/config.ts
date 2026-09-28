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
  /** Stronger model to escalate a worker to on the second delegated attempt. */
  strongModel: string;
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
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** Strict decimal integer: optional sign then digits only (no whitespace/exponent). */
const INTEGER_RE = /^[+-]?\d+$/;
/** Strict decimal number: optional sign, digits, optional fraction, no whitespace/exponent. */
const NUMBER_RE = /^[+-]?\d+(?:\.\d+)?$/;

function invalid(field: string, key: string, detail: string): never {
  throw new Error(`Invalid configuration for ${field} [${key}]: ${detail}`);
}

type StringConfigKey =
  | "host"
  | "piBin"
  | "workspaceRoot"
  | "defaultRepo"
  | "provider"
  | "model"
  | "strongModel"
  | "extensionPath"
  | "token"
  | "defaultBaseRef";

/**
 * Merge one string field, letting an explicit override win over the environment.
 */
function pickString(
  overrides: Partial<Config>,
  field: StringConfigKey,
  key: string,
  fallback: string,
): string {
  const override = overrides[field];
  return override !== undefined ? override : env(key) ?? fallback;
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
 * Validate the effective numeric value, treating an explicit override as
 * authoritative so a valid override bypasses a broken corresponding env var.
 */
function resolveNumber(
  overrides: Partial<Config>,
  field: "port" | "maxSessions" | "worktreeTtlMin",
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

/**
 * Boolean env vars accept only "0"/"1"; overrides must be real booleans.
 */
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

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const envDataDir = env("PI_MCP_DATA_DIR") ?? join(homedir(), ".pi-mcp");
  const here = dirname(fileURLToPath(import.meta.url)); // dist/ or src/ at runtime
  const dataDir = overrides.dataDir !== undefined ? overrides.dataDir : envDataDir;

  return {
    host: pickString(overrides, "host", "PI_MCP_HOST", "127.0.0.1"),
    port: resolveNumber(overrides, "port", "PI_MCP_PORT", 8787, {
      integer: true,
      min: 1,
      max: 65535,
      description: "an integer between 1 and 65535",
    }),
    piBin: pickString(overrides, "piBin", "PI_MCP_PI_BIN", "pi"),
    workspaceRoot: pickString(
      overrides,
      "workspaceRoot",
      "PI_MCP_WORKSPACE_ROOT",
      join(envDataDir, "worktrees"),
    ),
    defaultRepo: pickString(overrides, "defaultRepo", "PI_MCP_DEFAULT_REPO", ""),
    provider: pickString(overrides, "provider", "PI_MCP_PROVIDER", "deepseek"),
    model: pickString(overrides, "model", "PI_MCP_MODEL", "deepseek-flash"),
    strongModel: pickString(overrides, "strongModel", "PI_MCP_STRONG_MODEL", "deepseek-v4-pro"),
    maxSessions: resolveNumber(overrides, "maxSessions", "PI_MCP_MAX_SESSIONS", 8, {
      integer: true,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      description: "a positive safe integer",
    }),
    parallelWarnThreshold:
      overrides.parallelWarnThreshold !== undefined
        ? overrides.parallelWarnThreshold
        : Number(env("PI_MCP_PARALLEL_WARN") ?? 4),
    extensionPath:
      overrides.extensionPath !== undefined
        ? overrides.extensionPath
        : env("PI_MCP_EXTENSION") ?? resolve(here, "..", "extensions", "pi-coordinator.ts"),
    token: pickString(overrides, "token", "PI_MCP_TOKEN", ""),
    dataDir,
    defaultBaseRef: pickString(overrides, "defaultBaseRef", "PI_MCP_BASE_REF", "HEAD"),
    autoClean: resolveBoolean(overrides, "autoClean", "PI_MCP_AUTO_CLEAN", true),
    worktreeTtlMin: resolveNumber(overrides, "worktreeTtlMin", "PI_MCP_WORKTREE_TTL_MIN", 60, {
      integer: false,
      min: 1,
      max: Number.MAX_SAFE_INTEGER / 60000,
      description: "a finite number between 1 and MAX_SAFE_INTEGER/60000",
    }),
    deleteBranches: resolveBoolean(overrides, "deleteBranches", "PI_MCP_DELETE_BRANCHES", false),
  };
}
