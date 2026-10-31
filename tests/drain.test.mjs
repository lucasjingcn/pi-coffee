import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Drain mode against the real daemon and an offline fake pi: it must refuse new
 * work, keep reporting an accurate active count, and be trivially reversible.
 * The last test covers the graceful stop scripts/upgrade.mjs relies on.
 */
const posix = { skip: process.platform === "win32" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_PI = `const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
const continued = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.mkdirSync(sessionDir, { recursive: true });
const transcript = continued ?? path.join(sessionDir, "2026-01-01T00-00-00-000Z_01fake.jsonl");
fs.appendFileSync(transcript, JSON.stringify({ type: "session", cwd: process.cwd(), continued: Boolean(continued) }) + "\\n");
if (process.env.FAKE_TOKEN_FILE) fs.appendFileSync(process.env.FAKE_TOKEN_FILE, JSON.stringify({ session: process.env.PI_COORD_SESSION_ID, token: process.env.PI_COORD_TOKEN }) + "\\n");
process.stdout.on("error", () => {});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  const data = cmd.type === "get_state" ? { isStreaming: false } : {};
  process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, success: true, data }) + "\\n");
  if (cmd.type === "prompt") process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
});`;

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

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-drain-"));
  const repo = await makeRepo(root);
  const fake = join(root, "fake-pi.js");
  await writeFile(fake, FAKE_PI);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-pi-coord-token": "master-for-test" };
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PI_COFFEE_")) delete env[key];
  Object.assign(env, {
    PI_COFFEE_HOST: "127.0.0.1",
    PI_COFFEE_PORT: String(port),
    PI_COFFEE_DATA_DIR: join(root, "data"),
    PI_COFFEE_WORKSPACE_ROOT: join(root, "workers"),
    PI_COFFEE_DEFAULT_REPO: repo,
    PI_COFFEE_PI_BIN: fake,
    PI_COFFEE_TOKEN: "master-for-test",
    PI_COFFEE_AUTO_CLEAN: "0",
    FAKE_TOKEN_FILE: join(root, "tokens.jsonl"),
    PI_CODING_AGENT_DIR: join(root, "pi-agent"),
  });

  const proc = spawn(process.execPath, ["dist/index.js"], { env, stdio: "ignore" });
  const closed = new Promise((resolve) => proc.once("close", (code, signal) => resolve({ code, signal })));

  const tokenFile = join(root, "tokens.jsonl");
  const ctx = {
    base,
    headers,
    proc,
    closed,
    /** The worker token the daemon handed to a fake pi child. */
    async workerToken(sessionId) {
      const text = await readFile(tokenFile, "utf8").catch(() => "");
      const line = text.trim().split("\n").filter(Boolean).map((raw) => JSON.parse(raw))
        .find((entry) => entry.session === sessionId);
      return line?.token;
    },
    async get(path, init) {
      const response = await fetch(`${base}${path}`, { headers, ...init });
      return { status: response.status, body: await response.json().catch(() => undefined) };
    },
    async drain(body) {
      return ctx.get("/internal/drain", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
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
    async waitFor(check, message, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await pause(50);
      }
      throw new Error(message);
    },
  };

  try {
    let ready = false;
    for (let i = 0; i < 250 && !ready; i += 1) {
      try { ready = (await fetch(`${base}/internal/health`, { headers })).ok; } catch { /* still starting */ }
      if (!ready) await pause(20);
    }
    assert.ok(ready, "daemon did not become healthy");
    await fn(ctx);
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function spawnArgs(extra = {}) {
  return {
    task: "drain-fixture",
    prompt: "do the work",
    spec: { goal: "write src/out.txt", scope: ["src"], purpose: "implementation" },
    ...extra,
  };
}

test("drain rejects new spawns, reports the active count and cancels cleanly", posix, async () => {
  await fixture(async (ctx) => {
    const idle = await ctx.drain({ action: "status" });
    assert.equal(idle.status, 200);
    assert.equal(idle.body.draining, false);
    assert.equal(idle.body.active, 0);

    const started = await ctx.drain({ action: "start", reason: "upgrade test" });
    assert.equal(started.status, 200);
    assert.equal(started.body.draining, true);
    assert.equal(started.body.active, 0);
    assert.equal(started.body.reason, "upgrade test");
    assert.equal(typeof started.body.startedAt, "number");

    // health and the MCP status view agree with the drain endpoint.
    const health = await ctx.get("/internal/health");
    assert.equal(health.body.draining, true);
    assert.equal(health.body.active, 0);
    const status = await ctx.mcp("pi_status", {});
    assert.equal(status.body.draining, true);
    assert.equal(status.body.drain.draining, true);

    const rejected = await ctx.mcp("pi_spawn", spawnArgs());
    assert.equal(rejected.isError, true);
    assert.match(rejected.body.error, /draining/);
    assert.match(rejected.body.error, /pi_drain action=cancel/);
    assert.equal((await ctx.get("/internal/sessions")).body.sessions.length, 0, "a rejected spawn creates no session");

    // cancel (or a fresh start) restores normal operation.
    const cancelled = await ctx.drain({ action: "cancel" });
    assert.equal(cancelled.body.draining, false);
    assert.equal((await ctx.get("/internal/health")).body.draining, false);

    const spawned = await ctx.mcp("pi_spawn", spawnArgs());
    assert.equal(spawned.isError, false, JSON.stringify(spawned.body));
    await ctx.waitFor(async () => (await ctx.get(`/internal/status?sessionId=${spawned.body.id}`)).body.status === "idle",
      "worker never settled");
  });
});

test("drain reports active workers and refuses to resume or stop them", posix, async () => {
  await fixture(async (ctx) => {
    const spawned = await ctx.mcp("pi_spawn", spawnArgs());
    assert.equal(spawned.isError, false, JSON.stringify(spawned.body));
    const id = spawned.body.id;
    await ctx.waitFor(async () => (await ctx.get(`/internal/status?sessionId=${id}`)).body.status === "idle", "worker never settled");

    const started = await ctx.drain({ action: "start" });
    assert.equal(started.body.draining, true);
    assert.equal(started.body.active, 1);
    assert.deepEqual(started.body.activeSessions, [id]);

    const stopped = await ctx.mcp("pi_stop", { session_id: id, control_key: spawned.body.control_key, preserve_worktree: true });
    assert.equal(stopped.isError, false, JSON.stringify(stopped.body));
    const zero = await ctx.waitFor(async () => {
      const view = (await ctx.get("/internal/drain")).body;
      return view.active === 0 ? view : undefined;
    }, "active count never reached zero");
    assert.equal(zero.draining, true, "reaching zero active workers must not cancel the drain");

    const rejected = await ctx.mcp("pi_resume", { session_id: id, control_key: spawned.body.control_key });
    assert.equal(rejected.isError, true);
    assert.match(rejected.body.error, /draining/);

    // The drain is not a shutdown: cancel brings the daemon back to normal.
    assert.equal((await ctx.drain({ action: "cancel" })).body.draining, false);
    const resumed = await ctx.mcp("pi_resume", { session_id: id, control_key: spawned.body.control_key });
    assert.equal(resumed.isError, false, JSON.stringify(resumed.body));
  });
});

test("a worker token cannot control draining or stop the daemon", posix, async () => {
  await fixture(async (ctx) => {
    const spawned = await ctx.mcp("pi_spawn", spawnArgs());
    assert.equal(spawned.isError, false, JSON.stringify(spawned.body));
    const token = await ctx.waitFor(() => ctx.workerToken(spawned.body.id), "the fake worker never started");
    assert.ok(token);

    const drain = await fetch(`${ctx.base}/internal/drain`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-coord-token": token },
      body: JSON.stringify({ action: "start" }),
    });
    assert.equal(drain.status, 403);
    assert.equal((await ctx.get("/internal/drain")).body.draining, false);

    const shutdown = await fetch(`${ctx.base}/internal/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-coord-token": token },
      body: "{}",
    });
    assert.equal(shutdown.status, 403);

    const stranger = await fetch(`${ctx.base}/internal/drain`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-coord-token": "not-a-known-token" },
      body: JSON.stringify({ action: "start" }),
    });
    assert.equal(stranger.status, 401);
    assert.equal((await ctx.get("/internal/drain")).body.draining, false);
  });
});

test("the graceful stop endpoint refuses while workers are active and stops with zero", posix, async () => {
  await fixture(async (ctx) => {
    const spawned = await ctx.mcp("pi_spawn", spawnArgs());
    assert.equal(spawned.isError, false, JSON.stringify(spawned.body));
    const id = spawned.body.id;
    await ctx.waitFor(async () => (await ctx.get(`/internal/status?sessionId=${id}`)).body.status === "idle", "worker never settled");

    const refused = await ctx.get("/internal/shutdown", { method: "POST", headers: { ...ctx.headers, "content-type": "application/json" }, body: "{}" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /active worker/);

    await ctx.drain({ action: "start" });
    await ctx.mcp("pi_stop", { session_id: id, control_key: spawned.body.control_key, preserve_worktree: true });
    await ctx.waitFor(async () => (await ctx.get("/internal/drain")).body.active === 0, "active count never reached zero");

    const stop = await ctx.get("/internal/shutdown", { method: "POST", headers: { ...ctx.headers, "content-type": "application/json" }, body: "{}" });
    assert.equal(stop.status, 200);
    assert.equal(stop.body.stopping, true);
    const exit = await Promise.race([ctx.closed, pause(5000).then(() => "timeout")]);
    assert.notEqual(exit, "timeout", "the daemon did not stop on request");
    assert.equal(exit.code, 0);
  });
});
