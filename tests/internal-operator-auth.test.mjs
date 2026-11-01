import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * A daemon without PI_COFFEE_TOKEN has no credential that can ever satisfy the
 * "protected sessions exist" rule. Once one spawn happened, that rule used to
 * lock the operator endpoints (/internal/drain, /internal/shutdown) out for good,
 * which broke `npm run upgrade` and HTTP graceful shutdown on the default
 * deployment. A loopback caller is the operator there; worker tokens never are.
 */
const posix = { skip: process.platform === "win32" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_PI = `const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
fs.mkdirSync(sessionDir, { recursive: true });
fs.appendFileSync(path.join(sessionDir, "2026-01-01T00-00-00-000Z_01fake.jsonl"),
  JSON.stringify({ type: "session", cwd: process.cwd() }) + "\\n");
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

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-opauth-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.test"]);
  await writeFile(join(repo, "base"), "base");
  execFileSync("git", ["-C", repo, "add", "base"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  const fake = join(root, "fake-pi.js");
  await writeFile(fake, FAKE_PI);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PI_COFFEE_")) delete env[key];
  Object.assign(env, {
    PI_COFFEE_HOST: "127.0.0.1",
    PI_COFFEE_PORT: String(port),
    PI_COFFEE_DATA_DIR: join(root, "data"),
    PI_COFFEE_WORKSPACE_ROOT: join(root, "workers"),
    PI_COFFEE_DEFAULT_REPO: repo,
    PI_COFFEE_PI_BIN: fake,
    PI_COFFEE_AUTO_CLEAN: "0",
    PI_CODING_AGENT_DIR: join(root, "pi-agent"),
  });
  const proc = spawn(process.execPath, ["dist/index.js"], { env, stdio: "ignore" });
  const closed = new Promise((resolve) => proc.once("close", (code, signal) => resolve({ code, signal })));

  const ctx = {
    base,
    /** No token configured: this daemon authenticates nothing. */
    async post(path, body) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      return { status: response.status, body: await response.json().catch(() => undefined) };
    },
    async get(path) {
      const response = await fetch(`${base}${path}`);
      return { status: response.status, body: await response.json().catch(() => undefined) };
    },
    async mcp(name, args) {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      assert.equal(response.status, 200);
      const data = await response.json();
      const text = data.result?.content?.[0]?.text ?? "";
      try { return JSON.parse(text); } catch { return { error: text }; }
    },
  };

  try {
    let ready = false;
    for (let i = 0; i < 250 && !ready; i += 1) {
      try { ready = (await fetch(`${base}/internal/health`)).ok; } catch { /* still starting */ }
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

test("a tokenless daemon still lets the local operator drain, poll and cancel", posix, async () => {
  await fixture(async (ctx) => {
    // No worker yet: the endpoint is open even under the protected-session rule.
    assert.equal((await ctx.get("/internal/drain?action=status")).status, 200);

    const spawned = await ctx.mcp("pi_spawn", {
      task: "operator-auth",
      prompt: "do the work",
      spec: { goal: "write src/out.txt", scope: ["src"], purpose: "implementation" },
    });
    const sid = spawned.id ?? spawned.session_id;
    assert.ok(sid, JSON.stringify(spawned).slice(0, 400));

    // The session now carries a control key, so `hasProtectedSessions()` is true.
    const sent = await ctx.post("/internal/send", { to: sid, text: "hello" });
    assert.equal(sent.status, 401, "other mutating endpoints keep the protected-session rule");

    const status = await ctx.get("/internal/drain?action=status");
    assert.equal(status.status, 200, "GET drain status must stay reachable for operators");
    assert.equal(status.body.draining, false);

    const started = await ctx.post("/internal/drain", { action: "start", reason: "test" });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.draining, true);

    const rejected = await ctx.mcp("pi_spawn", {
      task: "drain-reject",
      prompt: "do the work",
      spec: { goal: "write src/out2.txt", scope: ["src"], purpose: "implementation" },
    });
    assert.match(JSON.stringify(rejected), /draining/i);

    const cancelled = await ctx.post("/internal/drain", { action: "cancel" });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.draining, false);
  });
});

test("a GET cannot trigger the operator endpoints even without a token", posix, async () => {
  await fixture(async (ctx) => {
    const response = await fetch(`${ctx.base}/internal/shutdown`);
    assert.equal(response.status, 405);
    const started = await fetch(`${ctx.base}/internal/drain?action=start`);
    assert.equal(started.status, 405);
  });
});
