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

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { redactSecrets, SecretDetectedError, type SecretKind, type SecretPolicy } from "./secrets.js";
import { sha256 } from "./lib/crypto.js";

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

interface EvidenceSandboxRecord {
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
  /** Combined output for this validator; persisted as validators/<id>/stdout.log. */
  stdout?: string;
  /** Combined error output for this validator; persisted as validators/<id>/stderr.log. */
  stderr?: string;
}

/** One captured artifact file (already read from the candidate). */
export interface EvidenceArtifact {
  validatorId: string;
  /** Candidate-relative path with POSIX separators. */
  path: string;
  content: Buffer;
  truncated?: boolean;
}

interface EvidenceFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface EvidenceManifest {
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

interface EvidenceBundleInput {
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
  /** Files copied out of the candidate after the validator run. */
  artifacts?: EvidenceArtifact[];
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

function assertId(value: string, field: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new Error(`evidence: invalid ${field}: must match ${ID_RE.source}`);
  }
  return value;
}

function evidenceRelativeDir(sessionId: string, verificationId: string): string {
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
  bytes: Buffer;
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
  const addText = (path: string, text: string): PendingFile => {
    const sanitized = sanitize(text, `evidence ${path}`, policy);
    redactions += sanitized.redactions;
    const capped = capText(sanitized.text, maxFileBytes);
    if (capped.truncated) truncated.push(path);
    return { path, bytes: Buffer.from(capped.text), truncated: capped.truncated };
  };
  const addBuffer = (path: string, content: Buffer): PendingFile => {
    if (content.length <= maxFileBytes) return { path, bytes: content, truncated: false };
    truncated.push(path);
    return {
      path,
      bytes: Buffer.concat([Buffer.from(`[truncated ${content.length - maxFileBytes} bytes, keeping the last ${maxFileBytes}]\n`),
        content.subarray(content.length - maxFileBytes)]),
      truncated: true,
    };
  };

  const files: PendingFile[] = [];
  files.push(addText("stdout.log", input.logs.stdout));
  files.push(addText("stderr.log", input.logs.stderr));
  files.push(addText("diff.patch", input.logs.diff));
  files.push(addText("changed-files.json", JSON.stringify(input.changedFiles, null, 2) + "\n"));
  files.push(addText("command.txt", input.command + "\n"));
  files.push(addText("validators.json", JSON.stringify(input.validators.map(({ stdout: _stdout, stderr: _stderr, ...rest }) => rest), null, 2) + "\n"));
  if (input.sandbox) files.push(addText("sandbox.json", JSON.stringify(input.sandbox, null, 2) + "\n"));
  for (const validator of input.validators) {
    files.push(addText(`validators/${validator.id}/stdout.log`, validator.stdout ?? ""));
    files.push(addText(`validators/${validator.id}/stderr.log`, validator.stderr ?? ""));
    files.push(addText(`validators/${validator.id}/result.json`, JSON.stringify({
      id: validator.id, required: validator.required, command: validator.command,
      code: validator.code, timedOut: validator.timedOut, passed: validator.passed,
    }, null, 2) + "\n"));
  }
  for (const artifact of input.artifacts ?? []) {
    const rel = artifact.path.split("\\").join("/");
    const segments = rel.split("/");
    if (rel.startsWith("/") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`evidence: artifact path escapes the candidate: ${artifact.path}`);
    }
    if (!ID_RE.test(artifact.validatorId)) throw new Error(`evidence: invalid artifact validator id: ${artifact.validatorId}`);
    files.push(addBuffer(`artifacts/${artifact.validatorId}/${rel}`, artifact.content));
  }

