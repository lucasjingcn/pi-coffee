import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";
import { PiRpcClient } from "../dist/rpc-client.js";

// No real pi process: the daemon's refresh throttle and statsAt bookkeeping are under test.
let statsCalls = 0;
PiRpcClient.prototype.start = async function () {};
PiRpcClient.prototype.stop = async function () { this.shutdownConfirmed = true; };
PiRpcClient.prototype.prompt = async function () { return { success: true }; };
PiRpcClient.prototype.getState = async function () { return { isStreaming: false }; };
PiRpcClient.prototype.getSessionStats = async function () {
  statsCalls++;
  return {
    cost: 0.01 * statsCalls,
    tokens: { output: 100 * statsCalls },
    contextUsage: { tokens: 10 * statsCalls, contextWindow: 1000, percent: 1 },
    assistantMessages: statsCalls,
  };
};

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-freshness-"));
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
  });
  const c = new Coordinator(config);
  await c.init();
  try {
    return await fn(c, repo);
  } finally {
    await c.stopAll().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

test("message_end refreshes running stats once per 15s and statsAt tracks the last success", async () => {
  statsCalls = 0;
  await fixture(async (c, repo) => {
    const meta = await c.spawn({ repo, name: "stats-worker" });
    const rt = c.get(meta.id);
    const snapshot = () => c.snapshot(meta.id);
    assert.equal(snapshot().statsAt ?? null, null, "stats were never read at spawn");
    assert.equal(statsCalls, 0, "spawn alone does not fetch stats");

    const messageEnd = () =>
      rt.client.emit("event", { type: "message_end", message: { role: "assistant", content: "partial answer" } });

    messageEnd();
    messageEnd();
    messageEnd();
    await flush();
    assert.equal(statsCalls, 1, "three message_end events inside one window refresh once");
    const first = snapshot().statsAt;
    assert.equal(typeof first, "number", "statsAt is exposed after a successful refresh");
    assert.equal(snapshot().turns, 1, "turns came from the throttled refresh");
    assert.equal(snapshot().tokens.output, 100);

    messageEnd();
    messageEnd();
    await flush();
    assert.equal(statsCalls, 1, "the throttle window still suppresses more refreshes");
    assert.equal(snapshot().statsAt, first);

    // agent_settled always refreshes; the throttle must never hold it back.
    rt.client.emit("event", { type: "agent_settled" });
    await flush();
    assert.equal(statsCalls, 2, "settled refresh is never throttled");
    assert.ok(snapshot().statsAt > first, "statsAt advances on the settled refresh");

    // Once the window has passed, message_end refreshes again.
    rt.lastStatsRefreshAt = Date.now() - 16_000;
    messageEnd();
    await flush();
    assert.equal(statsCalls, 3, "a later window permits the next refresh");
    assert.ok(snapshot().statsAt > first, "statsAt advances again");
    assert.equal(snapshot().turns, 3);
  });
});
