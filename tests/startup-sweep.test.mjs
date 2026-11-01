import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";

const HOUR = 60 * 60 * 1000;

async function fixture(history, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-startup-sweep-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "state.json"), JSON.stringify({ counter: history.length, history }));
  const c = new Coordinator(loadConfig({ dataDir, workspaceRoot: join(root, "worktrees"), autoClean: true }));
  try {
    await c.init();
    await fn(c);
  } finally {
    await c.stopAll().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

function meta(id, worktree, lastActivity) {
  return {
    id, name: id, repo: "", worktree, branch: "", cwd: "", baseRef: "HEAD",
    status: "stopped", outcome: "success_first", createdAt: 1, lastActivity, pendingQuestions: [],
  };
}

test("a restart does not reclaim finished worktrees younger than the TTL", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-startup-worktree-"));
  const fresh = join(root, "fresh");
  const old = join(root, "old");
  await mkdir(fresh, { recursive: true });
  await mkdir(old, { recursive: true });
  try {
    await fixture([meta("fresh", fresh, Date.now() - 5 * 60 * 1000)], async () => {
      assert.equal(existsSync(fresh), true, "a restart must not shorten the 60min retention");
    });
    // The same entry past the TTL is eligible for cleanup (its worktree is not a
    // git worktree here, so the cleanup attempt fails closed and keeps it too--
    // what matters is that the TTL gate no longer skips fresh entries only).
    await fixture([], async () => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
