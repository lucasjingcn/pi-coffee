import { createHash } from "node:crypto";
import { containsSecret } from "./secrets.js";
import { acceptancePath } from "./acceptance.js";
import type { DelegationSpec } from "./types.js";

export interface CandidateReviewInput {
  requirements: { id: string; met: boolean; evidence: string }[];
  test_changes: { path: string; approved: boolean; reason: string }[];
}

export interface CandidateReview extends CandidateReviewInput {
  verificationId: string;
  reviewedAt: number;
}

/** Validate direct callers as well as MCP input and restored state. No semantic approval is inferred. */
export function validateReviewSpec(spec?: Pick<DelegationSpec, "requirements" | "validation_paths" | "validators" | "isolation" | "runner">): void {
  if (spec?.requirements !== undefined) {
    if (!Array.isArray(spec.requirements)) throw new Error("requirements must be an array");
    const ids = new Set<string>();
    for (const item of spec.requirements) {
      if (!item || typeof item.id !== "string" || !item.id.trim() || item.id !== item.id.trim()
        || typeof item.text !== "string" || !item.text.trim()) throw new Error("requirement needs a nonempty ID and text");
      if (ids.has(item.id)) throw new Error(`duplicate requirement ID: ${item.id}`);
      ids.add(item.id);
    }
  }
  if (spec?.validation_paths !== undefined) {
    if (!Array.isArray(spec.validation_paths)) throw new Error("validation_paths must be an array");
    for (const path of spec.validation_paths) {
      if (typeof path !== "string") throw new Error("validation path must be a string");
      acceptancePath(path.replace(/\/$/, ""));
    }
  }
  validateValidators(spec?.validators);
  if (spec?.isolation !== undefined && spec.isolation !== "worktree" && spec.isolation !== "docker") {
    throw new Error('spec.isolation must be "worktree" or "docker"');
  }
  if (spec?.runner !== undefined) {
    const runner = spec.runner;
    if (!runner || typeof runner !== "object") throw new Error("spec.runner must be an object");
    if (runner.kind !== "pi" && runner.kind !== "acp") throw new Error('spec.runner.kind must be "pi" or "acp"');
    if (runner.command !== undefined) {
      if (!Array.isArray(runner.command) || runner.command.length === 0 || runner.command.length > 32
        || runner.command.some((part) => typeof part !== "string" || !part)) {
        throw new Error("spec.runner.command must be a non-empty string array (max 32)");
      }
    }
    if (runner.env !== undefined) {
      if (!runner.env || typeof runner.env !== "object" || Array.isArray(runner.env)) throw new Error("spec.runner.env must be an object");
      for (const [key, value] of Object.entries(runner.env as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`spec.runner.env: invalid name ${key}`);
        if (typeof value !== "string" || value.length > 4096) throw new Error(`spec.runner.env: value for ${key} must be a string up to 4096 characters`);
        if (containsSecret(value)) throw new Error(`spec.runner.env: value for ${key} looks like a secret; use the daemon environment instead`);
      }
    }
  }
}

