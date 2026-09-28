#!/usr/bin/env node
/**
 * End-to-end smoke test for pi-mcp.
 *
 * Boots the daemon against a throwaway git repo and exercises the full control surface:
 * spec linter, task-type gate, scope overlap, acceptance test-first + lock, committed-diff,
 * two-strikes gate, adaptive model escalation, finish/report, and scoreboard persistence.
 *
 * In the default live mode the daemon drives real `pi` workers (a couple of tiny prompts).
 * With SMOKE_LIVE=0 the smoke is fully deterministic and credential-free: it installs a
 * disposable fake `pi` that speaks just enough JSONL RPC (state/stats/prompt/model) and never
 * touches installed pi or any model provider.
 *
 * The daemon is always started with an isolated environment (own host/port/data dir/worktree
 * root/no token) so inherited PI_MCP_* settings cannot leak into the test.
 *
 * Usage: node scripts/smoke.mjs           (or: npm run smoke / ./smoke.sh)
 */
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = process.env.SMOKE_PORT || String(8890 + Math.floor(Math.random() * 100));
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE = process.env.SMOKE_LIVE !== "0";
const WORK = mkdtempSync(join(tmpdir(), "pi-mcp-smoke-"));
const REPO = join(WORK, "repo");
const DATA = join(WORK, "data");
const WORKTREES = join(DATA, "worktrees");

let failures = 0;
let daemon = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ""}`);
  }
}

function git(args) {
  execFileSync("git", args, { cwd: REPO, stdio: "ignore" });
}

async function mcpCall(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await res.json();
  const r = j.result || {};
  const text = r.content?.[0]?.text ?? "";
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: !!r.isError, data };
}

/**
 * A disposable fake `pi --mode rpc` used by SMOKE_LIVE=0. It implements the small JSONL RPC
 * surface the daemon needs (get_state, get_session_stats, prompt/set_model/...), so the offline
 * smoke needs no installed `pi` and no model credentials.
 */
const FAKE_PI_SOURCE = String.raw`#!/usr/bin/env node
// Disposable fake pi for the offline pi-mcp smoke test. Speaks minimal JSONL RPC.
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
const provider = argValue("--provider") ?? "fake";
const model = argValue("--model") ?? "fake-model";
const name = argValue("--name") ?? "fake";
const sessionId = "fake-session";

