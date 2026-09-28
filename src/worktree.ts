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
  const [stat, committed, uncommitted, status, names] = await Promise.all([
    git(dir, ["diff", "--stat", `${base}...HEAD`]).catch(() => ""),
    git(dir, ["diff", `${base}...HEAD`]).catch(() => ""),
    git(dir, ["diff", "HEAD"]).catch(() => ""),
    git(dir, ["status", "--porcelain"]).catch(() => ""),
    git(dir, ["diff", "--name-only", `${base}...HEAD`])
      .then((s) => s.split("\n").filter(Boolean))
      .catch(() => [] as string[]),
  ]);
  const untracked = status
    .split("\n")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3).trim());
  return { base, stat, committed, uncommitted, untracked, status, files: [...new Set([...names, ...untracked])] };
}

export async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, ["add", "-A"]);
  try {
    await git(dir, ["commit", "-m", message]);
  } catch (e) {
    return `nothing to commit: ${String(e)}`;
  }
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
  const output = await git(repo, args).catch((e: any) => String(e?.stdout ?? e?.message ?? e));
  const status = await git(repo, ["status", "--porcelain"]).catch(() => "");
  const conflicts = status
    .split("\n")
    .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l))
    .map((l) => l.slice(3).trim());
  return { ok: conflicts.length === 0, branch, into, conflicts, output };
}

export async function pushBranch(repo: string, remote = "origin", branch?: string): Promise<string> {
  const target = branch ?? (await currentBranch(repo));
  return git(repo, ["push", remote, target], 600_000);
}
