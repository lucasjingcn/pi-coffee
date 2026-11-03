#!/usr/bin/env node
/**
 * Where pi keeps its agent directory (`auth.json`, `mcp.json`).
 *
 * pi resolves it with `getAgentDir()`, which prefers `PI_CODING_AGENT_DIR`. Hard
 * coding `~/.pi/agent` in the installer's checks produced two opposite bugs: the
 * doctor reported a false FAIL for a relocated store, and `setup` refused to keep
 * a login that pi itself would have used (aborting the install under `set -e`).
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * @param {Record<string, string | undefined>} [env] environment to read (defaults to process.env)
 * @param {string} [home] home directory used when the variable is unset/blank
 */
export function resolveAgentDir(env = process.env, home = homedir()) {
  const explicit = env && typeof env.PI_CODING_AGENT_DIR === "string" ? env.PI_CODING_AGENT_DIR.trim() : "";
  return explicit ? explicit : join(home, ".pi", "agent");
}

/** Credential store pi reads for `provider` (`{ providerId: credential }`). */
export function authJsonPath(agentDir) {
  return join(agentDir, "auth.json");
}
