/**
 * Git repository identity, used to namespace file locks.
 *
 * The daemon may run as a different Unix user than the repo owner (e.g. daemon as
 * root, repo owned by the Codex user), which makes git refuse with "dubious
 * ownership". We disable that check for the daemon's own git subprocesses only,
 * via environment config, so it never touches the user's global git config.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** Cap the synchronous Git identity lookup so a hung git can't wedge a claim. */
const GIT_IDENTITY_TIMEOUT_MS = 10_000;

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
}

/**
 * Strip exactly one trailing line ending (LF or CRLF). Git paths may legitimately
 * contain or end in whitespace/newlines, so `.trim()` would corrupt them.
 */
function stripOneLineEnding(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n") || s.endsWith("\r")) return s.slice(0, -1);
  return s;
}

function errorDetail(error: any): string {
  if (error?.code === "ETIMEDOUT" || error?.killed) {
    return `timed out after ${GIT_IDENTITY_TIMEOUT_MS}ms`;
  }
  return String(error?.stderr ?? error?.message ?? error).trim();
}

/**
 * Canonical identity of a repository: the realpath of its absolute Git
 * `--git-common-dir`. Symlinks, subdirectories and linked worktrees of the same
 * repo all resolve to the same identity; separate repos never share one.
 *
 * Synchronous on purpose: scope/acceptance/manual claims must resolve the
 * namespace before reserving a lock, and `Coordinator.claim` is synchronous.
 *
 * Failure is fatal. If the common dir can't be resolved or canonicalized we throw
 * rather than fall back to a non-canonical path, so no lock is ever reserved under
 * an unreliable identity.
 */
export function resolveRepoIdentity(repo: string): string {
  let commonDir: string;
  try {
    commonDir = execFileSync(
      "git",
      ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        encoding: "utf8",
        env: gitEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GIT_IDENTITY_TIMEOUT_MS,
      },
    );
  } catch (error: any) {
    throw new Error(`cannot resolve git common dir for ${repo}: ${errorDetail(error)}`);
  }

  const absolute = stripOneLineEnding(commonDir);
  if (!absolute) throw new Error(`cannot resolve git common dir for ${repo}`);

  try {
    return realpathSync(absolute);
  } catch (error: any) {
    throw new Error(
      `cannot canonicalize git common dir for ${repo} (${absolute}): ${error?.message ?? String(error)}`,
    );
  }
}
