import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { acceptancePath } from "./acceptance.js";
import { currentBranch, git, isWorktreeClean, resolveRef, worktreeDiff } from "./worktree.js";
import { existingValidationChanges } from "./validation-changes.js";
import { reviewContractHash, validateCandidateReview, validateReviewSpec, type CandidateReview } from "./candidate-review.js";
import type { DelegationSpec } from "./types.js";
import { assertEvidenceIntact, collectArtifacts, matchesArtifactPatterns, writeEvidenceBundle, type EvidenceArtifact, type EvidenceRef, type EvidenceValidatorResult } from "./evidence.js";
import type { SecretPolicy } from "./secrets.js";
import type { ValidatorSpec } from "./types.js";

export interface Verification {
  id: string;
  /** Durable evidence bundle written by this run, when evidence storage is configured. */
  evidence?: EvidenceRef;
  epoch: string;
  workerSha: string;
  targetSha: string;
  targetBranch: string;
  candidateTree: string;
  command: string;
  /** Per-validator records when a chain ran; omitted on legacy single-command records. */
  validators?: ValidatorResult[];
  verifiedAt: number;
  passed: boolean;
  failure?: string;
  changedFiles: string[];
  codeChanged: boolean;
  existingValidationChanges: string[];
  reviewContractHash: string;
  /** Command output; `compacted` marks a tail kept for a session that is no longer recoverable. */
  result: { code: number | null; stdout: string; stderr: string; timedOut: boolean; compacted?: boolean };
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
  /** Session id; required for durable evidence bundles. */
  id?: string;
  repo: string;
  worktree: string;
  branch: string;
  baseRef: string;
  status: string;
  spec?: Pick<DelegationSpec, "scope" | "requirements" | "validation_paths" | "validators">;
  acceptance?: { files: string[]; command?: string; hashes?: Record<string, string> };
  verification?: Verification;
  integration?: IntegrationRecord;
  candidateReview?: CandidateReview;
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

export interface IntegrationGateOptions {
  /** Daemon data directory; evidence bundles are written when set. */
  dataDir?: string;
  secretPolicy?: SecretPolicy;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** Default per-validator timeout when a validator does not set one. */
  validatorTimeoutMs?: number;
  /** Overall budget across the whole chain. */
  verifyTimeoutMs?: number;
  now?: () => number;
}

export interface ValidatorResult {
  id: string;
  required: boolean;
  command: string;
  code: number | null;
  timedOut: boolean;
  passed: boolean;
}

interface ValidatorRun extends ValidatorResult {
  stdout: string;
  stderr: string;
}

export interface ResolvedValidator extends ValidatorSpec {
  required: boolean;
  artifacts: string[];
}

/** Effective chain: explicit spec.validators, else the single acceptance command. */
export function resolveValidators(meta: VerifiableSession): ResolvedValidator[] {
  const specs = meta.spec?.validators ?? [];
  if (specs.length > 0) {
    return specs.map((validator) => ({
      ...validator,
      required: validator.required !== false,
      artifacts: validator.artifacts ?? [],
    }));
  }
  return [{ id: "acceptance", command: meta.acceptance?.command ?? "", required: true, artifacts: [] }];
}

export function aggregateCommand(validators: ResolvedValidator[]): string {
  return validators.map((validator) => validator.command).join("\n---\n");
}

export class IntegrationGate {
  readonly epoch = randomUUID();
  private readonly options: IntegrationGateOptions;

  constructor(options: IntegrationGateOptions = {}) {
    this.options = options;
  }

