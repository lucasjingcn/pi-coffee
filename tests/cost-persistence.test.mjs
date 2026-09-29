import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";

const cost = (id, amount, session_ids, extra = {}) => ({
  id, amount, session_ids, currency: "USD", source: "provider", reference: `invoice:${id}`, ...extra,
});

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-cost-persistence-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  const stateFile = join(dataDir, "state.json");
  const initialized = new Set();
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    await mkdir(repo);
    await mkdir(dataDir);
    git("init", "-b", "main");
    git("config", "user.name", "Cost Test");
    git("config", "user.email", "cost-test@example.test");
    await writeFile(join(repo, "base.txt"), "fixture\n");
    git("add", "base.txt");
    git("commit", "-m", "fixture");
    const baseRef = git("rev-parse", "HEAD");
    const meta = (id, amount, extra = {}) => ({
      id, name: id, repo, branch: `pi/${id}`, worktree: join(root, `missing-${id}`), cwd: repo, baseRef,
      status: "stopped", createdAt: 1, lastActivity: 2, pendingQuestions: [], cost: amount,
      tokens: { input: 5, output: 10 }, outcome: "success_first", ...extra,
    });
    const seed = async (history, records = []) => writeFile(stateFile, JSON.stringify({
      counter: 0, mailbox: [], board: [], history, orchestratorCosts: records,
    }));
    const open = async () => {
      const coordinator = new Coordinator(loadConfig({ dataDir, workspaceRoot: join(root, "workers"), autoClean: false }));
      await coordinator.init();
      initialized.add(coordinator);
      assert.deepEqual(coordinator.list(), [], "history restoration must not spawn a worker");
      return coordinator;
    };
    const close = async (coordinator) => {
      await coordinator.stopAll();
      initialized.delete(coordinator);
    };
    await fn({ root, repo, stateFile, git, meta, seed, open, close });
  } finally {
    for (const coordinator of initialized) await coordinator.stopAll();
    await rm(root, { recursive: true, force: true });
  }
}

test("cost registration is idempotent, rejects conflicting ids and unknown sessions", async () => fixture(async ({ meta, seed, open }) => {
  await seed([meta("s1", 2), meta("s2", 3)]);
  const coordinator = await open();
  const first = cost("usage-1", 4, ["s1"]);
  assert.deepEqual(coordinator.recordCost(first), first);
  assert.deepEqual(coordinator.recordCost(first), first);
  assert.throws(() => coordinator.recordCost({ ...first, amount: 5 }), /different data|conflict/i);
  assert.throws(() => coordinator.recordCost(cost("unknown", 1, ["s999"])), /unknown session/i);
  const metrics = await coordinator.metrics(["s1"]);
  assert.equal(metrics.orchestrator.records.length, 1);
  assert.equal(metrics.orchestrator.total, 4);
  assert.equal(metrics.combined.total, 6);
}));

test("stopAll flush and restart preserve recorded costs and provenance", async () => fixture(async ({ meta, seed, open, close, stateFile }) => {
  await seed([meta("s1", 2), meta("s2", 3, { outcome: "success_second" })]);
  const first = await open();
  first.recordCost(cost("manual", 4, ["s1", "s2"], { source: "manual", reference: "operator ledger 42" }));
  first.recordCost(cost("retry", 1, ["s2"], { source: "estimate", reference: "retry budget estimate" }));
  const before = await first.metrics();
  await close(first);
  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(persisted.orchestratorCosts.length, 2);
  const restarted = await open();
  assert.deepEqual(await restarted.metrics(), before);
  assert.deepEqual((await restarted.metrics()).orchestrator.sources, ["manual", "estimate"]);
  assert.equal((await restarted.metrics()).combined.total, 10);
}));

test("historical failures and rework count while unrecorded amounts remain unknown", async () => fixture(async ({ meta, seed, open }) => {
  await seed([
    meta("s1", 2, { status: "error", outcome: "abandoned" }),
    meta("s2", 3, { outcome: "success_second" }),
    meta("s3", undefined, { outcome: "taken_over" }),
  ]);
  const coordinator = await open();
  const metrics = await coordinator.metrics();
  assert.equal(metrics.sessions.length, 3);
  assert.equal(metrics.worker.known_subtotal, 5);
  assert.equal(metrics.worker.total, null);
  assert.deepEqual(metrics.worker.missing_session_ids, ["s3"]);
  assert.equal(metrics.sessions.find((entry) => entry.id === "s3").cost, null);
  assert.equal(metrics.orchestrator.total, null);
  assert.equal(metrics.combined.total, null);
  assert.deepEqual(metrics.orchestrator.missing_session_ids, ["s1", "s2", "s3"]);
}));

test("GC deleting merged and empty abandoned historical branches retains cost evidence across restart", async () => fixture(async ({ meta, seed, open, close, git }) => {
  git("branch", "pi/s1");
  git("branch", "pi/s2");
  await seed([meta("s1", 2), meta("s2", 3, { outcome: "abandoned" })], [cost("all", 4, ["s1", "s2"])]);
  const coordinator = await open();
  const before = await coordinator.metrics();
  const gc = await coordinator.gc();
  assert.equal(gc.branches_deleted, 2);
  assert.throws(() => git("rev-parse", "--verify", "refs/heads/pi/s1"));
  assert.throws(() => git("rev-parse", "--verify", "refs/heads/pi/s2"));
  assert.deepEqual(await coordinator.metrics(), before);
  await close(coordinator);
  const restarted = await open();
  assert.deepEqual(await restarted.metrics(), before);
  assert.equal((await restarted.metrics()).combined.total, 9);
}));

test("more than 500 historical sessions and their earliest costs survive round trip", async () => fixture(async ({ meta, seed, open, close, stateFile }) => {
  const history = Array.from({ length: 505 }, (_, index) => meta(`s${index + 1}`, 1, {
    outcome: index % 2 === 0 ? "success_second" : "abandoned",
  }));
  await seed(history, [cost("whole-ledger", 10, history.map((entry) => entry.id))]);
  const coordinator = await open();
  assert.equal((await coordinator.metrics()).worker.total, 505);
  assert.equal((await coordinator.metrics()).combined.total, 515);
  await close(coordinator);
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(saved.history.length, 505);
  assert.equal(saved.history[0].id, "s1");
  const restarted = await open();
  const metrics = await restarted.metrics();
  assert.equal(metrics.sessions.length, 505);
  assert.equal(metrics.worker.total, 505);
  assert.equal(metrics.combined.total, 515);
}));

test("persisted orchestrator cost without its source is rejected rather than accepted as zero", async () => fixture(async ({ meta, seed, open, stateFile }) => {
  const invalid = cost("bad", 4, ["s1"]);
  delete invalid.source;
  await seed([meta("s1", 2)], [invalid]);
  const original = await readFile(stateFile, "utf8");
  await assert.rejects(open(), /state|orchestratorCosts|invalid/i);
  assert.equal(await readFile(stateFile, "utf8"), original);
}));
