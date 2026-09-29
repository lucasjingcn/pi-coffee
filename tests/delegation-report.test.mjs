import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";
import { validateSnapshot } from "../dist/state-store.js";

const meta = (id, purpose, outcome) => ({
  id, name: "review-names-are-not-evidence", repo: "/missing/repo", branch: `pi/${id}`,
  worktree: `/missing/${id}`, cwd: "/missing/repo", baseRef: "HEAD",
  status: "stopped", createdAt: 1, lastActivity: 2, pendingQuestions: [], outcome,
  spec: { goal: "fixture", scope: ["src/a.ts"], ...(purpose ? { purpose } : {}) },
});
const snapshot = (history) => ({ counter: 0, mailbox: [], board: [], history });

test("report separates implementation, review, investigation and unclassified historical work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-delegation-report-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  const config = loadConfig({ dataDir, workspaceRoot: join(root, "workers"), autoClean: false });
  let coordinator;
  try {
    await writeFile(join(dataDir, "state.json"), JSON.stringify(snapshot([
      meta("s1", "implementation", "success_first"),
      meta("s2", "implementation", "taken_over"),
      meta("s3", "review", "success_first"),
      meta("s4", "investigation", "abandoned"),
      meta("s5", undefined, undefined),
    ])));
    coordinator = new Coordinator(config);
    await coordinator.init();
    const report = await coordinator.report();
    assert.equal(report.total_tasks, 5);
    assert.equal(report.counts.success_first, 2, "overall outcome counts still cover all purposes");
    assert.equal(report.workstreams_by_purpose.implementation.total, 2);
    assert.equal(report.workstreams_by_purpose.implementation.counts.success_first, 1,
      "a successful review is not a successful implementation");
    assert.equal(report.workstreams_by_purpose.implementation.counts.taken_over, 1);
    assert.equal(report.workstreams_by_purpose.review.total, 1);
    assert.equal(report.workstreams_by_purpose.investigation.total, 1);
    assert.equal(report.workstreams_by_purpose.unspecified.total, 1);
    assert.equal(report.tasks.find((task) => task.id === "s5").purpose, "unspecified",
      "missing purpose is never inferred from a task name");
    assert.deepEqual(report.inconsistent_outcomes.map((item) => item.id), ["s1", "s2", "s3"],
      "old recorded successes without proof remain visible but are flagged");
    const selected = await coordinator.report(["s1", "s3"]);
    assert.equal(selected.total_tasks, 2);
    assert.equal(selected.counts.success_first, 2);
    assert.equal(selected.workstreams_by_purpose.implementation.total, 1);
    assert.equal(selected.workstreams_by_purpose.review.total, 1);
    assert.deepEqual(selected.tasks.map((task) => task.id), ["s1", "s3"]);
    assert.deepEqual(selected.cost_evidence.selected_session_ids, ["s1", "s3"]);
    await assert.rejects(coordinator.report(["s999"]), /unknown session/i);
    assert.match(report.note, /not implementation contribution/);
    await coordinator.stopAll();
    coordinator = new Coordinator(config);
    await coordinator.init();
    const restarted = await coordinator.report();
    assert.deepEqual(restarted.workstreams_by_purpose, report.workstreams_by_purpose);
    assert.deepEqual(restarted.tasks.map((task) => task.purpose), report.tasks.map((task) => task.purpose));
  } finally {
    if (coordinator) await coordinator.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted purposes reject invalid classifications without guessing old records", () => {
  assert.equal(validateSnapshot(snapshot([meta("s1")]), "fixture").history[0].spec.purpose, undefined);
  for (const purpose of ["coding", "", null, 42]) {
    const record = meta("s1");
    record.spec.purpose = purpose;
    assert.throws(() => validateSnapshot(snapshot([record]), "fixture"), /spec.purpose/);
  }
});

test("archived unfinished work can be closed as abandoned without inventing acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-archived-finish-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  const config = loadConfig({ dataDir, workspaceRoot: join(root, "workers"), autoClean: false });
  let coordinator;
  try {
    await writeFile(join(dataDir, "state.json"), JSON.stringify(snapshot([meta("s1", "implementation")])));
    coordinator = new Coordinator(config);
    await coordinator.init();
    await assert.rejects(coordinator.setOutcome("s1", "taken_over", "root took over"), /archived|verification/i);
    await coordinator.setOutcome("s1", "abandoned", "Stopped without an integrated candidate");
    coordinator.setTestsOwned("s1", true);
    assert.equal(coordinator.snapshot("s1").testsOwnedByCodex, true);
    assert.equal((await coordinator.report()).counts.abandoned, 1);
    await coordinator.stopAll();
    coordinator = new Coordinator(config);
    await coordinator.init();
    assert.equal((await coordinator.report()).counts.abandoned, 1);
  } finally {
    if (coordinator) await coordinator.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});