  // Keep the whole bundle under the total budget by shrinking every file evenly.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
    if (total <= maxTotalBytes) break;
    const perFile = Math.max(1024, Math.floor(maxTotalBytes / files.length));
    for (const file of files) {
      if (file.bytes.length <= perFile) continue;
      const tail = file.bytes.subarray(file.bytes.length - perFile);
      file.bytes = Buffer.concat([Buffer.from(`[truncated ${file.bytes.length - perFile} bytes, keeping the last ${perFile}]\n`), tail]);
      if (!file.truncated) {
        file.truncated = true;
        truncated.push(file.path);
      }
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
      const slash = file.path.lastIndexOf("/");
      if (slash > 0) await mkdir(join(tempDir, file.path.slice(0, slash)), { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { mode: 0o600 });
      manifestFiles.push({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes) });
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
      // Manifest carries metadata only: raw stdout/stderr live in capped, redacted
      // log files; keeping them here would leak redacted secrets and bypass caps.
      validators: input.validators?.map(({ stdout: _stdout, stderr: _stderr, ...rest }) => rest),
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

interface EvidenceVerifyResult {
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

interface ArtifactLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

interface CompiledPattern {
  source: string;
  regex: RegExp;
}

/** Compile a worktree-relative glob (supports *, **, ?) into a path regex. */
function compilePattern(pattern: string): CompiledPattern {
  const normalized = pattern.split("\\").join("/").replace(/^\.\//, "");
  let out = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        i += 1;
        if (normalized[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") { out += "[^/]"; continue; }
    out += char.replace(/[\\^$+.()|[\]{}]/g, "\\$&");
  }
  out += "$";
  return { source: normalized, regex: new RegExp(out) };
}

/** True when a candidate-relative path matches one of the artifact globs. */
export function matchesArtifactPatterns(path: string, patterns: string[]): boolean {
  const rel = path.split("\\").join("/");
  return patterns.map(compilePattern).some((pattern) => pattern.regex.test(rel));
}

/**
 * Copy the files matching `patterns` out of the candidate. Symlinks are skipped,
 * `.git` is excluded, and all limits are hard caps; oversized files keep a tail.
 */
export async function collectArtifacts(
  root: string,
  validatorId: string,
  patterns: string[],
  limits: ArtifactLimits,
): Promise<EvidenceArtifact[]> {
  if (!ID_RE.test(validatorId)) throw new Error(`evidence: invalid artifact validator id: ${validatorId}`);
  const compiled = patterns.map(compilePattern);
  const files: EvidenceArtifact[] = [];
  let totalBytes = 0;
  let visited = 0;
  const canonicalRoot = resolve(root);

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (files.length >= limits.maxFiles || depth > 12 || visited > 5000) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limits.maxFiles || visited > 5000) return;
      if (entry.name === ".git") continue;
      const absolute = join(dir, entry.name);
      let info;
      try {
        info = await lstat(absolute);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      visited += 1;
      const rel = relative(canonicalRoot, absolute).split("\\").join("/");
      if (!compiled.some((pattern) => pattern.regex.test(rel))) continue;
      if (info.size > limits.maxFileBytes * 4) continue; // never load a runaway artifact
      const content = await readFile(absolute);
      const capped = content.length > limits.maxFileBytes
        ? Buffer.concat([Buffer.from(`[truncated ${content.length - limits.maxFileBytes} bytes, keeping the last ${limits.maxFileBytes}]\n`),
            content.subarray(content.length - limits.maxFileBytes)])
        : content;
      if (totalBytes + capped.length > limits.maxTotalBytes) return;
      totalBytes += capped.length;
      files.push({ validatorId, path: rel, content: capped, ...(capped.length !== content.length ? { truncated: true } : {}) });
      if (files.length >= limits.maxFiles) return;
    }
  };

  await walk(canonicalRoot, 0);
  return files;
}

/** Assert that a recorded bundle still exists, is unmodified, and matches its manifest hash. */
export async function assertEvidenceIntact(dataDir: string, ref: EvidenceRef): Promise<void> {
  const dir = evidenceDir(dataDir, ref);
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(join(dir, "manifest.json"), "utf8");
  } catch {
    throw new Error(`evidence bundle is missing: ${ref.dir}`);
  }
  const actualManifest = sha256(manifestRaw);
  if (actualManifest !== ref.manifestSha256) {
    throw new Error(`evidence manifest changed since verification: ${ref.dir}`);
  }
  const result = await verifyEvidenceBundle(dir);
  if (!result.ok) {
    throw new Error(`evidence bundle failed integrity check: ${result.mismatches.map((item) => `${item.path} (${item.reason})`).join(", ")}`);
  }
}

interface EvidencePruneOptions {
  ttlDays: number;
  keepPerSession: number;
  now?: number;
  /** Restrict cleanup to these session ids. */
  sessionIds?: string[];
}

interface EvidencePruneResult {
  removed: number;
  bytes: number;
  temp_removed: number;
  sessions: string[];
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(absolute);
    else if (entry.isFile()) {
      try {
        total += (await lstat(absolute)).size;
      } catch {
        // Entry disappeared mid-scan.
      }
    }
  }
  return total;
}

/**
 * Remove expired evidence bundles and stale temp directories. Keeps the newest
 * `keepPerSession` bundles per session regardless of age; `ttlDays: 0` disables
 * age-based removal but still cleans `.tmp-*` leftovers.
 */
export async function pruneEvidence(dataDir: string, options: EvidencePruneOptions): Promise<EvidencePruneResult> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlDays > 0 ? options.ttlDays * 24 * 60 * 60 * 1000 : 0;
  const selected = options.sessionIds ? new Set(options.sessionIds) : undefined;
  const result: EvidencePruneResult = { removed: 0, bytes: 0, temp_removed: 0, sessions: [] };
  let sessions: string[];
  try {
    sessions = await readdir(evidenceRoot(dataDir));
  } catch {
    return result;
  }
  for (const session of sessions) {
    if (!ID_RE.test(session)) continue;
    if (selected && !selected.has(session)) continue;
    const sessionDir = join(evidenceRoot(dataDir), session);
    let entries;
    try {
      entries = await readdir(sessionDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const bundles: { name: string; createdAt: number; bytes: number }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const absolute = join(sessionDir, entry.name);
      if (entry.name.startsWith(".tmp-")) {
        try {
          const info = await lstat(absolute);
          if (now - info.mtimeMs > 60 * 60 * 1000) {
            await rm(absolute, { recursive: true, force: true });
            result.temp_removed += 1;
          }
        } catch {
          // Already gone.
        }
        continue;
      }
      if (!ID_RE.test(entry.name)) continue;
      try {
        const manifest = await readEvidenceManifest(absolute);
        bundles.push({ name: entry.name, createdAt: manifest.createdAt, bytes: await directoryBytes(absolute) });
      } catch {
        // Incomplete directory: only remove when it is old enough to be a crash remnant.
        try {
          const info = await lstat(absolute);
          if (now - info.mtimeMs > 60 * 60 * 1000) {
            await rm(absolute, { recursive: true, force: true });
            result.temp_removed += 1;
          }
        } catch {
          // Ignore.
        }
      }
    }
    bundles.sort((a, b) => b.createdAt - a.createdAt);
    let removedAny = false;
    for (let index = 0; index < bundles.length; index += 1) {
      const bundle = bundles[index];
      if (index < options.keepPerSession) continue;
      if (ttlMs === 0 || now - bundle.createdAt <= ttlMs) continue;
      await rm(join(sessionDir, bundle.name), { recursive: true, force: true });
      result.removed += 1;
      result.bytes += bundle.bytes;
      removedAny = true;
    }
    if (removedAny) result.sessions.push(session);
  }
  return result;
}