  async verify(
    meta: VerifiableSession,
    branch: string,
    execute: (cwd: string, command: string, timeoutMs?: number, env?: Record<string, string>) => Promise<Verification["result"]>,
    budgetMs?: number,
  ): Promise<Verification> {
    if (meta.status !== "idle" && meta.status !== "stopped") throw new Error("worker must be settled before verification");
    const validators = resolveValidators(meta);
    if (validators.length === 0 || validators.some((validator) => !validator.command.trim())) {
      throw new Error("acceptance_command or a non-empty validator chain is required for verification and integration");
    }
    if (!meta.spec?.scope.length) throw new Error("declared scope is required for verification and integration");
    validateReviewSpec(meta.spec);
    const contractHash = reviewContractHash(meta);
    if (!(await isWorktreeClean(meta.worktree))) throw new Error("commit worker changes before verification");
    const workerSha = await resolveRef(meta.worktree, "HEAD");
    if (workerSha !== await resolveRef(meta.repo, `refs/heads/${meta.branch}`)) throw new Error("worker HEAD does not match its branch");
    const targetSha = await assertTarget(meta.repo, branch);
    const changedFiles = await checkChanges(meta);
    const validationChanges = await existingValidationChanges(meta.repo, meta.baseRef, workerSha, meta.spec.validation_paths);
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
      const verificationStartedAt = Date.now();
      const configuredBudget = this.options.verifyTimeoutMs ?? 900_000;
      const verifyBudgetMs = budgetMs !== undefined ? Math.min(configuredBudget, Math.max(1, budgetMs)) : configuredBudget;
      const defaultValidatorTimeoutMs = this.options.validatorTimeoutMs ?? 600_000;
      const runs: ValidatorRun[] = [];
      for (const validator of validators) {
        const remaining = verifyBudgetMs - (Date.now() - verificationStartedAt);
        if (remaining <= 0) {
          runs.push({ id: validator.id, required: validator.required, command: validator.command,
            code: null, timedOut: true, passed: false, stdout: "", stderr: "" });
          continue;
        }
        const timeout = Math.max(1, Math.min(validator.timeoutMs ?? defaultValidatorTimeoutMs, remaining));
        const runResult = await execute(candidate, validator.command, timeout, validator.env);
        runs.push({ id: validator.id, required: validator.required, command: validator.command,
          ...runResult, passed: !runResult.timedOut && runResult.code === 0 });
      }
      const acceptanceFiles = meta.acceptance?.files ?? [];
      const hashes = await acceptanceHashes(candidate, acceptanceFiles);
      const clean = await isCandidateClean(candidate, validators);
      const intact = JSON.stringify(hashes) === JSON.stringify(meta.acceptance?.hashes ?? {});
      const requiredFailure = runs.find((run) => run.required && !run.passed);
      const legacySingle = validators.length === 1 && validators[0].id === "acceptance";
      const failure = requiredFailure
        ? (legacySingle
            ? `acceptance command ${requiredFailure.timedOut ? "timed out" : "failed"}`
            : `validator ${requiredFailure.id} ${requiredFailure.timedOut ? "timed out" : "failed"}`)
        : !clean ? (legacySingle ? "acceptance command modified the candidate worktree" : "verification modified the candidate worktree")
        : !intact ? "acceptance files changed in candidate" : undefined;
      const passed = failure === undefined;
      if (workerSha !== await resolveRef(meta.worktree, "HEAD") || targetSha !== await assertTarget(meta.repo, branch)
        || !(await isWorktreeClean(meta.worktree))) throw new Error("worker or target changed during verification");
      await checkChanges(meta);
      if (contractHash !== reviewContractHash(meta)) throw new Error("task contract changed during verification");
      const id = randomUUID();
      const aggregate = requiredFailure ?? runs[runs.length - 1];
      const aggregateResult: Verification["result"] = {
        code: aggregate.code, stdout: aggregate.stdout, stderr: aggregate.stderr, timedOut: aggregate.timedOut,
      };
      const validatorResults: ValidatorResult[] = runs.map((run) => ({
        id: run.id, required: run.required, command: run.command,
        code: run.code, timedOut: run.timedOut, passed: run.passed,
      }));
      let evidence: EvidenceRef | undefined;
      const dataDir = this.options.dataDir;
      if (dataDir && meta.id) {
        // One git call: the worktree is clean at this point, so a plain diff against
        // the spawn base captures the whole reviewed change set as a patch.
        const diff = await git(meta.worktree, ["diff", meta.baseRef]);
        const artifacts: EvidenceArtifact[] = [];
        for (const validator of validators) {
          if (!validator.artifacts.length) continue;
          artifacts.push(...await collectArtifacts(candidate, validator.id, validator.artifacts, {
            maxFiles: 50,
            maxFileBytes: Math.min(this.options.maxFileBytes ?? 8 * 1024 * 1024, 8 * 1024 * 1024),
            maxTotalBytes: 16 * 1024 * 1024,
          }));
        }
        const evidenceValidators: EvidenceValidatorResult[] = runs.map((run) => ({
          id: run.id, required: run.required, command: run.command, code: run.code,
          timedOut: run.timedOut, passed: run.passed, stdout: run.stdout, stderr: run.stderr,
        }));
        evidence = await writeEvidenceBundle(dataDir, {
          sessionId: meta.id,
          verificationId: id,
          repo: meta.repo,
          workerSha,
          targetSha,
          targetBranch: branch,
          candidateTree,
          baseRef: meta.baseRef,
          command: aggregateCommand(validators),
          validators: evidenceValidators,
          artifacts,
          passed,
          ...(failure !== undefined ? { failure } : {}),
          changedFiles,
          logs: { stdout: aggregateResult.stdout, stderr: aggregateResult.stderr, diff },
          secretPolicy: this.options.secretPolicy,
          ...(this.options.maxFileBytes !== undefined ? { maxFileBytes: this.options.maxFileBytes } : {}),
          ...(this.options.maxTotalBytes !== undefined ? { maxTotalBytes: this.options.maxTotalBytes } : {}),
          ...(this.options.now ? { now: this.options.now } : {}),
        });
      }
      return { id, epoch: this.epoch, workerSha, targetSha, targetBranch: branch, candidateTree,
        command: aggregateCommand(validators), validators: validatorResults, verifiedAt: Date.now(),
        passed, failure, changedFiles, existingValidationChanges: validationChanges,
        reviewContractHash: contractHash, ...(evidence ? { evidence } : {}),
        codeChanged: changedFiles.some((file) => !acceptanceFiles.includes(file)), result: aggregateResult };
    } finally {
      if (added) await git(meta.repo, ["worktree", "remove", "--force", candidate]);
      await rm(temp, { recursive: true, force: true });
    }
  }

