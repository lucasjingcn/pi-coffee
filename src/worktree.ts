import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Result of a git subprocess run. */
interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * The daemon may run as a different Unix user than the repository owner (e.g.
 * daemon as root, repo owned by the Codex user), which makes git refuse with
 * "dubious ownership". Disable that check for the daemon's own git subprocesses
 * only, via environment config, so it never touches the user's global config.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Pin git's message locale so stderr text and command wording stay parseable
    // and stable on every machine; callers surface these strings as failure reasons.
    LC_ALL: "C",
    LANG: "C",
    LANGUAGE: "C",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
}

/**
 * Run git in its own process group on POSIX so a hard timeout kills the whole
 * tree, including helpers (`git-remote-http`, ssh) and hooks, mirroring
 * `runCommand` in manager.ts. Killing only the direct git process lets a hung
 * push leave a helper running (e.g. holding `index.lock` or a live connection).
 * On Windows git is spawned in the parent group and only it is killed, matching
 * the pre-existing behavior.
 */
function execGit(cwd: string, args: string[], timeout: number): Promise<GitResult> {
  return new Promise((resolve) => {
    const grouped = process.platform !== "win32";
    const proc = spawn("git", ["-C", cwd, ...args], {
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: grouped,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (grouped && proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      proc.stdout?.destroy();
      proc.stderr?.destroy();
    }, timeout);

    // Cap output (like execFile's maxBuffer) so a runaway command cannot exhaust memory.
    proc.stdout?.on("data", (d: Buffer) => (stdout = (stdout + d.toString("utf8")).slice(-64 * 1024 * 1024)));
    proc.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-32 * 1024 * 1024)));
    proc.on("error", (error) => finish({ code: null, stdout, stderr: stderr || String(error) || "", timedOut }));
    proc.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

/** Build a failure error shaped like the old execFile error for downstream callers. */
function gitFailure(cwd: string, args: string[], result: GitResult, why: string): Error & { code?: number; stdout?: string; stderr?: string; killed?: boolean } {
  const detail = (result.stderr || result.stdout || "").trim();
  const err: Error & { code?: number; stdout?: string; stderr?: string; killed?: boolean } = new Error(
    detail || `git ${args.join(" ")} failed (${why})`,
  ) as Error & { code?: number; stdout?: string; stderr?: string; killed?: boolean };
  if (result.code !== null) err.code = result.code;
  err.stdout = result.stdout;
  err.stderr = result.stderr;
  err.killed = result.timedOut;
  return err;
}

/** Run git and return trimmed stdout. Throws on failure. */
export async function git(cwd: string, args: string[], timeout = 120_000): Promise<string> {
  const result = await execGit(cwd, args, timeout);
  if (result.timedOut) throw gitFailure(cwd, args, result, `timed out after ${timeout}ms`);
  if (result.code !== 0) throw gitFailure(cwd, args, result, `exit code ${result.code}`);
  return result.stdout.trim();
}

/** Like `git`, but returns stdout verbatim so leading columns and patch whitespace survive. */
export async function gitRaw(cwd: string, args: string[], timeout = 120_000): Promise<string> {
  const result = await execGit(cwd, args, timeout);
  if (result.timedOut) throw gitFailure(cwd, args, result, `timed out after ${timeout}ms`);
  if (result.code !== 0) throw gitFailure(cwd, args, result, `exit code ${result.code}`);
  return result.stdout;
}

interface GitOutcome {
  ok: boolean;
  exitCode?: number;
  stdout: string;
  stderr: string;
  message: string;
}

/** Run git and report success/failure plus captured output instead of throwing. */
async function gitOutcome(cwd: string, args: string[], timeout = 120_000): Promise<GitOutcome> {
  const result = await execGit(cwd, args, timeout);
  if (result.timedOut) {
    return { ok: false, exitCode: undefined, stdout: result.stdout, stderr: result.stderr, message: `git ${args.join(" ")} timed out after ${timeout}ms` };
  }
  if (result.code !== 0) {
    return { ok: false, exitCode: result.code ?? undefined, stdout: result.stdout, stderr: result.stderr, message: (result.stderr || result.stdout || "").trim() };
  }
  return { ok: true, exitCode: result.code ?? 0, stdout: result.stdout, stderr: result.stderr, message: "" };
}

/** Decode NUL-delimited git output into exact (unquoted, untrimmed) paths. */
function nulPaths(out: string): string[] {
  return out.split("\0").filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// Repository queries
// ---------------------------------------------------------------------------

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

export async function currentBranch(repo: string): Promise<string> {
  return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

// ---------------------------------------------------------------------------
// Worktree lifecycle
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  repo: string;
  dir: string;
  branch: string;
  baseRef: string;
}

/** Create an isolated git worktree on a fresh branch (or attach to an existing one). */
export async function createWorktree(opts: {
  repo: string;
  dir: string;
  branch: string;
  baseRef?: string;
}): Promise<WorktreeInfo> {
  const baseRef = opts.baseRef ?? "HEAD";
  await mkdir(dirname(opts.dir), { recursive: true });
  // Prune stale registrations first; a prior crashed run can leave them behind.
  await git(opts.repo, ["worktree", "prune"]).catch(() => {});

  const existing = await git(opts.repo, ["branch", "--list", opts.branch]).catch(() => "");
  if (existing.trim()) {
    // Branch already exists: attach the new worktree to it.
    await git(opts.repo, ["worktree", "add", opts.dir, opts.branch]).catch(async () => {
      await git(opts.repo, ["worktree", "prune"]).catch(() => {});
      await git(opts.repo, ["worktree", "add", opts.dir, opts.branch]);
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

// ---------------------------------------------------------------------------
// Branch cleanup
// ---------------------------------------------------------------------------

export interface BranchDeleteResult {
  branch: string;
  deleted: boolean;
  reason: string;
}

/** First useful line of a failed git call, for reporting without claiming success. */
function gitErrorText(out: GitOutcome): string {
  const text = (out.stderr.trim() || out.message.trim()).split("\n")[0];
  return text || "git command failed";
}

/** Branch names checked out by any worktree, parsed from `git worktree list --porcelain`. */
async function checkedOutBranches(repo: string): Promise<Set<string>> {
  const names = new Set<string>();
  const out = await gitOutcome(repo, ["worktree", "list", "--porcelain"]);
  if (!out.ok) throw new Error(gitErrorText(out));
  for (const line of out.stdout.split("\n")) {
    const match = /^branch refs\/heads\/(.+)$/.exec(line.trim());
    if (match) names.add(match[1]);
  }
  return names;
}

/** Remote default branch short name (e.g. `origin/HEAD -> main`), when configured. */
async function remoteDefaultBranch(repo: string): Promise<string | null> {
  const out = await gitOutcome(repo, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (!out.ok) {
    if (out.exitCode !== 1 || out.stderr.trim()) throw new Error(gitErrorText(out));
    return null; // optional symbolic ref is not configured
  }
  const ref = out.stdout.trim();
  const slash = ref.indexOf("/");
  return slash >= 0 && slash + 1 < ref.length ? ref.slice(slash + 1) : null;
}

/**
 * Delete a worker branch once its work is proven integrated into the repo's
 * current HEAD.
 *
 * Safety rails (all required):
 *  - the full ref must resolve; invalid/empty metadata is refused, never guessed;
 *  - the branch must not be checked out in any worktree and must not be the
 *    current or default branch;
 *  - the branch tip must be an ancestor of HEAD (`merge-base --is-ancestor`), so
 *    squashed or rebased work is retained for manual inspection instead of being
 *    mistaken for integrated work;
 *  - deletion uses non-force `git branch -d`, so git's own merged/checked-out
 *    checks still apply on top.
 *
 * Any git failure or safety refusal returns `deleted:false` with the reason:
 * callers must never report a deletion that did not happen.
 */
export async function deleteMergedBranch(repo: string, branch: string): Promise<BranchDeleteResult> {
  const name = branch;
  if (!name || name !== name.trim()) return { branch, deleted: false, reason: "invalid branch name" };

  const fullRef = `refs/heads/${name}`;

  const valid = await gitOutcome(repo, ["check-ref-format", fullRef]);
  if (!valid.ok) return { branch, deleted: false, reason: "invalid branch name" };

  const rev = await gitOutcome(repo, ["rev-parse", "--verify", "--quiet", fullRef]);
  if (!rev.ok || !rev.stdout.trim()) {
    // Missing/invalid refs exit quietly; repo-level errors land on stderr and are surfaced as-is.
    return { branch: name, deleted: false, reason: rev.stderr.trim() ? gitErrorText(rev) : "branch not found" };
  }

  if (name === "main" || name === "master") {
    return { branch: name, deleted: false, reason: "default branch" };
  }

  const checkedOut = await checkedOutBranches(repo);
  if (checkedOut.has(name)) {
    return { branch: name, deleted: false, reason: "checked out in a worktree" };
  }

  const current = await gitOutcome(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!current.ok) return { branch, deleted: false, reason: gitErrorText(current) };
  if (current.stdout.trim() === name) {
    return { branch: name, deleted: false, reason: "current branch" };
  }

  if ((await remoteDefaultBranch(repo)) === name) {
    return { branch: name, deleted: false, reason: "default branch" };
  }

  const ancestor = await gitOutcome(repo, ["merge-base", "--is-ancestor", fullRef, "HEAD"]);
  if (!ancestor.ok) {
    return {
      branch: name,
      deleted: false,
      reason: ancestor.stderr.trim() ? gitErrorText(ancestor) : "not an ancestor of HEAD",
    };
  }

  // Non-force: git still refuses if its own merged/checked-out checks disagree with ours.
  const del = await gitOutcome(repo, ["branch", "-d", "--", name]);
  if (!del.ok) return { branch: name, deleted: false, reason: gitErrorText(del) };
  return { branch: name, deleted: true, reason: "merged into HEAD" };
}

// ---------------------------------------------------------------------------
// Diff / commit / merge / push
// ---------------------------------------------------------------------------

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
    gitRaw(dir, ["diff", "--no-renames", "--name-only", "-z", `${base}...HEAD`]),
    gitRaw(dir, ["diff", "--no-renames", "--name-only", "-z", "HEAD"]),
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

  const args = [
    "merge",
    ...(opts.noFf === false ? [] : ["--no-ff"]),
    branch,
    "-m",
    opts.message ?? `Merge ${branch} into ${into}`,
  ];
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
