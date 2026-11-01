import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_SCHEMA_VERSION,
  evidenceDir,
  evidenceRoot,
  listEvidenceBundles,
  readEvidenceManifest,
  verifyEvidenceBundle,
  writeEvidenceBundle,
} from "../dist/evidence.js";
import { acceptanceHashes } from "../dist/integration.js";
import { resolveRepoIdentity } from "../dist/lock-repo.js";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";

async function dataDirFixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-evidence-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseInput(overrides = {}) {
  return {
    sessionId: "s1",
    verificationId: "v-0001",
    repo: "/tmp/repo",
    workerSha: "a".repeat(40),
    targetSha: "b".repeat(40),
    targetBranch: "main",
    candidateTree: "c".repeat(40),
    baseRef: "HEAD",
    command: "node --test",
    validators: [{ id: "acceptance", required: true, command: "node --test", code: 0, timedOut: false, passed: true }],
    passed: true,
    changedFiles: ["src/item.txt"],
    logs: { stdout: "all good\n", stderr: "", diff: "diff --git a/src/item.txt b/src/item.txt\n" },
    createdAt: 1_000,
    now: () => 2_000,
    ...overrides,
  };
}

test("writes an atomic bundle with a verified manifest", () =>
  dataDirFixture(async (dataDir) => {
    const ref = await writeEvidenceBundle(dataDir, baseInput());
    assert.equal(ref.dir, "evidence/s1/v-0001");
    assert.match(ref.manifestSha256, /^[a-f0-9]{64}$/);
    assert.ok(ref.files >= 6);
    assert.deepEqual(ref.truncated, []);
    const dir = evidenceDir(dataDir, ref);
    const manifestRaw = await readFile(join(dir, "manifest.json"), "utf8");
    const manifest = await readEvidenceManifest(dir);
    assert.equal(manifest.version, EVIDENCE_SCHEMA_VERSION);
    assert.equal(manifest.sessionId, "s1");
    assert.equal(manifest.verificationId, "v-0001");
    assert.equal(manifest.workerSha, "a".repeat(40));
    assert.equal(manifest.passed, true);
    assert.equal(manifest.redactions, 0);
    assert.equal(manifest.validators.length, 1);
    const { createHash } = await import("node:crypto");
    assert.equal(createHash("sha256").update(manifestRaw).digest("hex"), ref.manifestSha256);
    const changed = JSON.parse(await readFile(join(dir, "changed-files.json"), "utf8"));
    assert.deepEqual(changed, ["src/item.txt"]);
    const verified = await verifyEvidenceBundle(dir);
    assert.equal(verified.ok, true, JSON.stringify(verified.mismatches));
  }));

