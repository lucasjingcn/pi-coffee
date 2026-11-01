import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";
import { PiRpcClient } from "../dist/rpc-client.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function historyEntry(root, id, overrides = {}) {
  return {
    id, name: id, repo: join(root, "repo"), worktree: join(root, "workers", id), branch: `pi/${id}`,
    cwd: join(root, "workers", id), baseRef: "HEAD", status: "stopped", createdAt: 1, lastActivity: 1,
    pendingQuestions: [], ...overrides,
  };
}

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "src/item.txt"), "base");
  git(repo, "add", "src");
  git(repo, "commit", "-qm", "base");
  const config = loadConfig({ dataDir: join(root, "data"), workspaceRoot: join(root, "workers"), defaultRepo: repo, autoClean: false });
  const c = new Coordinator(config);
  await c.init();
  const original = {
    start: PiRpcClient.prototype.start,
    stop: PiRpcClient.prototype.stop,
    prompt: PiRpcClient.prototype.prompt,
    getState: PiRpcClient.prototype.getState,
  };
  PiRpcClient.prototype.start = async () => {};
  PiRpcClient.prototype.stop = async () => {};
  PiRpcClient.prototype.prompt = async function () { this.emit("event", { type: "agent_settled" }); return { success: true }; };
  PiRpcClient.prototype.getState = async () => ({ isStreaming: false });
  try {
    await fn({ c, root, repo });
  } finally {
    Object.assign(PiRpcClient.prototype, original);
    await c.stopAll();
    await rm(root, { recursive: true, force: true });
  }
}

test("spawn records satisfied dependencies and exposes them", () =>
  fixture(async ({ c, root, repo }) => {
    const dep = historyEntry(root, "dep1", {
      integration: { workerSha: "a".repeat(40), targetBranch: "main", previousTargetSha: "b".repeat(40),
        mergedSha: "c".repeat(40), candidateTree: "tree", integratedAt: 5 },
    });
    c.history.push(dep);
    const worker = await c.spawn({ repo, spec: { goal: "dependent work", scope: ["src/item.txt"] }, blocked_by: ["dep1"] });
    assert.deepEqual(worker.blockedBy, ["dep1"]);
    assert.deepEqual(c.list().find((meta) => meta.id === worker.id).blockedBy, ["dep1"]);
    await c.stop(worker.id, { preserveWorktree: true });
  }));

test("unintegrated, failed and unknown dependencies fail closed", () =>
  fixture(async ({ c, root, repo }) => {
    c.history.push(historyEntry(root, "working1", { status: "working" }));
    c.history.push(historyEntry(root, "failed1", { status: "error", error: "provider failed" }));
    await assert.rejects(
      c.spawn({ repo, spec: { goal: "blocked", scope: ["src/item.txt"] }, blocked_by: ["working1"] }),
      /blocked_by sessions are not integrated yet: working1 \(working\)/,
    );
    await assert.rejects(
      c.spawn({ repo, spec: { goal: "failed", scope: ["src/item.txt"] }, blocked_by: ["failed1"] }),
      /deps_failed: failed1 \(error\)/,
    );
    await assert.rejects(
      c.spawn({ repo, spec: { goal: "unknown", scope: ["src/item.txt"] }, blocked_by: ["nope"] }),
      /unknown dependency: nope/,
    );
    assert.equal(c.list().length, 0);
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", "pi/*"], { encoding: "utf8" }).trim();
    assert.equal(branches, "");
  }));

test("a recorded dependency cycle rejects any further blocked spawn", () =>
  fixture(async ({ c, root, repo }) => {
    c.history.push(historyEntry(root, "a", { blockedBy: ["b"] }));
    c.history.push(historyEntry(root, "b", { blockedBy: ["a"] }));
    await assert.rejects(
      c.spawn({ repo, spec: { goal: "cyclic", scope: ["src/item.txt"] }, blocked_by: ["a"] }),
      /dependency cycle detected: (a -> b -> a|b -> a -> b)/,
    );
  }));

test("a settled verification-only success satisfies a dependency", () =>
  fixture(async ({ c, root, repo }) => {
    c.history.push(historyEntry(root, "review1", {
      outcome: "success_first",
      verification: { passed: true, codeChanged: false, workerSha: "a".repeat(40), targetSha: "b".repeat(40),
        targetBranch: "main", candidateTree: "tree", id: "v1", epoch: "e1", verifiedAt: 1,
        command: "npm test", changedFiles: [], existingValidationChanges: [], result: { code: 0, stdout: "", stderr: "", timedOut: false } },
    }));
    const worker = await c.spawn({ repo, spec: { goal: "after review", scope: ["src/item.txt"] }, blocked_by: ["review1"] });
    assert.deepEqual(worker.blockedBy, ["review1"]);
    await c.stop(worker.id, { preserveWorktree: true });
  }));
