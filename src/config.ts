import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SecretPolicy } from "./secrets.js";

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
  /** Final retention (minutes) before a clean worktree of an unfinished/abandoned session is removed (branch kept). 0 disables; default 7 days. */
  worktreeFinalTtlMin: number;
  /** How coordination surfaces handle detected secrets: reject the write or redact it. */
  secretPolicy: SecretPolicy;
  /** Rotate the hash-chained audit log once the active file reaches this size (MiB). */
  auditMaxMb: number;
  /** Days a verification evidence bundle is retained (0 disables TTL cleanup). */
  evidenceTtlDays: number;
  /** Newest evidence bundles kept per session, regardless of TTL. */
  evidenceKeepPerSession: number;
  /** Total size budget for one evidence bundle (MiB). */
  evidenceMaxMb: number;
  /** Per-file size budget inside an evidence bundle (MiB; oversized logs keep a tail). */
  evidenceMaxFileMb: number;
  /** Default per-validator timeout (ms) when a validator does not set one. */
  validatorTimeoutMs: number;
  /** Overall verification budget (ms) across the whole validator chain. */
  verifyTimeoutMs: number;
  /**
   * Parent directory for verification candidates (default: the system temp dir).
   * Point it at a path the docker daemon can bind-mount when that is not the case
   * — colima, for example, shares only `$HOME`, so a candidate under
   * `os.tmpdir()` would be mounted as an empty directory.
   */
  verifyTmpDir: string;
  /** Default execution backend for workers and verification commands. */
  sandbox: "worktree" | "docker";
  /** Docker image used when the sandbox is docker (must contain bash and the project toolchain). */
  sandboxImage: string;
  /** Container network mode. `none` opts out of model/provider access. */
  sandboxNetwork: "bridge" | "none";
  /**
   * Host name a worker container uses to reach this daemon. `host.docker.internal`
   * works with Docker Desktop (and on Linux once the daemon listens on the bridge
   * interface); elsewhere point it at an address the container can dial.
   */
  sandboxCoordHost: string;
  /** Host environment variable names forwarded into sandbox containers. */
  sandboxEnvAllow: string[];
  /**
   * Container user: `auto` runs as the invoking uid/gid on Linux (so bind-mount
   * writes stay host-owned and daemon cleanup cannot hit EACCES), `root` keeps the
   * image's default user, and `uid:gid` pins an explicit one.
   */
  sandboxUser: string;
  /** Docker CLI path (fake binary in tests). */
  dockerBin: string;
  /** Default worker runner: the pinned pi CLI or an ACP agent. */
  runner: "pi" | "acp";
  /** ACP agent argv used when runner=acp (or when a spec selects ACP without a command). */
  acpCommand: string[];
  /** GitHub CLI path used by pi_pr / merge-queue mode. */
  ghBin: string;
  /** Remote pushed by pi_pr. */
  ghRemote: string;
  /** Label applied to created PRs. */
  prLabel: string;
  /** Optional token passed to gh as GH_TOKEN (never argv). */
  ghToken: string;
  /** Allow an ambient GH_TOKEN to reach the gh child when no explicit token is set. */
  ghAllowEnvToken: boolean;
  /** Explicit opt-in for pi_pr / merge-queue push operations. */
  allowPush: boolean;
  /** Opt-in write actions in the dashboard (finish/send/merge/stop). */
  dashboardActions: boolean;
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
  /**
   * Auto-resume sessions that were active when the daemon died (default true).
   * Disabling it leaves those sessions stopped for an explicit pi_resume.
   */
  recoverOnStartup: boolean;
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

/** True for a listener address only the same host can dial. */
function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === "localhost" || value === "::1" || value === "[::1]" || value.startsWith("127.");
}

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
  field: "port" | "maxSessions" | "parallelWarnThreshold" | "worktreeTtlMin" | "worktreeFinalTtlMin" | "workerWarnMs" | "workerStallMs" | "workerIdleMs" | "auditMaxMb" | "evidenceTtlDays" | "evidenceKeepPerSession" | "evidenceMaxMb" | "evidenceMaxFileMb" | "validatorTimeoutMs" | "verifyTimeoutMs",
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
  field: "autoClean" | "deleteBranches" | "recoverOnStartup" | "ghAllowEnvToken" | "allowPush" | "dashboardActions",
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

