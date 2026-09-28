import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * The daemon may run as a different Unix user than the repository owner (e.g. daemon as root,
 * repo owned by the Codex user), which makes git refuse with "dubious ownership". Disable that
 * check for the daemon's own git subprocesses only, via environment config (scoped, not global).
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
}

function clean(p: string): string {
  return p.replace(/\/+$/, "") || "/";
}

/**
 * Canonical repository identity for lock namespacing: the realpath of the absolute Git
 * `--git-common-dir`. Symlinks, subdirectories and linked worktrees of the same repository all
 * resolve to the same identity; separate repositories never share one even when they contain the
 * same filenames.
 *
 * Synchronous on purpose: scope/acceptance/manual claims must resolve the namespace before
 * reserving any lock, and `Coordinator.claim` is a synchronous API.
 */
export function resolveRepoIdentity(repo: string): string {
  let commonDir: string;
  try {
    commonDir = execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error: any) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new Error(`cannot resolve git common dir for ${repo}: ${detail}`);
  }
  if (!commonDir) throw new Error(`cannot resolve git common dir for ${repo}`);
  const absolute = clean(isAbsolute(commonDir) ? commonDir : resolve(repo, commonDir));
  try {
    return clean(realpathSync(absolute));
  } catch {
    // Unusual (common dir should exist); fall back to the normalized absolute path.
    return absolute;
  }
}
