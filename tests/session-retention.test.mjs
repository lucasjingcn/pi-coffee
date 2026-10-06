import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";

const HOUR = 60 * 60 * 1000;
const OLD = new Date(Date.now() - 49 * HOUR);

async function fixture(fn, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-retention-"));
  const config = loadConfig({
    dataDir: join(root, "data"),
    workspaceRoot: join(root, "worktrees"),
    autoClean: true,
    ...overrides,
  });
  const c = new Coordinator(config);
  await c.init();
  try {
    await fn(c, config, root);
  } finally {
    await c.stopAll().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

/** Create `<dataDir>/sessions/<id>` and optionally backdate its mtime. */
async function makeSessionDir(config, id, mtime) {
  const dir = join(config.dataDir, "sessions", id);
  await mkdir(dir, { recursive: true });
  if (mtime) await utimes(dir, mtime, mtime);
  return dir;
}

function schemaMeta(id, lastActivity, extra = {}) {
  return {
    id, name: id, repo: "", worktree: "", branch: "", cwd: "", baseRef: "HEAD",
    status: "stopped", createdAt: lastActivity, lastActivity, pendingQuestions: [],
    ...extra,
  };
}

async function readEvents(dataDir) {
  const file = join(dataDir, "logs", "workers.jsonl");
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

test("TTL sweep removes only session dirs whose session is stopped and older than 48h", async () => {
  await fixture(async (c, config) => {
    const now = Date.now();
    const cases = [
      { id: "both-old", meta: schemaMeta("both-old", now - 49 * HOUR), mtime: OLD, removed: true },
      // Activity is fresher than the directory mtime: max() must keep it.
      { id: "recent-activity", meta: schemaMeta("recent-activity", now), mtime: OLD, removed: false },
      // The directory was touched just now: max() must keep it too.
      { id: "recent-dir", meta: schemaMeta("recent-dir", now - 49 * HOUR), mtime: new Date(), removed: false },
      // Not stopped: never deleted, regardless of age.
      { id: "active", meta: { ...schemaMeta("active", now - 49 * HOUR), status: "working" }, mtime: OLD, removed: false },
    ];
    for (const cse of cases) {
      await makeSessionDir(config, cse.id, cse.mtime);
      c.history.push(cse.meta);
    }
    // No state entry: nothing here knows whether it is still wanted, so it stays.
    await makeSessionDir(config, "unknown", OLD);

    const removed = await c["sweepSessionDirs"]();
    assert.equal(removed, 1);
    for (const cse of cases) {
      assert.equal(existsSync(join(config.dataDir, "sessions", cse.id)), !cse.removed, `${cse.id} removal=${cse.removed}`);
    }
    assert.equal(existsSync(join(config.dataDir, "sessions", "unknown")), true);

    const reclaim = (await readEvents(config.dataDir)).find((event) => event.event === "reclaim" && event.id === "both-old");
    assert.ok(reclaim, "TTL deletion is recorded in the event log");
    assert.equal(reclaim.transcript, true);
    assert.equal(reclaim.reason, "ttl");
    assert.ok(!Number.isNaN(Date.parse(reclaim.ts)));
  });
});

test("the periodic sweep applies the TTL end to end and autoClean=false disables it", async () => {
  await fixture(async (c, config, root) => {
    const repo = join(root, "repo");
    await mkdir(repo);
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    await writeFile(join(repo, "base.txt"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    // The live branch keeps the session out of reclaimStale; only the TTL may remove it.
    git("branch", "pi/keep-alive");

    const id = "expired-stopped";
    await makeSessionDir(config, id, OLD);
    c.history.push({ ...schemaMeta(id, Date.now() - 49 * HOUR), repo, branch: "pi/keep-alive" });

    await c["sweep"]();
    assert.equal(existsSync(join(config.dataDir, "sessions", id)), false);
    const reclaim = (await readEvents(config.dataDir)).find((event) => event.event === "reclaim" && event.id === id);
    assert.ok(reclaim);
    assert.equal(reclaim.reason, "ttl");
  });

  await fixture(async (c, config) => {
    const id = "expired-kept";
    await makeSessionDir(config, id, OLD);
    c.history.push(schemaMeta(id, Date.now() - 49 * HOUR));
    await c["sweep"]();
    assert.equal(existsSync(join(config.dataDir, "sessions", id)), true);
  }, { autoClean: false });
});
