import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Restart auto-recovery is exercised against the real daemon (dist/index.js) with
 * an offline fake pi, because the behaviour spans startup: persisted state →
 * survivor handling → resume() → the worker's new process. Nothing here talks to
 * a provider, and every daemon exit in these tests is an unclean SIGKILL unless a
 * test says otherwise.
 */
const posix = { skip: process.platform === "win32" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake pi: appends to its transcript, records argv/pid, answers get_state, settles prompts. */
const FAKE_PI = `const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
const continued = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.mkdirSync(sessionDir, { recursive: true });
const transcript = continued ?? path.join(sessionDir, "2026-01-01T00-00-00-000Z_01fake.jsonl");
fs.appendFileSync(transcript, JSON.stringify({ type: "session", cwd: process.cwd(), continued: Boolean(continued) }) + "\\n");
if (process.env.FAKE_ARGV_FILE) {
  fs.appendFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify({
    pid: process.pid, args, session: process.env.PI_COORD_SESSION_ID, cwd: process.cwd(), transcript,
  }) + "\\n");
}
process.stdout.on("error", () => {});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  const data = cmd.type === "get_state" ? { isStreaming: false } : {};
  process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, success: true, data }) + "\\n");
  if (cmd.type === "prompt") process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
});
// A survivor: outlive the daemon so recovery has to stop an owned process group.
if (process.env.FAKE_KEEPALIVE === "1") {
  process.stdin.on("end", () => {});
  process.stdin.resume();
  setInterval(() => {}, 1000);
}`;

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

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

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killGroup(pid) {
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

async function fixture(fn, { keepalive = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-restart-recovery-"));
  const repo = await makeRepo(root);
  const fake = join(root, "fake-pi.js");
  await writeFile(fake, FAKE_PI);
  const argvFile = join(root, "argv.jsonl");
  const dataDir = join(root, "data");

  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PI_COFFEE_")) delete env[key];
  Object.assign(env, {
    PI_COFFEE_HOST: "127.0.0.1",
    PI_COFFEE_DATA_DIR: dataDir,
    PI_COFFEE_WORKSPACE_ROOT: join(root, "workers"),
    PI_COFFEE_DEFAULT_REPO: repo,
    PI_COFFEE_PI_BIN: fake,
    PI_COFFEE_TOKEN: "master-for-test",
    PI_COFFEE_AUTO_CLEAN: "0",
    PI_CODING_AGENT_DIR: join(root, "pi-agent"),
    FAKE_ARGV_FILE: argvFile,
    FAKE_KEEPALIVE: keepalive ? "1" : "0",
  });

  let proc;
  let closed;
  let base;
  let headers;

  const ctx = {
    root, repo, dataDir, argvFile,
    get base() { return base; },
    async starts() {
      try {
        return (await readFile(argvFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch { return []; }
    },
    /** (Re)start the daemon on a fresh port and wait until it serves. */
    async start() {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      headers = { "x-pi-coord-token": "master-for-test" };
      proc = spawn(process.execPath, ["dist/index.js"], { env: { ...env, PI_COFFEE_PORT: String(port) }, stdio: "ignore" });
      closed = new Promise((resolve) => proc.once("close", resolve));
      let ready = false;
      for (let i = 0; i < 250 && !ready; i += 1) {
        try { ready = (await fetch(`${base}/internal/health`, { headers })).ok; } catch { /* still starting */ }
        if (!ready) await pause(20);
      }
      assert.ok(ready, "daemon did not become healthy");
    },
    /** Unclean daemon death: no shutdown path runs, no state is rewritten. */
    async crash() {
      proc.kill("SIGKILL");
      await closed;
    },
    async get(path) {
      const response = await fetch(`${base}${path}`, { headers });
      assert.equal(response.ok, true, `GET ${path} failed`);
      return response.json();
    },
    async mcp(name, args) {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      assert.equal(response.status, 200);
      const data = await response.json();
      const text = data.result?.content?.[0]?.text ?? "";
      let body;
      try { body = JSON.parse(text); } catch { body = { error: text }; }
      return { isError: Boolean(data.result?.isError), body };
    },
    async session(id) {
      return (await ctx.get("/internal/sessions")).sessions.find((entry) => entry.id === id);
    },
    async waitFor(check, message, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await pause(50);
      }
      throw new Error(message);
    },
    async stateFile() {
      return JSON.parse(await readFile(join(dataDir, "state.json"), "utf8"));
    },
  };

  try {
    await fn(ctx);
  } finally {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await closed.catch(() => {});
    }
    for (const start of await ctx.starts()) killGroup(start.pid);
    await rm(root, { recursive: true, force: true });
  }
}

/** Spawn one worker and wait until it is idle (the fake settles immediately). */
async function spawnSettled(ctx, extra = {}) {
  const spawned = await ctx.mcp("pi_spawn", {
    task: "restart-recovery",
    prompt: "do the work",
    spec: { goal: "write src/out.txt", scope: ["src"], purpose: "implementation" },
    ...extra,
  });
  assert.equal(spawned.isError, false, JSON.stringify(spawned.body));
  const id = spawned.body.id;
  await ctx.waitFor(async () => (await ctx.session(id))?.status === "idle", "worker never settled");
  const session = await ctx.session(id);
  return { ...spawned.body, sessionDir: join(ctx.dataDir, "sessions", id), worktree: session.worktree };
}

test("an active session is auto-resumed on restart and keeps provider, model and thinking", posix, async () => {
  await fixture(async (ctx) => {
    await ctx.start();
    const worker = await spawnSettled(ctx, { provider: "woaichifan", model: "deepseek-v4.1-flash", thinking: "low" });
    const before = (await ctx.starts()).filter((start) => start.session === worker.id);
    assert.equal(before.length, 1);

    await ctx.crash();
    // The daemon died without stopping anything: the persisted state still says
    // the worker was active, and its transcript/worktree/credential survived.
    const crashed = (await ctx.stateFile()).history.find((entry) => entry.id === worker.id);
    assert.ok(["starting", "idle", "working"].includes(crashed.status), `unexpected status ${crashed.status}`);
    assert.equal(crashed.shutdownUnconfirmed, true, "a running worker leaves its shutdown unconfirmed");

    await ctx.start();
    await ctx.waitFor(async () => (await ctx.session(worker.id))?.status === "idle", "the session was not auto-resumed");

    const after = (await ctx.starts()).filter((start) => start.session === worker.id);
    assert.equal(after.length, 2, "the resumed worker must start exactly one new pi process");
    const resumed = after.at(-1);
    assert.equal(resumed.args[resumed.args.indexOf("--session") + 1],
      join(worker.sessionDir, "2026-01-01T00-00-00-000Z_01fake.jsonl"),
      "recovery must continue the existing transcript");
    assert.equal(resumed.args[resumed.args.indexOf("--session-dir") + 1], worker.sessionDir);
    assert.equal(resumed.args[resumed.args.indexOf("--provider") + 1], "woaichifan");
    assert.equal(resumed.args[resumed.args.indexOf("--model") + 1], "deepseek-v4.1-flash");
    assert.equal(resumed.args[resumed.args.indexOf("--thinking") + 1], "low", "recovery must not escalate thinking");
    assert.equal(resumed.cwd, realpathSync(worker.worktree), "recovery must resume in the same worktree");
    assert.deepEqual((await readdir(worker.sessionDir)).filter((name) => name.endsWith(".jsonl")),
      ["2026-01-01T00-00-00-000Z_01fake.jsonl"], "recovery must not fork a second transcript");

    // The resumed worker is a normal worker again: its recorded scope is held.
    const session = await ctx.session(worker.id);
    assert.equal(session.provider, "woaichifan");
    assert.equal(session.model, "deepseek-v4.1-flash");
    assert.equal(session.thinking, "low");
    assert.equal(session.outcome, undefined, "a resumed worker is still an open workstream");
    assert.equal(session.handoff, undefined);
    assert.ok((await ctx.get("/internal/locks")).locks.some((lock) => lock.sessionId === worker.id));
  });
});

test("stopped and finished sessions are never auto-resumed", posix, async () => {
  await fixture(async (ctx) => {
    await ctx.start();
    const stopped = await spawnSettled(ctx);
    const stoppedResult = await ctx.mcp("pi_stop", {
      session_id: stopped.id, control_key: stopped.control_key, preserve_worktree: true,
    });
    assert.equal(stoppedResult.isError, false, JSON.stringify(stoppedResult.body));

    const finished = await spawnSettled(ctx);
    const finishedResult = await ctx.mcp("pi_finish", {
      session_id: finished.id, control_key: finished.control_key, outcome: "abandoned", note: "not needed",
    });
    assert.equal(finishedResult.isError, false, JSON.stringify(finishedResult.body));

    const startsBefore = (await ctx.starts()).length;
    // Let the debounced state write land: the crash must not be the reason these
    // sessions "look" active on disk.
    await pause(800);
    await ctx.crash();
    const state = await ctx.stateFile();
    assert.equal(state.history.find((entry) => entry.id === stopped.id).status, "stopped");
    assert.equal(state.history.find((entry) => entry.id === finished.id).outcome, "abandoned");

    await ctx.start();
    // Give the recovery pass plenty of time to (wrongly) start something.
    await pause(1500);
    const startsAfter = await ctx.starts();
    assert.equal(startsAfter.length, startsBefore, "no worker may be started for stopped/finished sessions");
    assert.equal(startsAfter.some((start) => start.args.includes("--session")), false);

    const stoppedAfter = await ctx.get(`/internal/status?sessionId=${stopped.id}`);
    const finishedAfter = await ctx.get(`/internal/status?sessionId=${finished.id}`);
    assert.equal(stoppedAfter.status, "stopped");
    assert.equal(stoppedAfter.handoff, undefined, "a normally stopped session needs no handoff");
    assert.equal(finishedAfter.outcome, "abandoned");
    assert.equal((await ctx.get("/internal/drain")).active, 0);
  });
});

test("recovery stops a proven survivor worker group before resuming", posix, async () => {
  await fixture(async (ctx) => {
    await ctx.start();
    const worker = await spawnSettled(ctx);
    const survivor = (await ctx.starts()).at(-1);
    await ctx.crash();
    assert.equal(alive(survivor.pid), true, "the fake worker must outlive the daemon for this test");

    await ctx.start();
    await ctx.waitFor(async () => (await ctx.session(worker.id))?.status === "idle", "the session was not auto-resumed");
    await ctx.waitFor(async () => !alive(survivor.pid), "the owned survivor group was not stopped");

    const resumed = (await ctx.starts()).filter((start) => start.session === worker.id).at(-1);
    assert.equal(resumed.args[resumed.args.indexOf("--session") + 1],
      join(worker.sessionDir, "2026-01-01T00-00-00-000Z_01fake.jsonl"));
    assert.notEqual(resumed.pid, survivor.pid);
  }, { keepalive: true });
});

test("unproven old-worker ownership fails closed with a handoff and no resume", posix, async () => {
  await fixture(async (ctx) => {
    await ctx.start();
    const worker = await spawnSettled(ctx);
    const survivor = (await ctx.starts()).at(-1);
    await ctx.crash();
    assert.equal(alive(survivor.pid), true);

    // Rewrite the ownership proof so the new daemon can prove neither that the old
    // group is gone nor that it is still the worker this session owns.
    const state = await ctx.stateFile();
    const entry = state.history.find((item) => item.id === worker.id);
    entry.workerProcess = { ...entry.workerProcess, started: "not the recorded start time" };
    await writeFile(join(ctx.dataDir, "state.json"), JSON.stringify(state));

    await ctx.start();
    const session = await ctx.waitFor(async () => {
      const found = await ctx.session(worker.id);
      return found?.status === "error" ? found : undefined;
    }, "the session was not marked error");
    await pause(500);

    assert.equal(session.handoff.kind, "shutdown_failed");
    assert.equal(session.handoff.safeToTakeOver, false);
    assert.equal((await ctx.starts()).filter((start) => start.args.includes("--session")).length, 0,
      "an unproven survivor must never be followed by a second worker");
    assert.equal(alive(survivor.pid), true, "an unrelated process group must not be killed");
  }, { keepalive: true });
});
