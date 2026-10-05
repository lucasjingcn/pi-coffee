import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";
import { StateStore } from "../dist/state-store.js";
import { ControlVault } from "../dist/control-vault.js";

const posix = { skip: process.platform === "win32" };
const sha = (char) => char.repeat(40);
const CONTROL_KEY = "k".repeat(43);

/** Minimal pi RPC stand-in: creates a transcript, answers get_state, settles prompts. */
const FAKE_PI = `const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
fs.mkdirSync(sessionDir, { recursive: true });
fs.appendFileSync(path.join(sessionDir, "2026-01-01T00-00-00-000Z_01fake.jsonl"), "{}\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  const data = cmd.type === "get_state" ? { isStreaming: false } : {};
  process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, success: true, data }) + "\\n");
  if (cmd.type === "prompt") process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
});`;

async function makeRepo(root) {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.test"]);
  await writeFile(join(repo, "base"), "base");
  execFileSync("git", ["-C", repo, "add", "base"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  return repo;
}

/** A history entry holding every bulk field reclamation is allowed to trim. */
function bulkEntry(id, repo, worktree) {
  return {
    id, name: `${id}-fixture`, status: "stopped", createdAt: 1, lastActivity: 1,
    repo, worktree, branch: `pi/${id}`, cwd: repo, baseRef: sha("e"), pendingQuestions: [],
    outcome: "success_first", outcomeNote: "completed and integrated",
    lastText: "final report line ".repeat(1_500),
    cost: 0.42, tokens: { input: 10, output: 20, total: 30 },
    context: { tokens: 5, contextWindow: 1_000, percent: 5 },
    instructionsSent: 2, turns: 3, extension: true, extensionAt: 1,
    spec: {
      goal: "g".repeat(4_000), scope: ["src"], purpose: "implementation", task_type: "mechanical",
      requirements: [{ id: "R1", text: "must do the thing" }],
      contracts: ["c".repeat(4_000)], constraints: ["k".repeat(4_000)], non_goals: ["n".repeat(4_000)],
    },
    acceptance: { files: ["src/a.test.ts"], command: "true", hashes: { "/src/a.test.ts": "a".repeat(64) } },
    verification: {
      id: "v1", epoch: "e1", workerSha: sha("a"), targetSha: sha("b"), candidateTree: sha("c"), targetBranch: "main",
      command: "true", verifiedAt: 1, passed: true, codeChanged: true, changedFiles: ["src/a.ts"],
      existingValidationChanges: [], reviewContractHash: "d".repeat(64),
      result: { code: 0, stdout: "o".repeat(60_000), stderr: "e".repeat(60_000), timedOut: false },
    },
    candidateReview: {
      verificationId: "v1", reviewedAt: 1,
      requirements: [{ id: "R1", met: true, evidence: "read the diff" }], test_changes: [],
    },
    integration: {
      workerSha: sha("a"), targetBranch: "main", previousTargetSha: sha("b"),
      mergedSha: sha("c"), candidateTree: sha("d"), integratedAt: 1,
    },
    workerProcess: { pid: 4242, platform: process.platform, started: "1" },
    heldLocks: [{ path: "/src/a.ts", mode: "rw", sessionId: id, ts: 1, repo: "repo" }],
  };
}

/**
 * Coordinate a data dir seeded with state.json entries. `build` receives the temp
 * root and repo so it can create (or deliberately omit) worktrees and transcripts.
 */
async function fixture(build, fn, { fakePi = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-reclaim-"));
  const repo = await makeRepo(root);
  const dataDir = join(root, "data");
  await mkdir(join(dataDir, "sessions"), { recursive: true });
  await mkdir(join(dataDir, "control-credentials"), { recursive: true, mode: 0o700 });
  const entries = await build({ root, repo, dataDir, worktrees: join(root, "worktrees") });
  for (const entry of entries) {
    await writeFile(join(dataDir, "control-credentials", `${entry.id}.json`),
      JSON.stringify({ controlKey: CONTROL_KEY, scopeKey: `scope-${entry.id}` }), { mode: 0o600 });
  }
  const statePath = join(dataDir, "state.json");
  await writeFile(statePath, JSON.stringify({ counter: entries.length, history: entries.map((entry) => entry.meta) }));
  const stateBytes = (await readFile(statePath, "utf8")).length;

  const previousBin = process.env.PI_COFFEE_PI_BIN;
  if (fakePi) {
    const fakeBin = join(root, "fake-pi.js");
    await writeFile(fakeBin, FAKE_PI);
    process.env.PI_COFFEE_PI_BIN = fakeBin;
  }
  const coordinator = new Coordinator(loadConfig({ dataDir, workspaceRoot: join(root, "worktrees"), autoClean: false }));
  try {
    await coordinator.init();
    await fn({ coordinator, dataDir, repo, root, statePath, stateBytes, entries });
  } finally {
    await coordinator.stopAll().catch(() => {});
    if (previousBin === undefined) delete process.env.PI_COFFEE_PI_BIN;
    else process.env.PI_COFFEE_PI_BIN = previousBin;
    await rm(root, { recursive: true, force: true });
  }
}

/** s1/s3 unrecoverable, s2 resumable, s4 keeps its worktree, s5 keeps its transcript. */
async function mixedEntries({ root, repo, dataDir, worktrees }) {
  const sessions = join(dataDir, "sessions");
  await mkdir(join(worktrees, "s2"), { recursive: true });
  await mkdir(join(sessions, "s2", "agent"), { recursive: true });
  await writeFile(join(sessions, "s2", "2026-01-01T00-00-00-000Z_01a.jsonl"), "{}\n");
  await mkdir(join(worktrees, "s4"), { recursive: true });
  await mkdir(join(worktrees, "s5"), { recursive: true });
  await mkdir(join(sessions, "s5", "agent"), { recursive: true });
  await writeFile(join(sessions, "s5", "2026-01-01T00-00-00-000Z_01b.jsonl"), "{}\n");
  void root;
  return [
    { id: "s1", meta: bulkEntry("s1", repo, join(worktrees, "s1")) },
    { id: "s2", meta: { ...bulkEntry("s2", repo, join(worktrees, "s2")), outcome: undefined, outcomeNote: undefined } },
    {
      id: "s3",
      meta: {
        ...bulkEntry("s3", repo, join(worktrees, "s3")),
        outcome: undefined, outcomeNote: undefined, verification: undefined, candidateReview: undefined, integration: undefined,
      },
    },
    { id: "s4", meta: bulkEntry("s4", repo, join(worktrees, "s4")) },
    { id: "s5", meta: bulkEntry("s5", repo, join(worktrees, "s5")) },
  ];
}

test("gc reclaims credentials and bulk evidence only where nothing can be resumed", async () => {
  await fixture(mixedEntries, async ({ coordinator, dataDir, statePath, stateBytes }) => {
    const result = await coordinator.gc(["s1", "s2", "s3", "s4", "s5"]);
    assert.equal(result.credentials_reclaimed, 2, JSON.stringify(result));
    assert.equal(result.history_compacted, 2, JSON.stringify(result));

    const reclaimed = coordinator.snapshot("s1");
    assert.deepEqual([...reclaimed.reclaimed.fields].sort(),
      ["acceptance.hashes", "heldLocks", "lastText", "spec", "verification.result", "workerProcess"]);
    assert.equal(reclaimed.reclaimed.credential, true);
    // Everything the scoreboard reads survives untouched.
    assert.equal(reclaimed.outcome, "success_first");
    assert.equal(reclaimed.cost, 0.42);
    assert.deepEqual(reclaimed.tokens, { input: 10, output: 20, total: 30 });
    assert.equal(reclaimed.spec.purpose, "implementation");
    assert.deepEqual(reclaimed.spec.requirements, [{ id: "R1", text: "must do the thing" }]);
    assert.equal(reclaimed.candidateReview.verificationId, "v1");
    assert.equal(reclaimed.verification.id, "v1");
    assert.equal(reclaimed.verification.passed, true);
    assert.equal(reclaimed.integration.mergedSha, sha("c"));
    assert.equal(reclaimed.verification.result.compacted, true);
    assert.ok(reclaimed.verification.result.stdout.length < 3_000, "acceptance output is trimmed to a tail");
    assert.ok(reclaimed.lastText.length < 1_000, "the final message is trimmed to a tail");
    assert.equal(reclaimed.spec.goal, "");
    assert.deepEqual(reclaimed.acceptance.hashes, {});
    assert.deepEqual(reclaimed.acceptance.files, ["src/a.test.ts"]);
    assert.equal(reclaimed.workerProcess, undefined);
    assert.deepEqual(reclaimed.heldLocks, []);

    // Anything still recoverable keeps its credential and its evidence.
    for (const id of ["s2", "s4", "s5"]) {
      assert.equal(coordinator.snapshot(id).reclaimed, undefined, `${id} must not be reclaimed`);
      assert.equal(coordinator.snapshot(id).verification.result.stdout.length, 60_000, `${id} keeps full evidence`);
      assert.ok(existsSync(join(dataDir, "control-credentials", `${id}.json`)), `${id} keeps its credential`);
    }
    for (const id of ["s1", "s3"]) {
      assert.equal(existsSync(join(dataDir, "control-credentials", `${id}.json`)), false, `${id} credential is deleted`);
    }

    await coordinator.flush();
    const after = (await readFile(statePath, "utf8")).length;
    // Two entries carry ~330 KB of payload that is now reclaimable; the three
    // recoverable ones must still hold their full copy, so the file cannot be tiny.
    assert.ok(after < stateBytes - 150_000, `state.json should shrink: ${stateBytes} -> ${after}`);

    // A compacted entry must still satisfy the strict on-disk validation.
    const reloaded = new Coordinator(loadConfig({ dataDir, workspaceRoot: join(dataDir, "worktrees"), autoClean: false }));
    await reloaded.init();
    try {
      assert.equal(reloaded.snapshot("s1").outcome, "success_first");
      assert.equal(reloaded.snapshot("s1").reclaimed.fields.length, 6);
      assert.equal(reloaded.snapshot("s1").spec.requirements.length, 1);
    } finally { await reloaded.stopAll().catch(() => {}); }
  });
});

test("a live worker is never reclaimed, even with no worktree or transcript left", posix, async () => {
  await fixture(async () => [], async ({ coordinator, dataDir, repo }) => {
    const spawned = await coordinator.spawn({
      repo, task: "reclaim-live", prompt: "work",
      spec: { goal: "write something", scope: ["src"], purpose: "implementation" },
      controlKey: CONTROL_KEY, scopeKey: "scope-live",
      controlKeyHash: createHash("sha256").update(CONTROL_KEY).digest("hex"),
      scopeKeyHash: createHash("sha256").update("scope-live").digest("hex"),
    });
    const id = spawned.id;
    const credential = join(dataDir, "control-credentials", `${id}.json`);
    assert.ok(existsSync(credential));

    // Erase everything that would otherwise make this session reclaimable.
    await rm(spawned.worktree, { recursive: true, force: true });
    await rm(join(dataDir, "sessions", id), { recursive: true, force: true });

    const live = await coordinator.gc([id]);
    assert.equal(live.credentials_reclaimed, 0);
    assert.equal(live.history_compacted, 0);
    assert.ok(existsSync(credential), "a running worker keeps its credential");
    assert.equal(coordinator.snapshot(id).reclaimed, undefined);

    // Once stopped, nothing on disk can bring it back, so it is reclaimed.
    await coordinator.stop(id);
    // The worker branch is still alive and the session has no outcome: the daemon
    // keeps the door open (the branch could still be checked out), so nothing is
    // reclaimed until the branch is gone too.
    const kept = await coordinator.gc([id]);
    assert.equal(kept.credentials_reclaimed, 0);
    assert.equal(existsSync(credential), true);
    assert.equal(coordinator.snapshot(id).reclaimed, undefined);

    execFileSync("git", ["-C", repo, "worktree", "prune"]);
    execFileSync("git", ["-C", repo, "branch", "-D", `pi/${id}`]);
    const stopped = await coordinator.gc([id]);
    assert.equal(stopped.credentials_reclaimed, 1);
    assert.equal(existsSync(credential), false);
    assert.equal(coordinator.snapshot(id).reclaimed.credential, true);
  }, { fakePi: true });
});

test("reclamation is idempotent and leaves no trace to redo", async () => {
  await fixture(async ({ repo, worktrees }) => [{
    id: "s1",
    meta: {
      ...bulkEntry("s1", repo, join(worktrees, "s1")),
      outcome: undefined, outcomeNote: undefined, verification: undefined, candidateReview: undefined,
    },
  }], async ({ coordinator, dataDir }) => {
    const first = await coordinator.gc(["s1"]);
    assert.equal(first.credentials_reclaimed, 1);
    const second = await coordinator.gc(["s1"]);
    assert.equal(second.credentials_reclaimed, 0, "the credential is already gone");
    assert.equal(second.history_compacted, 0, "nothing is left to trim");
    assert.equal(existsSync(join(dataDir, "control-credentials", "s1.json")), false);
    assert.deepEqual([...coordinator.snapshot("s1").reclaimed.fields].sort(),
      ["acceptance.hashes", "heldLocks", "lastText", "spec", "workerProcess"]);
  });
});

test("vault removal never creates a vault and never mints a replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-reclaim-vault-"));
  try {
    const vault = new ControlVault(root);
    assert.equal(await vault.remove("s1"), false, "an absent vault has nothing to remove");
    assert.equal(existsSync(join(root, "control-credentials")), false, "removal must not create the directory");
    await mkdir(join(root, "control-credentials"), { mode: 0o700 });
    await assert.rejects(vault.remove("not-a-session"), /unavailable or unsafe/);
    assert.equal(await vault.remove("s1"), false);
    await vault.save("s1", CONTROL_KEY, "scope");
    assert.notEqual(await vault.read("s1"), undefined);
    assert.equal(await vault.remove("s1"), true);
    assert.equal(await vault.read("s1"), undefined);
    assert.equal(await vault.remove("s1"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed reclamation marker is rejected on load", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-reclaim-state-"));
  try {
    const repo = await makeRepo(root);
    const path = join(root, "state.json");
    const meta = { ...bulkEntry("s1", repo, join(root, "gone")), reclaimed: { at: "soon", credential: true, fields: [] } };
    await writeFile(path, JSON.stringify({ counter: 1, history: [meta] }));
    await assert.rejects(new StateStore(path).load(), /reclaimed is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeTranscript(dataDir, id) {
  const dir = join(dataDir, "sessions", id);
  await mkdir(join(dir, "agent"), { recursive: true });
  await writeFile(join(dir, "2026-01-01T00-00-00-000Z_01.jsonl"), "{}\n");
}

test("a transcript whose work is beyond recovery is reclaimed; a live branch is kept", async () => {
  await fixture(async ({ repo, dataDir, worktrees }) => {
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await makeTranscript(dataDir, "s10");
    await makeTranscript(dataDir, "s11");
    await makeTranscript(dataDir, "s12");
    // s11 keeps a live branch with no outcome; s10 has an outcome; s12 has no branch.
    execFileSync("git", ["-C", repo, "branch", "pi/s11", base]);
    return [
      { id: "s10", meta: { ...bulkEntry("s10", repo, join(worktrees, "s10")), baseRef: base } },
      { id: "s11", meta: { ...bulkEntry("s11", repo, join(worktrees, "s11")), baseRef: base, outcome: undefined, outcomeNote: undefined } },
      { id: "s12", meta: { ...bulkEntry("s12", repo, join(worktrees, "s12")), baseRef: base, outcome: undefined, outcomeNote: undefined } },
    ];
  }, async ({ coordinator, dataDir }) => {
    const result = await coordinator.gc(["s10", "s11", "s12"]);
    assert.equal(result.transcripts_reclaimed, 2, JSON.stringify(result));
    assert.equal(result.credentials_reclaimed, 2);
    assert.equal(existsSync(join(dataDir, "sessions", "s10")), false);
    assert.equal(existsSync(join(dataDir, "sessions", "s12")), false);
    assert.ok(coordinator.snapshot("s10").reclaimed.fields.includes("transcript"));
    assert.ok(coordinator.snapshot("s12").reclaimed.fields.includes("transcript"));

    // s11 has a live branch and no outcome: everything stays.
    assert.equal(existsSync(join(dataDir, "sessions", "s11")), true);
    assert.equal(existsSync(join(dataDir, "control-credentials", "s11.json")), true);
    assert.equal(coordinator.snapshot("s11").reclaimed, undefined);
  });
});

test("a transcript removed in a later pass is still recorded on the reclaimed marker", async () => {
  await fixture(async ({ repo, dataDir, worktrees }) => {
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await makeTranscript(dataDir, "s20");
    // Already beyond recovery, credential and bulk already reclaimed in a prior pass;
    // only the transcript directory is still here to remove.
    return [{
      id: "s20",
      meta: {
        id: "s20", name: "already-reclaimed", status: "stopped", createdAt: 1, lastActivity: 1,
        repo, cwd: repo, worktree: join(worktrees, "s20"), branch: "pi/s20", baseRef: base, pendingQuestions: [],
        outcome: "success_first", outcomeNote: "done",
        reclaimed: { at: 1, credential: true, fields: [] },
      },
    }];
  }, async ({ coordinator, dataDir }) => {
    const result = await coordinator.gc(["s20"]);
    assert.equal(result.transcripts_reclaimed, 1, JSON.stringify(result));
    assert.equal(existsSync(join(dataDir, "sessions", "s20")), false);
    assert.ok(coordinator.snapshot("s20").reclaimed.fields.includes("transcript"),
      "the later transcript removal must still be recorded in the marker");
  });
});
