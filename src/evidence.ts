/**
 * Durable verification evidence bundles.
 *
 * A bundle captures what a verification run actually did: the candidate and
 * worker/target SHAs, every validator result, the combined output, the diff and
 * an explicit file manifest with sizes and sha256 hashes. Bundles are written
 * atomically (temp directory + rename) and the manifest is written last, so a
 * crash can leave a `.tmp-*` directory but never a bundle with a manifest that
 * describes files that were not persisted.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { redactSecrets, SecretDetectedError, type SecretKind, type SecretPolicy } from "./secrets.js";

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

export interface EvidenceSandboxRecord {
  kind: string;
  image?: string;
  imageDigest?: string;
  network?: string;
  mounts?: { source: string; target: string; mode: "rw" | "ro" }[];
}

export interface EvidenceValidatorResult {
  id: string;
  required: boolean;
  command: string;
  code: number | null;
  timedOut: boolean;
  passed: boolean;
}

export interface EvidenceFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface EvidenceManifest {
  version: typeof EVIDENCE_SCHEMA_VERSION;
  sessionId: string;
  verificationId: string;
  createdAt: number;
  closedAt: number;
  repo: string;
  workerSha: string;
  targetSha: string;
  targetBranch: string;
  candidateTree: string;
  baseRef: string;
  command: string;
  validators: EvidenceValidatorResult[];
  passed: boolean;
  failure?: string;
  sandbox?: EvidenceSandboxRecord;
  files: EvidenceFile[];
  truncated: string[];
  redactions: number;
}

export interface EvidenceRef {
  /** Path relative to the daemon data directory, e.g. `evidence/<session>/<verification>`. */
  dir: string;
  manifestSha256: string;
  files: number;
  bytes: number;
  truncated: string[];
}

export interface EvidenceBundleInput {
  sessionId: string;
  verificationId: string;
  repo: string;
  workerSha: string;
  targetSha: string;
  targetBranch: string;
  candidateTree: string;
  baseRef: string;
  command: string;
  validators: EvidenceValidatorResult[];
  passed: boolean;
  failure?: string;
  sandbox?: EvidenceSandboxRecord;
  changedFiles: string[];
  logs: { stdout: string; stderr: string; diff: string };
  createdAt?: number;
  /** Clock override for deterministic tests. */
  now?: () => number;
  secretPolicy?: SecretPolicy;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function assertId(value: string, field: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new Error(`evidence: invalid ${field}: must match ${ID_RE.source}`);
  }
  return value;
}

export function evidenceRelativeDir(sessionId: string, verificationId: string): string {
  assertId(sessionId, "sessionId");
  assertId(verificationId, "verificationId");
  return join("evidence", sessionId, verificationId);
}

export function evidenceRoot(dataDir: string): string {
  return resolve(dataDir, "evidence");
}

/** Directory holding one bundle, resolved from the data directory. */
export function evidenceDir(dataDir: string, ref: Pick<EvidenceRef, "dir">): string {
  const root = evidenceRoot(dataDir);
  const target = resolve(dataDir, ref.dir);
  if (target !== root && !target.startsWith(root + "/") && !target.startsWith(root + "\\")) {
    throw new Error("evidence: bundle path escapes the evidence root");
  }
  return target;
}

interface Capped {
  text: string;
  truncated: boolean;
}

function capText(text: string, maxBytes: number): Capped {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return { text, truncated: false };
  const tail = buffer.subarray(buffer.length - maxBytes).toString("utf8");
  return { text: `[truncated ${buffer.length - maxBytes} bytes, keeping the last ${maxBytes}]\n${tail}`, truncated: true };
}

/** Redact secrets in one text file and count how many spans were replaced. */
function sanitize(text: string, context: string, policy: SecretPolicy): { text: string; redactions: number } {
  const result = redactSecrets(text);
  if (result.redactions === 0) return { text, redactions: 0 };
  if (policy === "reject") {
    throw new SecretDetectedError(context, result.kinds as SecretKind[]);
  }
  return { text: result.text, redactions: result.redactions };
}

interface PendingFile {
  path: string;
  text: string;
  truncated: boolean;
}

/**
 * Write one bundle atomically and return the durable reference stored in session
 * state. Throws (fail closed) when the bundle cannot be written or a secret is
 * detected under the `reject` policy.
 */
