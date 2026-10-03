import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";

test("cleanSessionDir removes finished stopped transcripts and preserves the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-clean-"));
  const dataDir = join(root, "data");
  const c = new Coordinator(loadConfig({ dataDir, workspaceRoot: join(root, "w"), autoClean: true }));
  await c.init();
  const dirs = ["done", "not_stopped", "no_outcome", "abandoned"];
  for (const d of dirs) await mkdir(join(dataDir, "sessions", d), { recursive: true });
  try {
    assert.equal(await c["cleanSessionDir"]({ id: "done", status: "stopped", outcome: "success_first" }), true);
    assert.equal(await c["cleanSessionDir"]({ id: "not_stopped", status: "idle", outcome: "success_first" }), false);
    assert.equal(await c["cleanSessionDir"]({ id: "no_outcome", status: "stopped", outcome: undefined }), false);
    // abandoned is not in the finished auto-clean set
    assert.equal(await c["cleanSessionDir"]({ id: "abandoned", status: "stopped", outcome: "abandoned" }), false);
    assert.equal(existsSync(join(dataDir, "sessions", "done")), false);
    assert.equal(existsSync(join(dataDir, "sessions", "not_stopped")), true);
    assert.equal(existsSync(join(dataDir, "sessions", "no_outcome")), true);
    assert.equal(existsSync(join(dataDir, "sessions", "abandoned")), true);
  } finally {
    await c.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("final retention removes clean unfinished worktrees past TTL but keeps dirty and recent ones, preserving branches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-finret-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const run = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  run(repo, "init", "-q");
  run(repo, "config", "user.name", "t");
  run(repo, "config", "user.email", "t@t");
  await writeFile(join(repo, "f.txt"), "a\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-qm", "base");
  const base = run(repo, "rev-parse", "HEAD").trim();
  const make = async (id) => {
    const d = join(root, "wt" + id);
    run(repo, "worktree", "add", "-q", "-b", "pi/s" + id, d, base);
    await writeFile(join(d, "c.txt"), id);
    run(d, "add", ".");
    run(d, "commit", "-qm", id);
    return d;
  };
  const cleanOld = await make("1");
  const dirtyOld = await make("2");
  await writeFile(join(dirtyOld, "dirty.txt"), "x"); // untracked -> dirty
  const recent = await make("3");

  const c = new Coordinator(loadConfig({ dataDir: join(root, "data"), workspaceRoot: join(root, "w"), autoClean: true, worktreeFinalTtlMin: 1 }));
  await c.init();
  try {
    const meta = (id, wt, lastActivity) => ({ id, repo, worktree: wt, branch: "pi/s" + id, status: "stopped", lastActivity });
    c.history.push(meta("1", cleanOld, Date.now() - 120_000));
    c.history.push(meta("2", dirtyOld, Date.now() - 120_000));
    c.history.push(meta("3", recent, Date.now()));
    await c["sweepFinalRetention"]();
    assert.equal(existsSync(cleanOld), false, "clean+old removed");
    assert.equal(existsSync(dirtyOld), true, "dirty kept");
    assert.equal(existsSync(recent), true, "recent kept");
    for (const id of ["1", "2", "3"]) assert.ok(run(repo, "rev-parse", "--quiet", "--verify", "refs/heads/pi/s" + id), `branch pi/s${id} kept`);
  } finally {
    await c.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});