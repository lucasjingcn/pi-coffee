import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";
import { captureWorkerProcess } from "../dist/worker-process.js";

const posix = { skip: process.platform === "win32" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal pi RPC stand-in: creates/continues a transcript, records argv, answers get_state, settles prompts. */
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
  fs.appendFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify({ args, session: process.env.PI_COORD_SESSION_ID, cwd: process.cwd(), transcript }) + "\\n");
}
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

async function daemonFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-resume-"));
  const repo = await makeRepo(root);
  const fake = join(root, "fake-pi.js");
  await writeFile(fake, FAKE_PI);
  const argvFile = join(root, "argv.jsonl");
  const port = await freePort();
  const env = {
    ...process.env,
    PI_COFFEE_HOST: "127.0.0.1",
    PI_COFFEE_PORT: String(port),
    PI_COFFEE_DATA_DIR: join(root, "data"),
    PI_COFFEE_WORKSPACE_ROOT: join(root, "workers"),
    PI_COFFEE_DEFAULT_REPO: repo,
    PI_COFFEE_PI_BIN: fake,
    PI_COFFEE_TOKEN: "master-for-test",
    PI_COFFEE_AUTO_CLEAN: "0",
    FAKE_ARGV_FILE: argvFile,
  };
  const proc = spawn(process.execPath, ["dist/index.js"], { env, stdio: "ignore" });
  const closed = new Promise((resolve) => proc.once("close", resolve));
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-pi-coord-token": "master-for-test" };
  const mcp = async (name, args) => {
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
  };
  const internal = async (path) => (await (await fetch(`${base}/internal/${path}`, { headers })).json());
  const starts = async () => {
    try {
      return (await readFile(argvFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch { return []; }
  };
  try {
    let ready = false;
    for (let i = 0; i < 150 && !ready; i += 1) {
      try { ready = (await fetch(`${base}/internal/health`, { headers })).ok; } catch { /* still starting */ }
      if (!ready) await pause(20);
    }
    assert.ok(ready, "daemon did not become healthy");
    await fn({ mcp, internal, starts, root, repo });
  } finally {
    proc.kill("SIGTERM");
    const timer = setTimeout(() => proc.kill("SIGKILL"), 2000);
    await closed;
    clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
}

async function spawnSettled(ctx, scope = ["src"]) {
  const spawned = await ctx.mcp("pi_spawn", {
    task: "resume-fixture",
    prompt: "do the work",
    spec: { goal: "write src/out.txt", scope, purpose: "implementation" },
  });
  assert.equal(spawned.isError, false, JSON.stringify(spawned.body));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const found = (await ctx.internal("sessions")).sessions.find((session) => session.id === spawned.body.id);
    if (found?.status === "idle") return spawned.body;
    await pause(25);
  }
  throw new Error("worker never settled");
}

/** Spawn a worker, settle it, stop it, and hand back everything resume needs. */
async function stoppedWorker(ctx, scope) {
  const spawned = await spawnSettled(ctx, scope);
  const stopped = await ctx.mcp("pi_stop", { session_id: spawned.id, control_key: spawned.control_key, preserve_worktree: true });
  assert.equal(stopped.isError, false, JSON.stringify(stopped.body));
  const sessionDir = join(ctx.root, "data", "sessions", spawned.id);
  return { ...spawned, sessionDir, transcripts: (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")) };
}

test("pi_resume continues the stopped worker's own transcript and keeps its control key", posix, async () => {
  await daemonFixture(async (ctx) => {
    const worker = await stoppedWorker(ctx, ["src"]);
    const first = (await ctx.starts()).at(-1);
    assert.ok(!first.args.includes("--session"), "a fresh spawn must not continue an existing transcript");
    assert.equal(first.session, worker.id);

    const resumed = await ctx.mcp("pi_resume", { session_id: worker.id, control_key: worker.control_key });
    assert.equal(resumed.isError, false, JSON.stringify(resumed.body));
    assert.equal(resumed.body.id, worker.id);
    assert.equal(resumed.body.status, "idle");
    assert.equal(resumed.body.control_required, true);

    const last = (await ctx.starts()).at(-1);
    assert.equal(last.args[last.args.indexOf("--session") + 1], join(worker.sessionDir, worker.transcripts[0]));
    assert.equal(last.args[last.args.indexOf("--session-dir") + 1], worker.sessionDir);
    assert.equal(last.session, worker.id, "the resumed worker must keep its coordinator session id");
    assert.ok(last.cwd.endsWith(`/workers/${worker.id}`), `unexpected cwd: ${last.cwd}`);

    // The transcript is continued, not duplicated, and the declared scope is held again.
    assert.deepEqual((await readdir(worker.sessionDir)).filter((name) => name.endsWith(".jsonl")), worker.transcripts);
    assert.ok((await ctx.internal("locks")).locks.some((lock) => lock.sessionId === worker.id));

    // The original control key still authorizes writes to the resumed session.
    const sent = await ctx.mcp("pi_send", { session_id: worker.id, control_key: worker.control_key, message: "state your progress" });
    assert.equal(sent.isError, false, JSON.stringify(sent.body));
  });
});

test("pi_resume refuses what it cannot prove instead of guessing", posix, async () => {
  await daemonFixture(async (ctx) => {
    const unknown = await ctx.mcp("pi_resume", { session_id: "s999" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.body.error, /unknown session/);

    const live = await spawnSettled(ctx, ["live"]);
    const running = await ctx.mcp("pi_resume", { session_id: live.id, control_key: live.control_key });
    assert.equal(running.isError, true);
    assert.match(running.body.error, /stop it before resuming/);

    const finished = await stoppedWorker(ctx, ["closed"]);
    const closed = await ctx.mcp("pi_stop", { session_id: finished.id, control_key: finished.control_key, outcome: "abandoned", preserve_worktree: true });
    assert.equal(closed.isError, false, JSON.stringify(closed.body));
    const finishedResume = await ctx.mcp("pi_resume", { session_id: finished.id, control_key: finished.control_key });
    assert.equal(finishedResume.isError, true);
    assert.match(finishedResume.body.error, /is finished/);

    const noTranscript = await stoppedWorker(ctx, ["no-transcript"]);
    await rm(join(noTranscript.sessionDir, noTranscript.transcripts[0]));
    const missing = await ctx.mcp("pi_resume", { session_id: noTranscript.id, control_key: noTranscript.control_key });
    assert.equal(missing.isError, true);
    assert.match(missing.body.error, /has no transcript/);

    const ambiguous = await stoppedWorker(ctx, ["ambiguous"]);
    await writeFile(join(ambiguous.sessionDir, "2026-01-01T00-00-00-000Z_01fork.jsonl"), "{}\n");
    const ambiguousResume = await ctx.mcp("pi_resume", { session_id: ambiguous.id, control_key: ambiguous.control_key });
    assert.equal(ambiguousResume.isError, true);
    assert.match(ambiguousResume.body.error, /resume is ambiguous/);

    const noAgent = await stoppedWorker(ctx, ["no-agent"]);
    await rm(join(noAgent.sessionDir, "agent"), { recursive: true, force: true });
    const agentResume = await ctx.mcp("pi_resume", { session_id: noAgent.id, control_key: noAgent.control_key });
    assert.equal(agentResume.isError, true);
    assert.match(agentResume.body.error, /agent directory/);

    const noWorktree = await stoppedWorker(ctx, ["no-worktree"]);
    const worktree = (await ctx.internal("sessions")).sessions.find((session) => session.id === noWorktree.id)?.worktree;
    await rm(worktree, { recursive: true, force: true });
    const worktreeResume = await ctx.mcp("pi_resume", { session_id: noWorktree.id, control_key: noWorktree.control_key });
    assert.equal(worktreeResume.isError, true);
    assert.match(worktreeResume.body.error, /lost its worktree/);

    // A live worker that took over the stopped worker's scope wins: never two writers.
    const contested = await stoppedWorker(ctx, ["contested"]);
    await spawnSettled(ctx, ["contested"]);
    const conflicting = await ctx.mcp("pi_resume", { session_id: contested.id, control_key: contested.control_key });
    assert.equal(conflicting.isError, true);
    assert.match(conflicting.body.error, /scope conflicts with active sessions/);
  });
});

async function coordinatorFixture(fn, { shutdownUnconfirmed = false, credentialed = true, workerProcess, reclaimed = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-resume-state-"));
  const repo = await makeRepo(root);
  const fake = join(root, "fake-pi.js");
  await writeFile(fake, FAKE_PI);
  const dataDir = join(root, "data");
  const worktree = join(root, "worktree");
  await mkdir(worktree, { recursive: true });
  const sessionDir = join(dataDir, "sessions", "s1");
  await mkdir(join(sessionDir, "agent"), { recursive: true });
  await writeFile(join(sessionDir, "2026-01-01T00-00-00-000Z_01abc.jsonl"), '{"type":"session"}\n');
  if (credentialed) {
    await mkdir(join(dataDir, "control-credentials"), { recursive: true, mode: 0o700 });
    await writeFile(join(dataDir, "control-credentials", "s1.json"), JSON.stringify({ controlKey: "k".repeat(43), scopeKey: "scope-of-chat" }), { mode: 0o600 });
  }
  const sha = (char) => char.repeat(40);
  const meta = {
    id: "s1", name: "resumable", status: shutdownUnconfirmed ? "working" : "stopped", createdAt: 1, lastActivity: 1,
    repo, worktree, branch: "pi/s1", cwd: worktree, baseRef: "HEAD", pendingQuestions: [], lastText: "half a review",
    spec: { goal: "finish the review", scope: ["src"], purpose: "review" },
    acceptance: { files: [], command: "true" },
    // Stale proof from the run that stopped: resume must not inherit any of it.
    verification: {
      id: "v1", epoch: "e1", workerSha: sha("a"), targetSha: sha("b"), candidateTree: sha("c"), targetBranch: "main",
      command: "true", verifiedAt: 1, passed: true, codeChanged: false, changedFiles: [],
      existingValidationChanges: [], reviewContractHash: "d".repeat(64),
      result: { code: 0, stdout: "", stderr: "", timedOut: false },
    },
    integration: {
      workerSha: sha("a"), targetBranch: "main", previousTargetSha: sha("b"),
      mergedSha: sha("c"), candidateTree: sha("d"), integratedAt: 1,
    },
    reviewAcceptance: { acceptedAt: 1, workerSha: sha("a"), note: "stale" },
    workerProcess: workerProcess ?? { pid: 4242, platform: process.platform, started: "1" },
    ...(shutdownUnconfirmed ? { shutdownUnconfirmed: true } : {}),
    ...(reclaimed ? { reclaimed: { at: 1, credential: true, fields: ["spec"] } } : {}),
  };
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "state.json"), JSON.stringify({ counter: 1, history: [meta] }));
  const previousBin = process.env.PI_COFFEE_PI_BIN;
  const previousArgvFile = process.env.FAKE_ARGV_FILE;
  process.env.PI_COFFEE_PI_BIN = fake;
  process.env.FAKE_ARGV_FILE = join(root, "argv.jsonl");
  const coordinator = new Coordinator(loadConfig({ dataDir, workspaceRoot: join(root, "workers"), autoClean: false }));
  try {
    await coordinator.init();
    await fn(coordinator, { meta, sessionDir, worktree, repo, argvFile: process.env.FAKE_ARGV_FILE });
  } finally {
    await coordinator.stopAll().catch(() => {});
    if (previousBin === undefined) delete process.env.PI_COFFEE_PI_BIN;
    else process.env.PI_COFFEE_PI_BIN = previousBin;
    if (previousArgvFile === undefined) delete process.env.FAKE_ARGV_FILE;
    else process.env.FAKE_ARGV_FILE = previousArgvFile;
    await rm(root, { recursive: true, force: true });
  }
}

test("resume drops the proof of the previous run and keeps the same worker identity", posix, async () => {
  await coordinatorFixture(async (coordinator, { sessionDir, argvFile }) => {
    const before = coordinator.snapshot("s1");
    assert.ok(before.verification && before.integration && before.reviewAcceptance, "fixture must start with stale proof");

    const meta = await coordinator.resume("s1");
    assert.equal(meta.status, "idle");
    // Like a fresh spawn, ownership stays unconfirmed until the process exits, so a
    // daemon crash from here on fails closed instead of adopting this worker.
    assert.equal(meta.shutdownUnconfirmed, true);
    assert.equal(meta.verification, undefined, "a resumed worker must not inherit an earlier verification");
    assert.equal(meta.integration, undefined);
    assert.equal(meta.reviewAcceptance, undefined);
    assert.equal(meta.handoff, undefined);
    assert.notEqual(meta.workerProcess?.pid, 4242, "the stale pid must never stay kill-authority");
    assert.equal(meta.branch, "pi/s1");

    // The spec's scope is reclaimed, the transcript is continued, and nothing else is.
    assert.ok(coordinator.locksList().some((lock) => lock.sessionId === "s1"));
    const starts = (await readFile(argvFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(starts.at(-1).args[starts.at(-1).args.indexOf("--session") + 1], join(sessionDir, "2026-01-01T00-00-00-000Z_01abc.jsonl"));

    // Reclamation paths read history too and must not remove a worktree that is live again.
    await coordinator.gc(["s1"]).catch(() => {});
    assert.equal(coordinator.snapshot("s1").status, "idle");

    await coordinator.stop("s1");
    assert.equal(coordinator.snapshot("s1").status, "stopped");
    assert.equal(coordinator.snapshot("s1").shutdownUnconfirmed, false);
  });
});

test("resume refuses an unconfirmed shutdown and a missing control credential", posix, async () => {
  // A live process owned by this session, with an identity that does not match it:
  // the daemon cannot prove the old worker is gone, so it must not start a second one.
  const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const exited = once(proc, "exit");
  try {
    const identity = { ...(await captureWorkerProcess(proc.pid)), started: "wrong fingerprint" };
    await coordinatorFixture(async (coordinator) => {
      await assert.rejects(coordinator.resume("s1"), /unconfirmed|only a stopped worker|ownership/);
    }, { shutdownUnconfirmed: true, workerProcess: identity });
  } finally {
    process.kill(-proc.pid, "SIGKILL");
    await exited;
  }

  await coordinatorFixture(async (coordinator) => {
    await assert.rejects(coordinator.resume("s1"), /no stored control credential/);
  }, { credentialed: false });
});

test("a resumed worker keeps its full lifecycle: commit, verify, merge, finish", posix, async () => {
  await daemonFixture(async (ctx) => {
    const spawned = await ctx.mcp("pi_spawn", {
      task: "resume-lifecycle",
      prompt: "do the work",
      spec: { goal: "write src/out.txt", scope: ["src"], purpose: "implementation" },
      acceptance_command: "test -f src/out.txt",
    });
    assert.equal(spawned.isError, false, JSON.stringify(spawned.body));
    const id = spawned.body.id;
    const control = spawned.body.control_key;

    const settle = async () => {
      for (let i = 0; i < 200; i += 1) {
        const found = (await ctx.internal("sessions")).sessions.find((s) => s.id === id);
        if (found?.status === "idle") return found;
        await pause(25);
      }
      throw new Error("worker never settled");
    };
    await settle();

    const stopped = await ctx.mcp("pi_stop", { session_id: id, control_key: control, preserve_worktree: true });
    assert.equal(stopped.isError, false, JSON.stringify(stopped.body));

    const resumed = await ctx.mcp("pi_resume", { session_id: id, control_key: control });
    assert.equal(resumed.isError, false, JSON.stringify(resumed.body));
    await settle();

    // The resumed worker is a normal worker again: its scope is writable and its
    // branch can be committed, verified, merged and finished.
    const worktree = (await ctx.internal("sessions")).sessions.find((s) => s.id === id).worktree;
    await writeFile(join(worktree, "src", "out.txt"), "resumed\n").catch(async (error) => {
      if (error.code !== "ENOENT") throw error;
      await mkdir(join(worktree, "src"), { recursive: true });
      await writeFile(join(worktree, "src", "out.txt"), "resumed\n");
    });

    const committed = await ctx.mcp("pi_commit", { session_id: id, control_key: control, message: "resumed work" });
    assert.equal(committed.isError, false, JSON.stringify(committed.body));

    const verified = await ctx.mcp("pi_verify", { session_id: id, control_key: control });
    assert.equal(verified.isError, false, JSON.stringify(verified.body));

    const merged = await ctx.mcp("pi_merge", { session_id: id, control_key: control });
    assert.equal(merged.isError, false, JSON.stringify(merged.body));

    const finished = await ctx.mcp("pi_finish", { session_id: id, control_key: control, outcome: "success_first" });
    assert.equal(finished.isError, false, JSON.stringify(finished.body));
    assert.equal((await ctx.internal("sessions")).sessions.find((s) => s.id === id).outcome, "success_first");
  });
});

test("resume keeps the worker's own model, provider and thinking level", posix, async () => {
  await daemonFixture(async (ctx) => {
    const spawned = await ctx.mcp("pi_spawn", {
      task: "resume-levels",
      repo: ctx.repo,
      provider: "woaichifan",
      model: "deepseek-v4.1-flash",
      thinking: "low",
      prompt: "do the work",
      spec: { goal: "write src/out.txt", scope: ["src"], purpose: "implementation" },
    });
    assert.equal(spawned.isError, false, JSON.stringify(spawned.body));
    const id = spawned.body.id;
    const control = spawned.body.control_key;
    await ctx.mcp("pi_stop", { session_id: id, control_key: control, preserve_worktree: true });

    const resumed = await ctx.mcp("pi_resume", { session_id: id, control_key: control });
    assert.equal(resumed.isError, false, JSON.stringify(resumed.body));
    const argued = (await ctx.starts()).at(-1).args;
    // The daemon default is xhigh; a resumed worker must not silently get more
    // thinking (and cost) than the session it continues.
    assert.equal(argued[argued.indexOf("--thinking") + 1], "low");
    assert.equal(argued[argued.indexOf("--model") + 1], "deepseek-v4.1-flash");
    assert.equal(argued[argued.indexOf("--provider") + 1], "woaichifan");

    // An explicit override still wins.
    await ctx.mcp("pi_stop", { session_id: id, control_key: control, preserve_worktree: true });
    const overridden = await ctx.mcp("pi_resume", { session_id: id, control_key: control, thinking: "high" });
    assert.equal(overridden.isError, false, JSON.stringify(overridden.body));
    const lastArgs = (await ctx.starts()).at(-1).args;
    assert.equal(lastArgs[lastArgs.indexOf("--thinking") + 1], "high");
  });
});

test("resume refuses a session whose evidence was already reclaimed", posix, async () => {
  await coordinatorFixture(async (coordinator) => {
    await assert.rejects(coordinator.resume("s1"), /evidence reclaimed/);
  }, { reclaimed: true });
});

test("pi_gc through MCP reclaims a dead session and the full view explains it", posix, async () => {
  await daemonFixture(async (ctx) => {
    const worker = await stoppedWorker(ctx, ["reclaim-view"]);
    const worktree = (await ctx.internal("sessions")).sessions.find((s) => s.id === worker.id).worktree;
    await rm(worktree, { recursive: true, force: true });
    await rm(worker.sessionDir, { recursive: true, force: true });

    const gc = await ctx.mcp("pi_gc", { session_ids: [worker.id], control_keys: { [worker.id]: worker.control_key } });
    assert.equal(gc.isError, false, JSON.stringify(gc.body));
    assert.equal(gc.body.credentials_reclaimed, 1);
    assert.equal(gc.body.history_compacted, 1);

    const status = await ctx.mcp("pi_status", { session_id: worker.id, detail: "full" });
    assert.equal(status.isError, false, JSON.stringify(status.body));
    assert.equal(status.body.status, "stopped");
    assert.equal(status.body.reclaimed.credential, true, "the full view must say why evidence is missing");
  });
});