export async function writeEvidenceBundle(dataDir: string, input: EvidenceBundleInput): Promise<EvidenceRef> {
  const startedAt = input.createdAt ?? (input.now ?? Date.now)();
  const now = input.now ?? Date.now;
  const policy = input.secretPolicy ?? "reject";
  const maxFileBytes = Math.max(1024, input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const maxTotalBytes = Math.max(4096, input.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES);

  let redactions = 0;
  const truncated: string[] = [];
  const addFile = (path: string, text: string): PendingFile => {
    const sanitized = sanitize(text, `evidence ${path}`, policy);
    redactions += sanitized.redactions;
    const capped = capText(sanitized.text, maxFileBytes);
    if (capped.truncated) truncated.push(path);
    return { path, ...capped };
  };

  const files: PendingFile[] = [];
  files.push(addFile("stdout.log", input.logs.stdout));
  files.push(addFile("stderr.log", input.logs.stderr));
  files.push(addFile("diff.patch", input.logs.diff));
  files.push(addFile("changed-files.json", JSON.stringify(input.changedFiles, null, 2) + "\n"));
  files.push(addFile("command.txt", input.command + "\n"));
  files.push(addFile("validators.json", JSON.stringify(input.validators, null, 2) + "\n"));
  if (input.sandbox) files.push(addFile("sandbox.json", JSON.stringify(input.sandbox, null, 2) + "\n"));

  // Keep the whole bundle under the total budget by shrinking every file evenly.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0);
    if (total <= maxTotalBytes) break;
    const perFile = Math.max(1024, Math.floor(maxTotalBytes / files.length));
    for (const file of files) {
      const capped = capText(file.text, perFile);
      if (capped.truncated && !file.truncated) {
        file.truncated = true;
        truncated.push(file.path);
      }
      file.text = capped.text;
    }
  }

  const sessionId = assertId(input.sessionId, "sessionId");
  const verificationId = assertId(input.verificationId, "verificationId");
  const relative = evidenceRelativeDir(sessionId, verificationId);
  const root = evidenceRoot(dataDir);
  const finalDir = join(root, sessionId, verificationId);
  await mkdir(join(root, sessionId), { recursive: true, mode: 0o700 });

  const tempDir = join(root, sessionId, `.tmp-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const manifestFiles: EvidenceFile[] = [];
  try {
    for (const file of files) {
      const target = join(tempDir, file.path);
      const bytes = Buffer.from(file.text);
      await writeFile(target, bytes, { mode: 0o600 });
      manifestFiles.push({ path: file.path, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const manifest: EvidenceManifest = {
      version: EVIDENCE_SCHEMA_VERSION,
      sessionId,
      verificationId,
      createdAt: startedAt,
      closedAt: now(),
      repo: input.repo,
      workerSha: input.workerSha,
      targetSha: input.targetSha,
      targetBranch: input.targetBranch,
      candidateTree: input.candidateTree,
      baseRef: input.baseRef,
      command: input.command,
      validators: input.validators,
      passed: input.passed,
      ...(input.failure !== undefined ? { failure: input.failure } : {}),
      ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
      files: manifestFiles,
      truncated,
      redactions,
    };
    const manifestText = JSON.stringify(manifest, null, 2) + "\n";
    await writeFile(join(tempDir, "manifest.json"), manifestText, { mode: 0o600 });
    await rename(tempDir, finalDir);
    return {
      dir: relative.split("\\").join("/"),
      manifestSha256: sha256(manifestText),
      files: manifestFiles.length,
      bytes: manifestFiles.reduce((sum, file) => sum + file.bytes, 0),
      truncated,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Read and structurally validate a bundle manifest. */
export async function readEvidenceManifest(dir: string): Promise<EvidenceManifest> {
  const raw = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as EvidenceManifest;
  if (raw.version !== EVIDENCE_SCHEMA_VERSION) throw new Error(`evidence: unsupported manifest version ${String(raw.version)}`);
  if (!Array.isArray(raw.files) || !Array.isArray(raw.validators)) throw new Error("evidence: malformed manifest");
  return raw;
}

export interface EvidenceVerifyResult {
  ok: boolean;
  manifest: EvidenceManifest;
  mismatches: { path: string; expected?: string; actual?: string; reason: string }[];
}

/** Recompute every file hash and compare it with the manifest. */
export async function verifyEvidenceBundle(dir: string): Promise<EvidenceVerifyResult> {
  const manifest = await readEvidenceManifest(dir);
  const mismatches: EvidenceVerifyResult["mismatches"] = [];
  for (const file of manifest.files) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(dir, file.path));
    } catch {
      mismatches.push({ path: file.path, expected: file.sha256, reason: "file is missing" });
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== file.sha256) mismatches.push({ path: file.path, expected: file.sha256, actual, reason: "sha256 mismatch" });
    else if (bytes.length !== file.bytes) mismatches.push({ path: file.path, expected: String(file.bytes), actual: String(bytes.length), reason: "size mismatch" });
  }
  return { ok: mismatches.length === 0, manifest, mismatches };
}

/** Bundle references for one session, newest first. Used by pi_evidence and retention. */
export async function listEvidenceBundles(dataDir: string, sessionId: string): Promise<{ verificationId: string; dir: string; createdAt: number }[]> {
  const safeSession = assertId(sessionId, "sessionId");
  let names: string[];
  try {
    names = await readdir(join(evidenceRoot(dataDir), safeSession));
  } catch {
    return [];
  }
  const bundles: { verificationId: string; dir: string; createdAt: number }[] = [];
  for (const name of names) {
    if (!ID_RE.test(name)) continue;
    const dir = join("evidence", safeSession, name).split("\\").join("/");
    try {
      const manifest = await readEvidenceManifest(join(evidenceRoot(dataDir), safeSession, name));
      bundles.push({ verificationId: name, dir, createdAt: manifest.createdAt });
    } catch {
      continue; // incomplete or foreign directory: never surfaced as a bundle
    }
  }
  return bundles.sort((a, b) => b.createdAt - a.createdAt);
}