const VALIDATOR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Validate the optional ordered verification chain. */
export function validateValidators(validators: unknown): void {
  if (validators === undefined) return;
  if (!Array.isArray(validators)) throw new Error("validators must be an array");
  if (validators.length > 16) throw new Error("validators may contain at most 16 entries");
  const ids = new Set<string>();
  for (const entry of validators) {
    if (!entry || typeof entry !== "object") throw new Error("validator must be an object");
    const { id, command, required, timeoutMs, artifacts, env } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !VALIDATOR_ID_RE.test(id)) {
      throw new Error("validator id must match [a-z0-9][a-z0-9_-]{0,63}");
    }
    if (ids.has(id)) throw new Error(`duplicate validator id: ${id}`);
    ids.add(id);
    if (typeof command !== "string" || !command.trim() || command.length > 8192) {
      throw new Error(`validator ${id} needs a nonempty command (max 8192 characters)`);
    }
    if (required !== undefined && typeof required !== "boolean") throw new Error(`validator ${id}: required must be a boolean`);
    if (timeoutMs !== undefined) {
      if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000) {
        throw new Error(`validator ${id}: timeoutMs must be an integer between 1000 and 1800000`);
      }
    }
    if (artifacts !== undefined) {
      if (!Array.isArray(artifacts) || artifacts.length > 32) throw new Error(`validator ${id}: artifacts must be an array of at most 32 patterns`);
      for (const pattern of artifacts) {
        if (typeof pattern !== "string" || !pattern.trim() || pattern.length > 512) {
          throw new Error(`validator ${id}: artifact patterns must be nonempty strings up to 512 characters`);
        }
        if (pattern.startsWith("/") || pattern.includes("..") || pattern.includes("\\")) {
          throw new Error(`validator ${id}: artifact pattern must be worktree-relative without '..': ${pattern}`);
        }
      }
    }
    if (env !== undefined) {
      if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error(`validator ${id}: env must be an object`);
      const entries = Object.entries(env as Record<string, unknown>);
      if (entries.length > 32) throw new Error(`validator ${id}: env may contain at most 32 entries`);
      for (const [key, value] of entries) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`validator ${id}: invalid env name ${key}`);
        if (typeof value !== "string" || value.length > 4096) throw new Error(`validator ${id}: env values must be strings up to 4096 characters`);
        if (containsSecret(value)) throw new Error(`validator ${id}: env value for ${key} looks like a secret; use the daemon environment instead`);
      }
    }
  }
}

/** Freeze the entire task/acceptance contract into the verification, including scope and base. */
export function reviewContractHash(meta: {
  baseRef: string; spec?: object; acceptance?: object;
}): string {
  return createHash("sha256").update(JSON.stringify({baseRef: meta.baseRef, spec: meta.spec, acceptance: meta.acceptance})).digest("hex");
}

export function validateCandidateReview(
  spec: Pick<DelegationSpec, "requirements" | "validation_paths"> | undefined,
  validationChanges: string[], input: CandidateReviewInput,
): void {
  validateReviewSpec(spec);
  if (!input || !Array.isArray(input.requirements) || !Array.isArray(input.test_changes)) {
    throw new Error("review needs requirements and test_changes arrays");
  }
  const required = new Set((spec?.requirements ?? []).map(item => item.id));
  const seen = new Set<string>();
  for (const verdict of input.requirements) {
    if (!verdict || !required.has(verdict.id)) throw new Error("unknown requirement ID in review");
    if (seen.has(verdict.id)) throw new Error(`duplicate requirement verdict: ${verdict.id}`);
    if (verdict.met !== true) throw new Error(`requirement not met: ${verdict.id}`);
    if (typeof verdict.evidence !== "string" || !verdict.evidence.trim()) throw new Error(`requirement evidence is required: ${verdict.id}`);
    seen.add(verdict.id);
  }
  if (seen.size !== required.size) throw new Error("review must cover every requirement");
  const paths = new Set(validationChanges);
  const reviewed = new Set<string>();
  for (const change of input.test_changes) {
    if (!change || !paths.has(change.path)) {
      const offending = change && typeof change.path === "string" && change.path.trim() ? change.path : "(missing path)";
      const allowed = validationChanges.length ? validationChanges.join(", ") : "(none)";
      throw new Error(`test_changes may only list existing validation files that the worker modified (declared in spec.validation_paths: ${allowed}); new test files are not validation changes. Offending path: ${offending}`);
    }
    if (reviewed.has(change.path)) throw new Error(`duplicate validation review: ${change.path}`);
    if (change.approved !== true) throw new Error(`validation change not approved: ${change.path}`);
    if (typeof change.reason !== "string" || !change.reason.trim()) throw new Error(`validation review reason required: ${change.path}`);
    reviewed.add(change.path);
  }
  if (reviewed.size !== paths.size) throw new Error("review must cover every existing validation change");
}
