import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

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

async function git(cwd: string, args: string[], timeout = 120_000): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], {
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: gitEnv(),
  });
  return stdout.trim();
}

/** Like `git`, but returns stdout verbatim so leading columns and patch whitespace survive. */
async function gitRaw(cwd: string, args: string[], timeout = 120_000): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], {
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: gitEnv(),
  });
  return stdout;
}

interface GitOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  message: string;
}

/** Run git and report success/failure plus captured output instead of throwing. */
async function gitOutcome(cwd: string, args: string[], timeout = 120_000): Promise<GitOutcome> {
  try {
    const { stdout, stderr } = await run("git", ["-C", cwd, ...args], {
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: gitEnv(),
    });
    return { ok: true, stdout, stderr, message: "" };
  } catch (e: any) {
    return {
      ok: false,
      stdout: typeof e?.stdout === "string" ? e.stdout : "",
      stderr: typeof e?.stderr === "string" ? e.stderr : "",
      message: String(e?.message ?? e),
    };
  }
}

/** Decode NUL-delimited git output into exact (unquoted, untrimmed) paths. */
function nulPaths(out: string): string[] {
  return out.split("\0").filter((p) => p.length > 0);
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export async function repoRoot(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "--show-toplevel"]);
}

export async function currentHead(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "--short", "HEAD"]);
}

/** Resolve a ref (branch/tag/HEAD) to a concrete commit SHA at call time. */
export async function resolveRef(repo: string, ref: string): Promise<string> {
  return git(repo, ["rev-parse", ref]);
}

export interface WorktreeInfo {
  repo: string;
  dir: string;
  branch: string;
  baseRef: string;
}

/** Create an isolated git worktree on a fresh branch. */
export async function createWorktree(opts: {
  repo: string;
  dir: string;
  branch: string;
  baseRef?: string;
}): Promise<WorktreeInfo> {
  const baseRef = opts.baseRef ?? "HEAD";
  await mkdir(dirname(opts.dir), { recursive: true });
  await git(opts.repo, ["worktree", "prune"]).catch(() => {});
  const branches = await git(opts.repo, ["branch", "--list", opts.branch]).catch(() => "");
  if (branches.trim()) {
    // Branch already exists: attach to it.
    await git(opts.repo, ["worktree", "add", opts.dir, opts.branch]).catch(async () => {
      await git(opts.repo, ["worktree", "prune"]).catch(() => {});
      await git(opts.repo, ["worktree", "add", "-f", opts.dir, opts.branch]);
    });
  } else {
    await git(opts.repo, ["worktree", "add", "-b", opts.branch, opts.dir, baseRef]).catch(async () => {
      await git(opts.repo, ["worktree", "prune"]).catch(() => {});
      await git(opts.repo, ["worktree", "add", "-f", "-b", opts.branch, opts.dir, baseRef]);
    });
  }
  return { repo: opts.repo, dir: opts.dir, branch: opts.branch, baseRef };
}

export async function removeWorktree(repo: string, dir: string, branch?: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", dir]).catch(() => {
    /* already gone */
  });
  await git(repo, ["worktree", "prune"]).catch(() => {});
  if (branch) await git(repo, ["branch", "-D", branch]).catch(() => {});
}

/** True when the worktree has no uncommitted or untracked changes. */
export async function isWorktreeClean(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ["status", "--porcelain"]);
    return out.trim() === "";
  } catch {
    return false; // unknown -> treat as not clean (never auto-delete)
  }
}

export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]).catch(() => {});
}

export interface DiffSummary {
  base: string;
  stat: string;
  committed: string;
  uncommitted: string;
  untracked: string[];
  status: string;
  files: string[];
}

/** Summarize a worker's changes: committed since base plus uncommitted/untracked edits. */
export async function worktreeDiff(dir: string, base = "HEAD"): Promise<DiffSummary> {
  // Any failing git call (e.g. an unknown base) rejects instead of masquerading
  // as an empty, successful diff. Raw output keeps porcelain columns and patches intact.
  const [stat, committed, uncommitted, status, committedNames, changedNames, untrackedRaw] = await Promise.all([
    gitRaw(dir, ["diff", "--stat", `${base}...HEAD`]),
    gitRaw(dir, ["diff", `${base}...HEAD`]),
    gitRaw(dir, ["diff", "HEAD"]),
    gitRaw(dir, ["status", "--porcelain"]),
    gitRaw(dir, ["diff", "--name-only", "-z", `${base}...HEAD`]),
    gitRaw(dir, ["diff", "--name-only", "-z", "HEAD"]),
    gitRaw(dir, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const untracked = nulPaths(untrackedRaw);
  const files = [
    ...new Set([...nulPaths(committedNames), ...nulPaths(changedNames), ...untracked]),
  ];
  return { base, stat, committed, uncommitted, untracked, status, files };
}

export async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, ["add", "-A"]);
  // A genuinely clean tree is the only no-op; every other commit failure must surface.
  if ((await git(dir, ["status", "--porcelain"])) === "") {
    return "nothing to commit: working tree clean";
  }
  await git(dir, ["commit", "-m", message]);
  return git(dir, ["rev-parse", "--short", "HEAD"]);
}

export async function currentBranch(repo: string): Promise<string> {
  return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export interface MergeResult {
  ok: boolean;
  branch: string;
  into: string;
  conflicts: string[];
  output: string;
}

/**
 * Merge a worker branch into `into` inside the main repository.
 * On conflict the merge is left in progress so the caller can resolve it.
 */
export async function mergeBranch(
  repo: string,
  branch: string,
  into: string,
  opts: { noFf?: boolean; message?: string } = {},
): Promise<MergeResult> {
  await git(repo, ["rev-parse", "--verify", branch]); // throws if missing
  const current = await currentBranch(repo);
  if (current !== into) await git(repo, ["checkout", into]);
  const args = ["merge", ...(opts.noFf === false ? [] : ["--no-ff"]), branch, "-m", opts.message ?? `Merge ${branch} into ${into}`];
  const outcome = await gitOutcome(repo, args);
  const output = [outcome.stdout, outcome.stderr, outcome.ok ? "" : outcome.message]
    .filter(Boolean)
    .join("\n")
    .trim();
  // `-z` gives literal (unquoted, untrimmed) paths, so filenames containing
  // spaces, Unicode or newlines survive exactly. A git failure here must
  // surface rather than be reported as "no conflicts".
  const conflicts = nulPaths(await gitRaw(repo, ["diff", "--name-only", "--diff-filter=U", "-z"]));
  return { ok: outcome.ok, branch, into, conflicts, output };
}

export async function pushBranch(repo: string, remote = "origin", branch?: string): Promise<string> {
  const target = branch ?? (await currentBranch(repo));
  return git(repo, ["push", remote, target], 600_000);
}