let streaming = false;
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function respond(cmd, data) {
  send({ id: cmd.id, type: "response", command: cmd.type, success: true, data: data ?? {} });
}
function event(type, extra) {
  send({ type, ...(extra ?? {}) });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    return;
  }
  switch (cmd.type) {
    case "get_state":
      return respond(cmd, {
        isStreaming: streaming,
        sessionId,
        sessionName: name,
        model: { provider, id: model, name: model },
        messageCount: 0,
        pendingMessageCount: 0,
      });
    case "get_session_stats":
      return respond(cmd, {
        sessionId,
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        totalMessages: 2,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        cost: 0,
        contextUsage: { tokens: 15, contextWindow: 100000, percent: 0.015 },
      });
    case "get_last_assistant_text":
      return respond(cmd, { text: null });
    case "get_entries":
      return respond(cmd, { entries: [], leafId: null });
    case "clear_queue":
      return respond(cmd, { steering: [], followUp: [] });
    case "prompt":
    case "steer":
    case "follow_up": {
      respond(cmd, {});
      streaming = true;
      event("agent_start");
      setImmediate(() => {
        streaming = false;
        event("agent_settled");
      });
      return;
    }
    default:
      // set_session_name, set_model, abort, new_session, compact, bash, ...
      return respond(cmd, {});
  }
});
rl.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`;

function createFakePi() {
  const path = join(WORK, "fake-pi");
  writeFileSync(path, FAKE_PI_SOURCE, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function startDaemon(piBin) {
  // Isolate every inherited PI_MCP_* setting that could redirect the daemon or break the health
  // check (host bind, token auth, shared worktree root, auto-clean) and pin our own temp dirs.
  const env = {
    ...process.env,
    PI_MCP_HOST: "127.0.0.1",
    PI_MCP_PORT: PORT,
    PI_MCP_DEFAULT_REPO: REPO,
    PI_MCP_DATA_DIR: DATA,
    PI_MCP_WORKSPACE_ROOT: WORKTREES,
    PI_MCP_AUTO_CLEAN: "1",
    PI_MCP_PI_BIN: piBin,
  };
  delete env.PI_MCP_TOKEN;
  daemon = spawn(process.execPath, ["dist/index.js"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  daemon.stderr.on("data", (d) => process.env.SMOKE_VERBOSE && process.stderr.write(d));
}

async function waitHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/internal/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("daemon did not become healthy");
}

async function stopDaemon() {
  const proc = daemon;
  if (!proc) return;
  daemon = null;
  const exited = new Promise((res) => proc.once("exit", res));
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGTERM");
    await Promise.race([exited, sleep(6000)]);
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
    await Promise.race([exited, sleep(2000)]);
  }
}

async function main() {
  console.log(`pi-mcp smoke test (port ${PORT}, live=${LIVE})`);
  const piBin = LIVE ? process.env.PI_MCP_PI_BIN || "pi" : createFakePi();
  mkdirSync(REPO, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: REPO, stdio: "ignore" });
  git(["config", "user.email", "smoke@test"]);
  git(["config", "user.name", "smoke"]);
  execFileSync("bash", ["-c", "mkdir -p src && echo base > base.txt"], { cwd: REPO, stdio: "ignore" });
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  startDaemon(piBin);
  await waitHealth();

  // --- spec linter -------------------------------------------------------------------------
  let r = await mcpCall("pi_spawn", {});
  check("A  no spec/prompt is rejected", r.data?.error === "provide a task spec or a prompt", r.data);

  r = await mcpCall("pi_spawn", { spec: { goal: "", scope: [] } });
  check(
    "B  incomplete spec lists missing fields",
    Array.isArray(r.data?.missing) && r.data.missing.includes("goal") && r.data.missing.includes("scope"),
    r.data,
  );

  r = await mcpCall("pi_spawn", { spec: { goal: "g", scope: ["src/a.ts"], task_type: "design" } });
  check("C  task-type gate blocks design", r.isError && r.data?.rule === "no-delegate-judgment", r.data);

  // --- spec + acceptance test-first --------------------------------------------------------
  r = await mcpCall("pi_spawn", {
    task: "A",
    spec: { goal: "make the acceptance test pass", scope: ["src/a.ts"], task_type: "mechanical" },
    acceptance_files: [{ path: "tests/acc.txt", content: "PASS" }],
    acceptance_command: "cat tests/acc.txt",
  });
  const s1 = r.data;
  check("D1 structured spec spawn succeeds", !!s1?.id && s1?.spec?.goal === "make the acceptance test pass", s1);
  check("D2 acceptance file written into worktree", s1?.id && existsSync(join(WORKTREES, s1.id, "tests/acc.txt")));

  r = await mcpCall("pi_claim", { session_id: s1.id, paths: ["tests/acc.txt"], mode: "rw" });
  check("D3 acceptance test is locked against the worker", r.data?.ok === false && r.data?.conflicts?.[0]?.sessionId === "codex", r.data);

  // --- scope overlap -----------------------------------------------------------------------
  r = await mcpCall("pi_spawn", { task: "B", spec: { goal: "overlap", scope: ["src/a.ts"], task_type: "mechanical" } });
  check("E  overlapping scope rejected at dispatch", r.isError, r.data);

  r = await mcpCall("pi_spawn", { task: "C", spec: { goal: "Reply with exactly READY and stop; do not modify any files.", scope: ["src/other.ts"], task_type: "feature" } });
  const s3 = r.data;
  check("F  non-overlapping spawn succeeds", !!s3?.id, s3);
  check("F2 the spec became the first instruction (attempt 1)", s3?.instructions_sent === 1, s3?.instructions_sent);

  // --- committed diff visibility -----------------------------------------------------------
  await mcpCall("pi_exec", { session_id: s1.id, command: "printf y > y.txt && git add -A && git commit -qm y" });
  r = await mcpCall("pi_diff", { session_id: s1.id });
  check("G  pi_diff shows committed changes", (r.data?.files || []).includes("y.txt"), r.data?.files);

  // --- finish + report ---------------------------------------------------------------------
  await mcpCall("pi_finish", { session_id: s1.id, outcome: "success_first", tests_owned_by_codex: true });
  r = await mcpCall("pi_report", {});
  check("H  report counts the closed workstream", (r.data?.counts?.success_first || 0) >= 1, r.data?.counts);

  // --- live: adaptive escalation + two-strikes ---------------------------------------------
  if (LIVE) {
    await mcpCall("pi_wait", { session_ids: [s3.id], until: "settled", timeout_ms: 60000 });
    r = await mcpCall("pi_send", { session_id: s3.id, message: "Reply with exactly OK and stop." });
    check("L1  retry (attempt 2) auto-escalates the model", !!r.data?.escalated_to && r.data?.instructions_sent === 2, r.data);
    r = await mcpCall("pi_send", { session_id: s3.id, message: "third instruction" });
    check("L2  third instruction blocked (two-strikes)", r.isError && r.data?.rule === "two-strikes", r.data);
  } else {
    console.log("  SKIP  live model checks (SMOKE_LIVE=0)");
  }

  // --- persistence across restart ----------------------------------------------------------
  await mcpCall("pi_stop", { session_id: s1.id });
  check("J  finished worker's worktree auto-cleaned", !existsSync(join(WORKTREES, s1.id)), join(WORKTREES, s1.id));
  // Daemon state is saved on a short debounce; give it a beat before the restart so the archived
  // outcome is actually on disk (the daemon itself has no flush-on-shutdown guarantee).
  await sleep(800);
  await stopDaemon();
  startDaemon(piBin);
  await waitHealth();
  r = await mcpCall("pi_report", {});
  check(
    "I  scoreboard survives a daemon restart",
    (r.data?.counts?.success_first || 0) >= 1 && (r.data?.archived_tasks || 0) >= 1,
    r.data?.counts,
  );
}

main()
  .catch((e) => {
    failures++;
    console.error("smoke test error:", e);
  })
  .finally(async () => {
    await stopDaemon().catch(() => {});
    rmSync(WORK, { recursive: true, force: true });
    console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  });