/** Secret policy accepts only `reject` or `redact`; overrides must use the same values. */
function resolveSecretPolicy(overrides: Partial<Config>): SecretPolicy {
  const override = overrides.secretPolicy;
  if (override !== undefined) {
    if (override !== "reject" && override !== "redact") {
      invalid("secretPolicy", "PI_COFFEE_SECRET_POLICY", 'expected "reject" or "redact"');
    }
    return override;
  }
  const raw = env("PI_COFFEE_SECRET_POLICY");
  if (raw === undefined) return "reject";
  if (raw !== "reject" && raw !== "redact") {
    invalid("secretPolicy", "PI_COFFEE_SECRET_POLICY", 'expected "reject" or "redact"');
  }
  return raw;
}

/** Sandbox backend: only `worktree` or `docker`. */
function resolveSandbox(overrides: Partial<Config>): "worktree" | "docker" {
  const override = overrides.sandbox;
  if (override !== undefined && override !== "worktree" && override !== "docker") {
    invalid("sandbox", "PI_COFFEE_SANDBOX", 'expected "worktree" or "docker"');
  }
  const raw = env("PI_COFFEE_SANDBOX") ?? "worktree";
  if (raw !== "worktree" && raw !== "docker") invalid("sandbox", "PI_COFFEE_SANDBOX", 'expected "worktree" or "docker"');
  return override ?? raw;
}

/** Container network mode: bridge (default) or none. */
function resolveSandboxNetwork(overrides: Partial<Config>): "bridge" | "none" {
  const override = overrides.sandboxNetwork;
  if (override !== undefined && override !== "bridge" && override !== "none") {
    invalid("sandboxNetwork", "PI_COFFEE_SANDBOX_NETWORK", 'expected "bridge" or "none"');
  }
  const raw = env("PI_COFFEE_SANDBOX_NETWORK") ?? "bridge";
  if (raw !== "bridge" && raw !== "none") invalid("sandboxNetwork", "PI_COFFEE_SANDBOX_NETWORK", 'expected "bridge" or "none"');
  return override ?? raw;
}

/** Worker runner: pi or acp. */
function resolveRunner(overrides: Partial<Config>): "pi" | "acp" {
  const override = overrides.runner;
  if (override !== undefined && override !== "pi" && override !== "acp") {
    invalid("runner", "PI_COFFEE_RUNNER", 'expected "pi" or "acp"');
  }
  const raw = env("PI_COFFEE_RUNNER") ?? "pi";
  if (raw !== "pi" && raw !== "acp") invalid("runner", "PI_COFFEE_RUNNER", 'expected "pi" or "acp"');
  return override ?? raw;
}

/** ACP argv: JSON array (`["cmd","arg"]`) or whitespace-separated words. */
function resolveAcpCommand(overrides: Partial<Config>): string[] {
  const override = overrides.acpCommand;
  if (override !== undefined) {
    if (!Array.isArray(override) || override.some((part) => typeof part !== "string" || !part)) {
      invalid("acpCommand", "PI_COFFEE_ACP_COMMAND", "expected a non-empty string array");
    }
    return [...override];
  }
  const raw = env("PI_COFFEE_ACP_COMMAND");
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string" || !part)) throw new Error("invalid");
      return parsed;
    } catch {
      invalid("acpCommand", "PI_COFFEE_ACP_COMMAND", "expected a JSON string array or whitespace-separated words");
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

/** Comma-separated env-name allowlist (empty by default: forward nothing). */
function resolveEnvAllow(overrides: Partial<Config>): string[] {
  const override = overrides.sandboxEnvAllow;
  if (override !== undefined) {
    if (!Array.isArray(override) || override.some((value) => typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) {
      invalid("sandboxEnvAllow", "PI_COFFEE_SANDBOX_ENV_ALLOW", "expected comma-separated environment variable names");
    }
    return [...new Set(override)];
  }
  const raw = env("PI_COFFEE_SANDBOX_ENV_ALLOW");
  if (raw === undefined) return [];
  const names = raw.split(",").map((value) => value.trim()).filter((value) => value !== "");
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) invalid("sandboxEnvAllow", "PI_COFFEE_SANDBOX_ENV_ALLOW", `invalid environment variable name: ${name}`);
  }
  return [...new Set(names)];
}

