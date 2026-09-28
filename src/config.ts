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
  /** Path to the worker-side pi extension. */
  extensionPath: string;
  /** Optional shared secret checked on the internal API and /mcp. */
  token: string;
  /** Directory for daemon state (locks, mailbox, board, session metadata). */
  dataDir: string;
  /** Base ref used when creating a worktree branch. */
  defaultBaseRef: string;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = env("PI_MCP_DATA_DIR") ?? join(homedir(), ".pi-mcp");
  const here = dirname(fileURLToPath(import.meta.url)); // dist/ or src/ at runtime
  const base: Config = {
    host: env("PI_MCP_HOST") ?? "127.0.0.1",
    port: Number(env("PI_MCP_PORT") ?? 8787),
    piBin: env("PI_MCP_PI_BIN") ?? "pi",
    workspaceRoot: env("PI_MCP_WORKSPACE_ROOT") ?? join(dataDir, "worktrees"),
    defaultRepo: env("PI_MCP_DEFAULT_REPO") ?? process.cwd(),
    provider: env("PI_MCP_PROVIDER") ?? "deepseek",
    model: env("PI_MCP_MODEL") ?? "deepseek-flash",
    strongModel: env("PI_MCP_STRONG_MODEL") ?? "deepseek-v4-pro",
    maxSessions: Number(env("PI_MCP_MAX_SESSIONS") ?? 8),
    extensionPath:
      env("PI_MCP_EXTENSION") ?? resolve(here, "..", "extensions", "pi-coordinator.ts"),
    token: env("PI_MCP_TOKEN") ?? "",
    dataDir,
    defaultBaseRef: env("PI_MCP_BASE_REF") ?? "HEAD",
  };
  return { ...base, ...overrides };
}
