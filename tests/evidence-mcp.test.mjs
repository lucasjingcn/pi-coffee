import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";
import { resolveRepoIdentity } from "../dist/lock-repo.js";
import { buildServer } from "../dist/mcp-server.js";
import {
  evidenceDir,
  evidenceRoot,
  listEvidenceBundles,
  pruneEvidence,
  writeEvidenceBundle,
} from "../dist/evidence.js";

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-evidence-mcp-"));
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
  const config = loadConfig({ dataDir: join(root, "data"), workspaceRoot: join(root, "workers"), defaultRepo: repo, autoClean: false });
  const c = new Coordinator(config);
  await c.init();
  const meta = {
    id: "s1", name: "evidence mcp fixture", repo, worktree: worker, cwd: worker, branch: "pi/test",
    baseRef, status: "idle", createdAt: 1, lastActivity: 1, pendingQuestions: [],
    spec: { goal: "change item", scope: ["src/item.txt"] },
    acceptance: { files: [], hashes: {}, command: 'test "$(cat src/item.txt)" = changed' },
  };
  c.runtimes.set("s1", {
    meta,
    client: { getState: async () => ({ isStreaming: false }), stop: async () => {}, isStreaming: false, refreshStreaming: async () => {} },
    repoIdentity: resolveRepoIdentity(repo),
    lastNotifiedQuestionIds: new Set(),
  });
  try {
    await fn({ c, meta, repo, worker, root, config });
  } finally {
    await c.stopAll();
    await rm(root, { recursive: true, force: true });
  }
}

test("pi_evidence lists, reads and re-verifies a bundle over MCP", () =>
  fixture(async ({ c }) => {
    const proof = await c.verify("s1");
    const server = buildServer(c);
    const client = new Client({ name: "evidence-test", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = JSON.parse((await client.callTool({
        name: "pi_evidence", arguments: { session_id: "s1", action: "list" },
      })).content[0].text);
      assert.equal(listed.bundles.length, 1);
      assert.equal(listed.bundles[0].verificationId, proof.id);

      const got = JSON.parse((await client.callTool({
        name: "pi_evidence", arguments: { session_id: "s1", action: "get", verification_id: proof.id },
      })).content[0].text);
      assert.equal(got.manifest.verificationId, proof.id);
      assert.equal(got.manifest.workerSha, proof.workerSha);
      assert.ok(got.manifest.files.length >= 6);

      const verified = JSON.parse((await client.callTool({
        name: "pi_evidence", arguments: { session_id: "s1", action: "verify", verification_id: proof.id },
      })).content[0].text);
      assert.equal(verified.ok, true);

      const bundleDir = evidenceDir(c.config.dataDir, proof.evidence);
      await writeFile(join(bundleDir, "stdout.log"), "rewritten\n");
      const tampered = JSON.parse((await client.callTool({
        name: "pi_evidence", arguments: { session_id: "s1", action: "verify", verification_id: proof.id },
      })).content[0].text);
      assert.equal(tampered.ok, false);
      assert.equal(tampered.mismatches[0].path, "stdout.log");
    } finally {
      await client.close();
      await server.close();
    }
  }));

test("merge fails closed when the evidence bundle is tampered with", () =>
  fixture(async ({ c }) => {
    const proof = await c.verify("s1");
    const bundleDir = evidenceDir(c.config.dataDir, proof.evidence);
    await writeFile(join(bundleDir, "diff.patch"), "tampered diff\n");
    await assert.rejects(c.merge("s1"), /evidence bundle failed integrity check|diff\.patch/);
  }));

test("merge fails closed when the evidence bundle is missing", () =>
  fixture(async ({ c }) => {
    const proof = await c.verify("s1");
    await rm(evidenceDir(c.config.dataDir, proof.evidence), { recursive: true, force: true });
    await assert.rejects(c.merge("s1"), /evidence bundle is missing/);
  }));

test("retention keeps the newest bundles and removes only expired ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-evidence-prune-"));
  const dataDir = join(root, "data");
  const now = Date.UTC(2026, 10, 1);
  try {
    const day = 24 * 60 * 60 * 1000;
    const base = {
      sessionId: "s1", repo: "/r", workerSha: "a".repeat(40), targetSha: "b".repeat(40),
      targetBranch: "main", candidateTree: "c".repeat(40), baseRef: "HEAD", command: "true",
      validators: [{ id: "acceptance", required: true, command: "true", code: 0, timedOut: false, passed: true }],
      passed: true, changedFiles: [], logs: { stdout: "", stderr: "", diff: "" }, now: () => now,
    };
    const refs = [];
    for (const [index, ageDays] of [[1, 60], [2, 40], [3, 2], [4, 0]]) {
      refs.push(await writeEvidenceBundle(dataDir, {
        ...base, verificationId: `v${index}`, createdAt: now - ageDays * day,
      }));
    }
    const stale = join(evidenceRoot(dataDir), "s1", ".tmp-stale");
    await mkdir(stale, { recursive: true });
    await utimes(stale, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));

    const result = await pruneEvidence(dataDir, { ttlDays: 30, keepPerSession: 2, now });
    assert.equal(result.removed, 2);
    assert.equal(result.temp_removed, 1);
    const remaining = (await listEvidenceBundles(dataDir, "s1")).map((bundle) => bundle.verificationId);
    assert.deepEqual(remaining, ["v4", "v3"]);

    // keepPerSession protects the newest bundle from TTL removal.
    const again = await pruneEvidence(dataDir, { ttlDays: 1, keepPerSession: 1, now: now + 5 * day });
    assert.equal(again.removed, 1);
    assert.deepEqual((await listEvidenceBundles(dataDir, "s1")).map((bundle) => bundle.verificationId), ["v4"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