  async assertCurrent(meta: VerifiableSession, branch: string, integrated = false, requireReview = true): Promise<Verification> {
    const proof = meta.verification;
    if (!proof?.passed || proof.epoch !== this.epoch || proof.targetBranch !== branch) {
      throw new Error("current successful pi_verify evidence is required");
    }
    if (meta.status !== "idle" && meta.status !== "stopped") throw new Error("worker is still working");
    if (proof.reviewContractHash !== reviewContractHash(meta)) throw new Error("task contract changed since verification; run pi_verify again");
    if (proof.command !== aggregateCommand(resolveValidators(meta)) || !(await isWorktreeClean(meta.worktree))
      || proof.workerSha !== await resolveRef(meta.worktree, "HEAD")
      || proof.workerSha !== await resolveRef(meta.repo, `refs/heads/${meta.branch}`)) {
      throw new Error("worker changed since verification; run pi_verify again");
    }
    await checkChanges(meta);
    if (proof.evidence && this.options.dataDir) await assertEvidenceIntact(this.options.dataDir, proof.evidence);
    const expected = integrated ? meta.integration?.mergedSha : proof.targetSha;
    if (!expected || await assertTarget(meta.repo, branch) !== expected) throw new Error("target changed since verification; run pi_verify again");
    if (integrated && (meta.integration?.workerSha !== proof.workerSha
      || meta.integration.candidateTree !== proof.candidateTree)) throw new Error("integration does not match verification");
    if (requireReview && ((meta.spec?.requirements?.length ?? 0) > 0 || proof.existingValidationChanges.length > 0)) {
      if (!meta.candidateReview || meta.candidateReview.verificationId !== proof.id) {
        throw new Error("current pi_review evidence is required for requirements and existing validation changes");
      }
      validateCandidateReview(meta.spec, proof.existingValidationChanges, meta.candidateReview);
    }
    return proof;
  }
}

/**
 * A candidate is clean for verification purposes when the only differences are
 * files matched by the declared artifact globs (test reports, coverage output).
 * Any tracked edit or unexplained untracked file still fails verification.
 */
async function isCandidateClean(dir: string, validators: ResolvedValidator[]): Promise<boolean> {
  if (await isWorktreeClean(dir)) return true;
  const patterns = validators.flatMap((validator) => validator.artifacts);
  if (patterns.length === 0) return false;
  const status = await git(dir, ["status", "--porcelain", "--untracked-files=all"]);
  const paths = status.split("\n").filter(Boolean).map((line) => {
    const raw = line.slice(3).trim();
    const arrow = raw.lastIndexOf(" -> ");
    return arrow >= 0 ? raw.slice(arrow + 4) : raw;
  });
  return paths.length > 0 && paths.every((path) => matchesArtifactPatterns(path, patterns));
}
