import { createHash } from "node:crypto";
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
export function validateReviewSpec(spec?: Pick<DelegationSpec, "requirements" | "validation_paths">): void {
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
    if (!change || !paths.has(change.path)) throw new Error("unknown validation file in test_changes review");
    if (reviewed.has(change.path)) throw new Error(`duplicate validation review: ${change.path}`);
    if (change.approved !== true) throw new Error(`validation change not approved: ${change.path}`);
    if (typeof change.reason !== "string" || !change.reason.trim()) throw new Error(`validation review reason required: ${change.path}`);
    reviewed.add(change.path);
  }
  if (reviewed.size !== paths.size) throw new Error("review must cover every existing validation change");
}