/** Parent directory for verification candidates: absolute, created on demand. */
function resolveVerifyTmpDir(overrides: Partial<Config>): string {
  const raw = overrides.verifyTmpDir ?? env("PI_COFFEE_VERIFY_TMPDIR") ?? tmpdir();
  if (raw.trim() === "" || !isAbsolute(raw)) {
    invalid("verifyTmpDir", "PI_COFFEE_VERIFY_TMPDIR", "expected an absolute directory path");
  }
  return raw;
}

/** Container user: `auto`, `root`, or an explicit `uid:gid`. */
function resolveSandboxUser(overrides: Partial<Config>): string {
  const raw = overrides.sandboxUser ?? env("PI_COFFEE_SANDBOX_USER") ?? "auto";
  if (raw === "auto" || raw === "root") return raw;
  if (!/^\d+:\d+$/.test(raw)) {
    invalid("sandboxUser", "PI_COFFEE_SANDBOX_USER", 'expected "auto", "root" or "uid:gid"');
  }
  return raw;
}

/** Plugin allowlist env var: comma-separated globs; `*` allows everything. */
function resolvePlugins(overrides: Partial<Config>, field: "workerPlugins", key: string, fallback: string[]): string[] {
  const override = overrides[field];
  if (override !== undefined) {
    if (!Array.isArray(override) || override.some(value => typeof value !== "string" || value.trim() === "")) {
      invalid(field, key, "expected a list of non-empty pattern strings");
    }
    return [...new Set((override as string[]).map(value => value.trim()))];
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
    worktreeFinalTtlMin: resolveNumber(overrides, "worktreeFinalTtlMin", "PI_COFFEE_WORKTREE_FINAL_TTL_MIN", 10080, {
      integer: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER / 60000,
      description: "a non-negative integer (0 disables); minutes before a clean worktree of an unfinished/abandoned session is removed (branch kept)",
    }),
    workerWarnMs: resolveNumber(overrides, "workerWarnMs", "PI_COFFEE_WORKER_WARN_MS", 60_000,
      { integer: true, min: 1, max: 2_147_483_647, description: "a positive timer-safe integer" }),
    workerStallMs: resolveNumber(overrides, "workerStallMs", "PI_COFFEE_WORKER_STALL_MS", 600_000,
      { integer: true, min: 1, max: 2_147_483_647, description: "a positive timer-safe integer" }),
    workerIdleMs: resolveNumber(overrides, "workerIdleMs", "PI_COFFEE_WORKER_IDLE_MS", 1_800_000,
      { integer: true, min: 1, max: 2_147_483_647, description: "a positive timer-safe integer" }),
    secretPolicy: resolveSecretPolicy(overrides),
    auditMaxMb: resolveNumber(overrides, "auditMaxMb", "PI_COFFEE_AUDIT_MAX_MB", 32, {
      integer: true,
      min: 1,
      max: 1_048_576,
      description: "a positive integer number of MiB",
    }),
    evidenceTtlDays: resolveNumber(overrides, "evidenceTtlDays", "PI_COFFEE_EVIDENCE_TTL_DAYS", 30, {
      integer: true,
      min: 0,
      max: 3650,
      description: "an integer number of days between 0 and 3650",
    }),
    evidenceKeepPerSession: resolveNumber(overrides, "evidenceKeepPerSession", "PI_COFFEE_EVIDENCE_KEEP_PER_SESSION", 10, {
      integer: true,
      min: 1,
      max: 1000,
      description: "a positive integer up to 1000",
    }),
    evidenceMaxMb: resolveNumber(overrides, "evidenceMaxMb", "PI_COFFEE_EVIDENCE_MAX_MB", 64, {
      integer: true,
      min: 1,
      max: 1_048_576,
      description: "a positive integer number of MiB",
    }),
    evidenceMaxFileMb: resolveNumber(overrides, "evidenceMaxFileMb", "PI_COFFEE_EVIDENCE_MAX_FILE_MB", 8, {
      integer: true,
      min: 1,
      max: 1024,
      description: "a positive integer up to 1024 MiB",
    }),
    validatorTimeoutMs: resolveNumber(overrides, "validatorTimeoutMs", "PI_COFFEE_VALIDATOR_TIMEOUT_MS", 600_000, {
      integer: true,
      min: 1000,
      max: 1_800_000,
      description: "an integer between 1000 and 1800000",
    }),
    verifyTimeoutMs: resolveNumber(overrides, "verifyTimeoutMs", "PI_COFFEE_VERIFY_TIMEOUT_MS", 900_000, {
      integer: true,
      min: 1000,
      max: 3_600_000,
      description: "an integer between 1000 and 3600000",
    }),
    verifyTmpDir: resolveVerifyTmpDir(overrides),
    sandbox: resolveSandbox(overrides),
    sandboxImage: overrides.sandboxImage ?? env("PI_COFFEE_SANDBOX_IMAGE") ?? "",
    sandboxNetwork: resolveSandboxNetwork(overrides),
    sandboxEnvAllow: resolveEnvAllow(overrides),
    sandboxUser: resolveSandboxUser(overrides),
    sandboxCoordHost: overrides.sandboxCoordHost ?? env("PI_COFFEE_SANDBOX_COORD_HOST") ?? "host.docker.internal",
    dockerBin: overrides.dockerBin ?? env("PI_COFFEE_DOCKER_BIN") ?? "docker",
    runner: resolveRunner(overrides),
    acpCommand: resolveAcpCommand(overrides),
    ghBin: overrides.ghBin ?? env("PI_COFFEE_GH_BIN") ?? "gh",
    ghRemote: overrides.ghRemote ?? env("PI_COFFEE_GH_REMOTE") ?? "origin",
    prLabel: overrides.prLabel ?? env("PI_COFFEE_PR_LABEL") ?? "pi-coffee",
    ghToken: overrides.ghToken ?? env("PI_COFFEE_GH_TOKEN") ?? "",
    ghAllowEnvToken: resolveBoolean(overrides, "ghAllowEnvToken", "PI_COFFEE_GH_ALLOW_ENV_TOKEN", false),
    allowPush: resolveBoolean(overrides, "allowPush", "PI_COFFEE_ALLOW_PUSH", false),
    dashboardActions: resolveBoolean(overrides, "dashboardActions", "PI_COFFEE_DASHBOARD_ACTIONS", false),
    deleteBranches: resolveBoolean(overrides, "deleteBranches", "PI_COFFEE_DELETE_BRANCHES", false),
    recoverOnStartup: resolveBoolean(overrides, "recoverOnStartup", "PI_COFFEE_RECOVER_ON_START", true),
    workerPlugins: resolvePlugins(overrides, "workerPlugins", "PI_COFFEE_WORKER_PLUGINS", []),
  };

  if (base.workerStallMs <= base.workerWarnMs) invalid("workerStallMs", "PI_COFFEE_WORKER_STALL_MS", "must exceed workerWarnMs");
  if (base.sandbox === "docker" && base.sandboxImage.trim() === "") {
    invalid("sandboxImage", "PI_COFFEE_SANDBOX_IMAGE", "is required when PI_COFFEE_SANDBOX=docker");
  }
  if (base.sandbox === "docker") {
    // Worker containers authorize every write against the daemon, so a container
    // without network reaches no daemon: spawn would report success and the
    // worker could not write a single file.
    if (base.sandboxNetwork === "none") {
      invalid("sandboxNetwork", "PI_COFFEE_SANDBOX_NETWORK",
        "worker containers need the daemon for write authorization; keep the bridge network");
    }
    // Docker's host-gateway is the bridge address, while the default listener is
    // loopback-only. On Linux that combination cannot connect (Docker Desktop on
    // macOS proxies loopback into the container), so refuse it up front instead
    // of spawning workers that can never write.
    if (process.platform === "linux" && base.sandboxCoordHost === "host.docker.internal" && isLoopbackHost(base.host)) {
      invalid("sandboxCoordHost", "PI_COFFEE_SANDBOX_COORD_HOST",
        `the daemon listens on ${base.host}, which a container cannot reach through host-gateway; `
        + "set PI_COFFEE_HOST to a reachable interface (with PI_COFFEE_TOKEN) or point this at a coord address the containers can reach");
    }
  }
  if (base.dashboardActions && !base.token) {
    invalid("dashboardActions", "PI_COFFEE_DASHBOARD_ACTIONS", "requires PI_COFFEE_TOKEN to be set");
  }
  if (base.runner === "acp" && base.acpCommand.length === 0) {
    invalid("acpCommand", "PI_COFFEE_ACP_COMMAND", "is required when PI_COFFEE_RUNNER=acp");
  }
  // Apply caller overrides last; undefined means "keep the default".
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  return { ...base, ...defined };
}
