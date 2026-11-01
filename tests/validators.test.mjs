import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";
import { acceptanceHashes } from "../dist/integration.js";
import { resolveRepoIdentity } from "../dist/lock-repo.js";
import { validateReviewSpec } from "../dist/candidate-review.js";
import { evidenceDir, readEvidenceManifest, verifyEvidenceBundle } from "../dist/evidence.js";

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-validators-"));
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
  await writeFile(join(worker, "src/item.txt"), "changed");
  git(worker, "add", "src/item.txt");
  git(worker, "commit", "-qm", "worker change");
  const config = loadConfig({
    dataDir: join(root, "data"),
    workspaceRoot: join(root, "workers"),
    defaultRepo: repo,
    autoClean: false,
  });
  const c = new Coordinator(config);
  await c.init();
  const meta = {
    id: "s1",
    name: "validators fixture",
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
    acceptance: { files: [], hashes: {} },
  };
  c.runtimes.set("s1", {
    meta,
    client: {
      getState: async () => ({ isStreaming: false }),
      stop: async () => {},
      isStreaming: false,
      refreshStreaming: async () => {},
    },
    repoIdentity: resolveRepoIdentity(repo),
    lastNotifiedQuestionIds: new Set(),
  });
  try {
    await fn({ c, meta, repo, worker, root, config, git });
  } finally {
    await c.stopAll();
    await rm(root, { recursive: true, force: true });
  }
}

test("legacy acceptance_command behaves exactly like a single validator", () =>
  fixture(async ({ c, meta }) => {
    meta.acceptance = { files: [], hashes: {}, command: 'test "$(cat src/item.txt)" = changed' };
    const proof = await c.verify("s1");
    assert.equal(proof.passed, true);
    assert.equal(proof.command, 'test "$(cat src/item.txt)" = changed');
    assert.deepEqual(proof.validators, [{
      id: "acceptance", required: true, command: 'test "$(cat src/item.txt)" = changed',
      code: 0, timedOut: false, passed: true,
    }]);
    const manifest = await readEvidenceManifest(evidenceDir(c.config.dataDir, proof.evidence));
    assert.equal(manifest.validators[0].id, "acceptance");
    assert.equal(manifest.validators[0].passed, true);
  }));

test("validators run in order and optional failures do not block", () =>
  fixture(async ({ c, meta }) => {
    meta.spec.validators = [
      { id: "lint", command: "echo lint-ok" },
      { id: "optional", command: "exit 1", required: false },
      { id: "tests", command: "echo tests-ok" },
    ];
    const proof = await c.verify("s1");
    assert.equal(proof.passed, true);
    assert.deepEqual(proof.validators.map((v) => v.id), ["lint", "optional", "tests"]);
    assert.equal(proof.validators[0].passed, true);
    assert.equal(proof.validators[1].passed, false);
    assert.equal(proof.validators[2].passed, true);
    assert.equal(proof.command, "echo lint-ok\n---\nexit 1\n---\necho tests-ok");
    const dir = evidenceDir(c.config.dataDir, proof.evidence);
    const optional = JSON.parse(await readFile(join(dir, "validators/optional/result.json"), "utf8"));
    assert.equal(optional.passed, false);
    assert.equal((await verifyEvidenceBundle(dir)).ok, true);
  }));

test("a required validator failure fails verification but keeps later evidence", () =>
  fixture(async ({ c, meta }) => {
    meta.spec.validators = [
      { id: "compile", command: "echo compile-broke >&2; exit 2" },
      { id: "tests", command: "echo still-ran" },
    ];
    const proof = await c.verify("s1");
    assert.equal(proof.passed, false);
    assert.match(proof.failure, /validator compile failed/);
    assert.equal(proof.validators[0].passed, false);
    assert.equal(proof.validators[1].passed, true);
    const dir = evidenceDir(c.config.dataDir, proof.evidence);
    const manifest = await readEvidenceManifest(dir);
    assert.equal(manifest.passed, false);
    assert.match(await readFile(join(dir, "validators/compile/stderr.log"), "utf8"), /compile-broke/);
    await assert.rejects(c.merge("s1"), /current successful pi_verify evidence is required/);
  }));

test("per-validator timeouts kill the command and fail only that step", () =>
  fixture(async ({ c, meta }) => {
    meta.spec.validators = [
      { id: "slow", command: "sleep 5", timeoutMs: 1000 },
      { id: "fast", command: "echo fast" },
    ];
    const started = Date.now();
    const proof = await c.verify("s1");
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `expected the slow validator to be killed, took ${elapsed}ms`);
    assert.equal(proof.passed, false);
    assert.match(proof.failure, /validator slow timed out/);
    assert.equal(proof.validators[0].timedOut, true);
    assert.equal(proof.validators[1].passed, true);
  }));

test("declared artifact globs are copied and tolerated in the candidate", () =>
  fixture(async ({ c, meta }) => {
    meta.spec.validators = [{
      id: "report",
      command: 'mkdir -p test-results && echo "<ok/>" > test-results/out.xml && echo reported',
      artifacts: ["test-results/**/*.xml"],
    }];
    const proof = await c.verify("s1");
    assert.equal(proof.passed, true);
    const dir = evidenceDir(c.config.dataDir, proof.evidence);
    const artifact = await readFile(join(dir, "artifacts/report/test-results/out.xml"), "utf8");
    assert.match(artifact, /<ok\/>/);
    const manifest = await readEvidenceManifest(dir);
    assert.ok(manifest.files.some((file) => file.path === "artifacts/report/test-results/out.xml"));
    assert.equal((await verifyEvidenceBundle(dir)).ok, true);
  }));

test("spawn rejects acceptance_command together with validators", () =>
  fixture(async ({ c, repo }) => {
    await assert.rejects(
      c.spawn({
        repo,
        spec: { goal: "ambiguous", scope: ["src/item.txt"], validators: [{ id: "one", command: "true" }] },
        acceptanceCommand: "true",
      }),
      /pass spec\.validators or acceptance_command, not both/,
    );
  }));

test("validator specs are validated before any work starts", () => {
  const base = { goal: "x", scope: ["src"] };
  assert.throws(() => validateReviewSpec({
    ...base, validators: [{ id: "one", command: "true" }, { id: "one", command: "true" }],
  }), /duplicate validator id/);
  assert.throws(() => validateReviewSpec({ ...base, validators: [{ id: "Bad ID", command: "true" }] }), /validator id/);
  assert.throws(() => validateReviewSpec({
    ...base, validators: Array.from({ length: 17 }, (_, i) => ({ id: `v${i}`, command: "true" })),
  }), /at most 16/);
  assert.throws(() => validateReviewSpec({
    ...base, validators: [{ id: "one", command: "true", artifacts: ["../escape"] }],
  }), /artifact pattern/);
  assert.throws(() => validateReviewSpec({
    ...base, validators: [{ id: "one", command: "true", env: { API_KEY: "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2" } }],
  }), /looks like a secret/);
  assert.throws(() => validateReviewSpec({
    ...base, validators: [{ id: "one", command: "true", timeoutMs: 10 }],
  }), /timeoutMs/);
});

test("changing a validator invalidates the verification contract", () =>
  fixture(async ({ c, meta }) => {
    meta.spec.validators = [{ id: "tests", command: "true" }];
    const proof = await c.verify("s1");
    assert.equal(proof.passed, true);
    meta.spec.validators[0].command = "echo changed";
    await assert.rejects(c.merge("s1"), /task contract changed|run pi_verify again/);
  }));