test("oversized logs keep a tail and record truncation", () =>
  dataDirFixture(async (dataDir) => {
    const stdout = "x".repeat(5000) + "TAIL-MARKER";
    const ref = await writeEvidenceBundle(dataDir, baseInput({
      logs: { stdout, stderr: "", diff: "" },
      maxFileBytes: 1024,
    }));
    assert.ok(ref.truncated.includes("stdout.log"));
    const dir = evidenceDir(dataDir, ref);
    const persisted = await readFile(join(dir, "stdout.log"), "utf8");
    assert.match(persisted, /^\[truncated \d+ bytes/);
    assert.match(persisted, /TAIL-MARKER$/);
    assert.equal((await verifyEvidenceBundle(dir)).ok, true);
  }));

test("the total bundle budget shrinks files instead of failing", () =>
  dataDirFixture(async (dataDir) => {
    const big = "y".repeat(200_000);
    const ref = await writeEvidenceBundle(dataDir, baseInput({
      logs: { stdout: big, stderr: big, diff: big },
      maxFileBytes: 1_000_000,
      maxTotalBytes: 20_000,
    }));
    assert.ok(ref.truncated.length >= 3);
    assert.ok(ref.bytes <= 64_000, `expected a bounded bundle, got ${ref.bytes} bytes`);
    assert.equal((await verifyEvidenceBundle(evidenceDir(dataDir, ref))).ok, true);
  }));

test("secrets are redacted under the redact policy and rejected under reject", () =>
  dataDirFixture(async (dataDir) => {
    const secret = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
    const ref = await writeEvidenceBundle(dataDir, baseInput({
      logs: { stdout: `token ${secret}\n`, stderr: "", diff: "" },
      secretPolicy: "redact",
    }));
    const dir = evidenceDir(dataDir, ref);
    const persisted = await readFile(join(dir, "stdout.log"), "utf8");
    assert.ok(!persisted.includes(secret));
    assert.match(persisted, /\[REDACTED:openai-key\]/);
    const manifest = await readEvidenceManifest(dir);
    assert.ok(manifest.redactions >= 1);
    await assert.rejects(
      writeEvidenceBundle(dataDir, baseInput({
        verificationId: "v-reject",
        logs: { stdout: `token ${secret}\n`, stderr: "", diff: "" },
        secretPolicy: "reject",
      })),
      /secret detected in evidence stdout\.log/,
    );
  }));

test("tampering with a bundle file is detected", () =>
  dataDirFixture(async (dataDir) => {
    const ref = await writeEvidenceBundle(dataDir, baseInput());
    const dir = evidenceDir(dataDir, ref);
    await writeFile(join(dir, "stdout.log"), "rewritten after the fact\n");
    const result = await verifyEvidenceBundle(dir);
    assert.equal(result.ok, false);
    assert.equal(result.mismatches[0].path, "stdout.log");
    assert.match(result.mismatches[0].reason, /sha256 mismatch/);
  }));

test("invalid ids cannot escape the evidence root", () =>
  dataDirFixture(async (dataDir) => {
    for (const bad of ["../escape", "a/b", "", ".hidden"]) {
      await assert.rejects(writeEvidenceBundle(dataDir, baseInput({ sessionId: bad })), /invalid sessionId/);
      await assert.rejects(writeEvidenceBundle(dataDir, baseInput({ verificationId: bad })), /invalid verificationId/);
    }
    assert.throws(
      () => evidenceDir(dataDir, { dir: "evidence/../.." }),
      /escapes the evidence root/,
    );
  }));

test("listing ignores temp and unreadable directories", () =>
  dataDirFixture(async (dataDir) => {
    await writeEvidenceBundle(dataDir, baseInput({ verificationId: "v1", createdAt: 1_000, now: () => 1_000 }));
    await writeEvidenceBundle(dataDir, baseInput({ verificationId: "v2", createdAt: 2_000, now: () => 2_000 }));
    await mkdir(join(evidenceRoot(dataDir), "s1", ".tmp-x"), { recursive: true });
    await mkdir(join(evidenceRoot(dataDir), "s1", "not-a-bundle"), { recursive: true });
    const listed = await listEvidenceBundles(dataDir, "s1");
    assert.deepEqual(listed.map((bundle) => bundle.verificationId), ["v2", "v1"]);
    assert.equal((await listEvidenceBundles(dataDir, "s2")).length, 0);
  }));

test("daemon verification writes evidence and links it from the record", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-evidence-daemon-"));
  const repo = join(root, "repo");
  const worker = join(root, "worker");
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await mkdir(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "src/item.txt"), "base");
  git(repo, "add", "src");
  git(repo, "commit", "-qm", "base");
  const baseRef = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "-q", "-b", "pi/test", worker, baseRef);
  await mkdir(join(worker, "tests"));
  await writeFile(join(worker, "tests/acceptance.txt"), "owned by coordinator");
  const meta = {
    id: "s1",
    name: "evidence fixture",
    repo,
    worktree: worker,
    cwd: worker,
    branch: "pi/test",
    baseRef,
    status: "idle",
    createdAt: 1,
    lastActivity: 1,
    pendingQuestions: [],
    spec: { goal: "change item", scope: ["src/item.txt"] },
    acceptance: {
      files: ["tests/acceptance.txt"],
      command: 'test "$(cat src/item.txt)" = changed',
      hashes: await acceptanceHashes(worker, ["tests/acceptance.txt"]),
    },
  };
  await writeFile(join(worker, "src/item.txt"), "changed");
  git(worker, "add", "src/item.txt", "tests/acceptance.txt");
  git(worker, "commit", "-qm", "worker");
  const config = loadConfig({
    dataDir: join(root, "data"),
    workspaceRoot: join(root, "workers"),
    defaultRepo: repo,
    autoClean: false,
  });
  const c = new Coordinator(config);
  await c.init();
  c.runtimes.set("s1", {
    meta,
    client: { getState: async () => ({ streaming: false }), stop: async () => {}, isStreaming: false, refreshStreaming: async () => {} },
    repoIdentity: resolveRepoIdentity(repo),
    lastNotifiedQuestionIds: new Set(),
  });
  try {
    const proof = await c.verify("s1");
    assert.equal(proof.passed, true);
    assert.ok(proof.evidence, "expected a durable evidence reference");
    assert.equal(proof.evidence.dir, `evidence/s1/${proof.id}`);
    const dir = evidenceDir(config.dataDir, proof.evidence);
    const manifest = await readEvidenceManifest(dir);
    assert.equal(manifest.sessionId, "s1");
    assert.equal(manifest.verificationId, proof.id);
    assert.equal(manifest.workerSha, proof.workerSha);
    assert.equal(manifest.targetSha, proof.targetSha);
    assert.equal(manifest.candidateTree, proof.candidateTree);
    assert.equal(manifest.validators[0].id, "acceptance");
    assert.equal(manifest.validators[0].passed, true);
    assert.equal((await verifyEvidenceBundle(dir)).ok, true);
    const changed = JSON.parse(await readFile(join(dir, "changed-files.json"), "utf8"));
    assert.ok(changed.includes("src/item.txt"));
    const diff = await readFile(join(dir, "diff.patch"), "utf8");
    assert.match(diff, /src\/item\.txt/);
  } finally {
    await c.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});
