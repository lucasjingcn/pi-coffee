import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";
import { PiRpcClient } from "../dist/rpc-client.js";
import { appendWorkerEvent, WORKER_EVENT_MAX_BYTES } from "../dist/log.js";

// No real pi process: the coordinator's lifecycle and the event log are under test,
// not the RPC transport.
PiRpcClient.prototype.start = async function () {};
PiRpcClient.prototype.stop = async function () { this.shutdownConfirmed = true; };
PiRpcClient.prototype.prompt = async function () { this.emit("event", { type: "agent_settled" }); return { success: true }; };
PiRpcClient.prototype.getState = async function () { return { isStreaming: false }; };
PiRpcClient.prototype.getSessionStats = async function () { return { cost: 0, tokens: {}, assistantMessages: 0 }; };

async function fixture(fn, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-events-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  await writeFile(join(repo, "base.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  const config = loadConfig({
    dataDir: join(root, "data"),
    workspaceRoot: join(root, "worktrees"),
    defaultRepo: repo,
    autoClean: false,
    ...overrides,
  });
  const c = new Coordinator(config);
  await c.init();
  try {
    return await fn(c, config, repo);
  } finally {
    await c.stopAll().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

/** Every event line, in append order. */
async function readEvents(dataDir) {
  const file = join(dataDir, "logs", "workers.jsonl");
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

test("spawn and finish events are appended with spec fields and transcript counters", async () => {
  await fixture(async (c, config, repo) => {
    const meta = await c.spawn({
      repo,
      name: "events-worker",
      spec: { goal: "g", scope: ["src"], task_type: "feature", purpose: "implementation" },
    });

    const afterSpawn = await readEvents(config.dataDir);
    assert.equal(afterSpawn.length, 1);
    const spawn = afterSpawn[0];
    assert.equal(spawn.event, "spawn");
    assert.equal(spawn.id, meta.id);
    assert.equal(spawn.name, "events-worker");
    assert.equal(spawn.repo, repo);
    assert.equal(spawn.task_type, "feature");
    assert.equal(spawn.purpose, "implementation");
    assert.ok(!Number.isNaN(Date.parse(spawn.ts)), "ts is ISO8601");
    assert.equal(new Date(spawn.ts).toISOString(), spawn.ts);

    // The finish counters read the worker's own top-level transcripts.
    const sessionDir = join(config.dataDir, "sessions", meta.id);
    await writeFile(join(sessionDir, "transcript.jsonl"), [
      JSON.stringify({ message: { role: "toolResult", isError: true, content: [{ type: "text", text: "Recognized shell write target escapes the worker worktree or enters Git metadata." }] } }),
      JSON.stringify({ message: { role: "toolResult", isError: true, content: [{ type: "text", text: "File is claimed by another worker: a.ts @ s9. Coordinate with coord_send." }] } }),
      JSON.stringify({ message: { role: "toolResult", isError: true, content: [{ type: "text", text: "edits[0] and edits[1] overlap in src/a.ts" }] } }),
      JSON.stringify({ message: { role: "toolResult", isError: false, content: [{ type: "text", text: "ok" }] } }),
      JSON.stringify({ message: { role: "assistant", content: "working" } }),
      "{ not json",
      "",
    ].join("\n") + "\n");
    // agent/run-history.jsonl is pi's internal history, not the worker conversation.
    await writeFile(join(sessionDir, "agent", "run-history.jsonl"),
      JSON.stringify({ message: { role: "toolResult", isError: true, content: [{ type: "text", text: "must not be counted" }] } }) + "\n");

    // A leftover file makes the worktree dirty.
    await writeFile(join(meta.worktree, "leftover.txt"), "x\n");
    meta.turns = 4;
    meta.cost = 0.25;

    await c.setOutcome(meta.id, "abandoned", "test cleanup");

    const events = await readEvents(config.dataDir);
    const finish = events.find((event) => event.event === "finish" && event.id === meta.id);
    assert.ok(finish, "finish event written");
    assert.equal(finish.outcome, "abandoned");
    assert.equal(finish.turns, 4);
    assert.equal(finish.cost, 0.25);
    assert.equal(finish.guard_blocks, 2, "guard blocks counted apart from tool errors");
    assert.equal(finish.tool_errors, 1, "guard blocks are not double-counted as tool errors");
    assert.equal(finish.dirty, true);

    // Append-only: the spawn line is still intact and precedes the finish line.
    assert.equal(events[0].event, "spawn");
    assert.ok(events.indexOf(finish) > 0);
  });
});

test("spawn without a spec records null task_type/purpose and finish degrades to null counters", async () => {
  await fixture(async (c, config, repo) => {
    const meta = await c.spawn({ repo });
    const spawn = (await readEvents(config.dataDir)).find((event) => event.event === "spawn" && event.id === meta.id);
    assert.ok(spawn);
    assert.equal(spawn.task_type, null);
    assert.equal(spawn.purpose, null);

    // No transcript was written by the mocked pi: counts must be null, not zero.
    await c.setOutcome(meta.id, "abandoned", "test cleanup");
    const finish = (await readEvents(config.dataDir)).find((event) => event.event === "finish" && event.id === meta.id);
    assert.ok(finish);
    assert.equal(finish.guard_blocks, null);
    assert.equal(finish.tool_errors, null);
    assert.equal(finish.dirty, false);
    assert.equal(finish.turns, null);
    assert.equal(finish.cost, null);
  });
});

test("reclaim of an unrecoverable session is recorded once", async () => {
  await fixture(async (c, config, repo) => {
    const id = "s7";
    await mkdir(join(config.dataDir, "sessions", id), { recursive: true });
    c.history.push({
      id,
      name: "gone",
      repo,
      branch: "pi/gone",
      worktree: join(config.workspaceRoot, id),
      cwd: repo,
      baseRef: "HEAD",
      status: "stopped",
      createdAt: 1,
      lastActivity: 1,
      pendingQuestions: [],
      outcome: "abandoned",
    });
    await c["reclaimStale"]();
    assert.equal(existsSync(join(config.dataDir, "sessions", id)), false, "transcript removed");
    const reclaim = (await readEvents(config.dataDir)).filter((event) => event.event === "reclaim" && event.id === id);
    assert.equal(reclaim.length, 1);
    assert.equal(reclaim[0].transcript, true);
  });
});

test("a failing lifecycle log is swallowed, logged once, and never blocks a spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-events-fail-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  await writeFile(join(repo, "base.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  const dataDir = join(root, "data");
  const c = new Coordinator(loadConfig({ dataDir, workspaceRoot: join(root, "worktrees"), defaultRepo: repo, autoClean: false }));
  await c.init();
  // Occupy the log directory path with a file so the append must fail.
  await writeFile(join(dataDir, "logs"), "not a directory\n");

  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(" ")); };
  let meta;
  try {
    meta = await c.spawn({ repo, spec: { goal: "g", scope: ["src"] } });
  } finally {
    console.error = original;
    await c.stopAll().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
  assert.ok(meta && meta.id, "spawn still succeeds");
  const failures = logged.filter((line) => line.includes("worker event log write failed"));
  assert.equal(failures.length, 1, "exactly one logLine per failed write");
});

test("event lines stay within 4 KB and append without rewriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-events-bound-"));
  const file = join(root, "logs", "workers.jsonl");
  try {
    const first = { ts: new Date().toISOString(), id: "s1", event: "spawn", name: "small" };
    assert.equal(appendWorkerEvent(file, first), true);
    const huge = { ts: new Date().toISOString(), id: "s2", event: "finish", blob: "x".repeat(8_000) };
    assert.equal(appendWorkerEvent(file, huge), true);
    const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.ok(Buffer.byteLength(line, "utf8") <= WORKER_EVENT_MAX_BYTES, `line within budget: ${Buffer.byteLength(line, "utf8")} bytes`);
      JSON.parse(line);
    }
    assert.deepEqual(JSON.parse(lines[0]), first);
    assert.deepEqual(JSON.parse(lines[1]), { ts: huge.ts, id: "s2", event: "finish", truncated: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
