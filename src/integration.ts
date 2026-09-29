import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { acceptancePath } from "./acceptance.js";
import { currentBranch, git, isWorktreeClean, resolveRef, worktreeDiff } from "./worktree.js";

export interface Verification {
  epoch: string;
  workerSha: string;
  targetSha: string;
  targetBranch: string;
  candidateTree: string;
  command: string;
  verifiedAt: number;
  passed: boolean;
  failure?: string;
  changedFiles: string[];
  codeChanged: boolean;
  result: { code: number | null; stdout: string; stderr: string; timedOut: boolean };
}

export interface IntegrationRecord {
  workerSha: string;
  targetBranch: string;
  previousTargetSha: string;
  mergedSha: string;
  candidateTree: string;
  integratedAt: number;
}

export interface VerifiableSession {
  repo: string;
  worktree: string;
  branch: string;
  baseRef: string;
  status: string;
  spec?: { scope: string[] };
  acceptance?: { files: string[]; command?: string; hashes?: Record<string, string> };
  verification?: Verification;
  integration?: IntegrationRecord;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/** Protect coordinator-owned files by bytes and physical location, not advisory locks alone. */
export async function acceptanceHashes(root: string, files: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = Object.create(null);
  const canonicalRoot = await realpath(root);
  for (const path of files) {
    const normalized = acceptancePath(path).split("\\").join("/");
    const target = resolve(root, normalized);
    if (!(await lstat(target)).isFile() || !inside(canonicalRoot, await realpath(target))) {
      throw new Error(`acceptance file must remain a regular file inside the worktree: ${path}`);
    }
    hashes[normalized] = createHash("sha256").update(await readFile(target)).digest("hex");
  }
  return hashes;
}

export function normalizedScope(paths: string[]): string[] {
  return paths.map((path) => acceptancePath(path.replace(/\/$/, "")).split("\\").join("/"));
}

export async function checkChanges(meta: VerifiableSession): Promise<string[]> {
  const scopes = normalizedScope(meta.spec?.scope ?? []);
  const hashes = await acceptanceHashes(meta.worktree, meta.acceptance?.files ?? []);
  if (Object.keys(hashes).length && JSON.stringify(hashes) !== JSON.stringify(meta.acceptance?.hashes)) {
    throw new Error("coordinator acceptance files changed or lack original hashes");
  }
  const { files } = await worktreeDiff(meta.worktree, meta.baseRef);
  const outOfScope = files.filter((file) => !Object.hasOwn(hashes, file) && !scopes.some((p) => file === p || file.startsWith(`${p}/`)));
  if (outOfScope.length) throw new Error(`changes outside declared scope: ${outOfScope.join(", ")}`);
  return files;
}

export async function assertTarget(repo: string, branch: string): Promise<string> {
  if (await currentBranch(repo) !== branch) {
    throw new Error("target branch must be checked out in the supplied repository; checkout explicitly in a clean worktree");
  }
  if (!(await isWorktreeClean(repo))) throw new Error("target worktree has staged, unstaged or untracked changes");
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    const path = await git(repo, ["rev-parse", "--git-path", name]);
    if (existsSync(resolve(repo, path))) throw new Error(`target has an ongoing Git operation: ${name}`);
  }
  return resolveRef(repo, `refs/heads/${branch}`);
}

export class IntegrationGate {
  readonly epoch = randomUUID();

  async verify(
    meta: VerifiableSession,
    branch: string,
    execute: (cwd: string, command: string) => Promise<Verification["result"]>,
  ): Promise<Verification> {
    if (meta.status !== "idle" && meta.status !== "stopped") throw new Error("worker must be settled before verification");
    if (!meta.acceptance?.command?.trim()) throw new Error("acceptance_command is required for verification and integration");
    if (!meta.spec?.scope.length) throw new Error("declared scope is required for verification and integration");
    if (!(await isWorktreeClean(meta.worktree))) throw new Error("commit worker changes before verification");
    const workerSha = await resolveRef(meta.worktree, "HEAD");
    if (workerSha !== await resolveRef(meta.repo, `refs/heads/${meta.branch}`)) throw new Error("worker HEAD does not match its branch");
    const targetSha = await assertTarget(meta.repo, branch);
    const changedFiles = await checkChanges(meta);
    const temp = await mkdtemp(join(tmpdir(), "pi-coffee-verify-"));
    const candidate = join(temp, "candidate");
    let added = false;
    try {
      await git(meta.repo, ["worktree", "add", "--detach", candidate, targetSha]);
      added = true;
      // Git creates the exact merged tree, isolated from both user worktrees.
      await git(candidate, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-commit", workerSha]);
      const candidateTree = await git(candidate, ["write-tree"]);
      // Seal the candidate for clean-tree checks; this detached commit is never integrated.
      if (existsSync(resolve(candidate, await git(candidate, ["rev-parse", "--git-path", "MERGE_HEAD"])))) {
        await git(candidate, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", "pi-coffee verification candidate"]);
      }
      const result = await execute(candidate, meta.acceptance.command);
      const hashes = await acceptanceHashes(candidate, meta.acceptance.files);
      const clean = await isWorktreeClean(candidate);
      const intact = JSON.stringify(hashes) === JSON.stringify(meta.acceptance.hashes ?? {});
      const failure = result.timedOut ? "acceptance command timed out" : result.code !== 0 ? "acceptance command failed"
        : !clean ? "acceptance command modified the candidate worktree" : !intact ? "acceptance files changed in candidate" : undefined;
      const passed = failure === undefined;
      if (workerSha !== await resolveRef(meta.worktree, "HEAD") || targetSha !== await assertTarget(meta.repo, branch)
        || !(await isWorktreeClean(meta.worktree))) throw new Error("worker or target changed during verification");
      await checkChanges(meta);
      return { epoch: this.epoch, workerSha, targetSha, targetBranch: branch, candidateTree,
        command: meta.acceptance.command, verifiedAt: Date.now(), passed, failure, changedFiles,
        codeChanged: changedFiles.some((file) => !meta.acceptance!.files.includes(file)), result };
    } finally {
      if (added) await git(meta.repo, ["worktree", "remove", "--force", candidate]);
      await rm(temp, { recursive: true, force: true });
    }
  }

  async assertCurrent(meta: VerifiableSession, branch: string, integrated = false): Promise<Verification> {
    const proof = meta.verification;
    if (!proof?.passed || proof.epoch !== this.epoch || proof.targetBranch !== branch) {
      throw new Error("current successful pi_verify evidence is required");
    }
    if (meta.status !== "idle" && meta.status !== "stopped") throw new Error("worker is still working");
    if (proof.command !== meta.acceptance?.command || !(await isWorktreeClean(meta.worktree))
      || proof.workerSha !== await resolveRef(meta.worktree, "HEAD")
      || proof.workerSha !== await resolveRef(meta.repo, `refs/heads/${meta.branch}`)) {
      throw new Error("worker changed since verification; run pi_verify again");
    }
    await checkChanges(meta);
    const expected = integrated ? meta.integration?.mergedSha : proof.targetSha;
    if (!expected || await assertTarget(meta.repo, branch) !== expected) throw new Error("target changed since verification; run pi_verify again");
    if (integrated && (meta.integration?.workerSha !== proof.workerSha
      || meta.integration.candidateTree !== proof.candidateTree)) throw new Error("integration does not match verification");
    return proof;
  }
}
