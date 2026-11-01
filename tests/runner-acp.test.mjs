import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";
import { validateReviewSpec } from "../dist/candidate-review.js";
import { AcpClient } from "../dist/runner-acp.js";

const FAKE_ACP = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const sessionId = "acp-session-1";
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.method === "initialize") return send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (frame.method === "session/new") return send({ jsonrpc: "2.0", id: frame.id, result: { sessionId } });
  if (frame.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "acp-output" } } } });
    setTimeout(() => send({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } }), 5);
    return;
  }
  if (frame.method === "session/cancel") return send({ jsonrpc: "2.0", id: frame.id, result: {} });
  if (frame.id !== undefined) return send({ jsonrpc: "2.0", id: frame.id, result: {} });
});
`;

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-acp-"));
  const repo = join(root, "repo");
  const fake = join(root, "fake-acp");
  await writeFile(fake, FAKE_ACP);
  await chmod(fake, 0o755);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await mkdir(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "src/item.txt"), "base");
  git(repo, "add", "src");
  git(repo, "commit", "-qm", "base");
  const config = loadConfig({
    dataDir: join(root, "data"), workspaceRoot: join(root, "workers"), defaultRepo: repo, autoClean: false,
  });
  const c = new Coordinator(config);
  await c.init();
  try {
    await fn({ c, repo, root, fake, config });
  } finally {
    await c.stopAll();
    await rm(root, { recursive: true, force: true });
  }
}

test("ACP runner completes spawn, prompt and stop with a transcript", () =>
  fixture(async ({ c, repo, fake }) => {
    const worker = await c.spawn({
      repo,
      spec: {
        goal: "acp roundtrip",
        scope: ["src/item.txt"],
        runner: { kind: "acp", command: [process.execPath, fake] },
      },
    });
    assert.equal(worker.runner?.kind, "acp");
    const rt = c.get(worker.id);
    assert.ok(rt.client instanceof AcpClient);
    assert.equal(rt.meta.status, "idle");
    assert.equal(rt.meta.lastText, "acp-output");
    const transcript = join(c.config.dataDir, "sessions", worker.id, "acp.jsonl");
    assert.ok(existsSync(transcript), "expected the ACP transcript");
    const frames = (await readFile(transcript, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(frames.some((frame) => frame.method === "initialize"));
    assert.ok(frames.some((frame) => frame.method === "session/prompt"));

    await c.send(worker.id, "second prompt");
    assert.equal(rt.meta.lastText, "acp-output");
    await c.stop(worker.id, { preserveWorktree: true });
    assert.equal(rt.client.hasExited, true);
  }));

test("ACP workers refuse resume instead of guessing a transcript", () =>
  fixture(async ({ c, repo, fake }) => {
    const worker = await c.spawn({
      repo,
      spec: { goal: "acp resume", scope: ["src/item.txt"], runner: { kind: "acp", command: [process.execPath, fake] } },
    });
    await c.stop(worker.id, { preserveWorktree: true });
    await assert.rejects(c.resume(worker.id), /ACP worker sessions cannot be resumed/);
  }));

test("ACP cannot run inside the docker sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-acp-sandbox-"));
  try {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await writeFile(join(repo, "file.txt"), "x");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
    const config = loadConfig({
      dataDir: join(root, "data"), workspaceRoot: join(root, "workers"), defaultRepo: repo, autoClean: false,
      sandbox: "docker", sandboxImage: "fake:test", dockerBin: join(root, "missing-docker"),
    });
    const c = new Coordinator(config);
    await c.init();
    try {
      await assert.rejects(
        c.spawn({ repo, spec: { goal: "acp sandbox", scope: ["file.txt"], runner: { kind: "acp", command: ["fake-agent"] } } }),
        /ACP workers are not supported with the docker sandbox/,
      );
    } finally {
      await c.stopAll();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner configuration and spec validation fail closed", () => {
  assert.throws(() => loadConfig({ runner: "acp", acpCommand: [] }), /PI_COFFEE_ACP_COMMAND|acpCommand/);
  const parsed = loadConfig({ runner: "acp", acpCommand: ["agent", "--stdio"] });
  assert.deepEqual(parsed.acpCommand, ["agent", "--stdio"]);
  assert.throws(() => validateReviewSpec({ validators: [], runner: { kind: "other" } }), /spec\.runner\.kind/);
  assert.throws(() => validateReviewSpec({ validators: [], runner: { kind: "acp", command: [] } }), /spec\.runner\.command/);
  assert.throws(() => validateReviewSpec({
    validators: [],
    runner: { kind: "acp", command: ["agent"], env: { API_KEY: "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2" } },
  }), /looks like a secret/);
});


const FAKE_ACP_PERMISSION = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const sessionId = "acp-permission";
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.method === "initialize") return send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (frame.method === "session/new") return send({ jsonrpc: "2.0", id: frame.id, result: { sessionId } });
  if (frame.method === "session/prompt") {
    rl.pendingPrompt = frame.id;
    send({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: { options: [{ optionId: "allow_once" }, { optionId: "deny_once" }] } });
    return;
  }
  if (frame.id === 900) {
    const choice = frame.result?.outcome?.optionId ?? "none";
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "selected:" + choice } } } });
    send({ jsonrpc: "2.0", id: rl.pendingPrompt, result: { stopReason: "end_turn" } });
    return;
  }
  if (frame.method === "session/cancel") return send({ jsonrpc: "2.0", id: frame.id, result: {} });
  if (frame.id !== undefined) return send({ jsonrpc: "2.0", id: frame.id, result: {} });
});
`;

const FAKE_ACP_MALFORMED = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame.method === "initialize") {
    process.stdout.write("this is not json\\n");
    return send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  }
  if (frame.method === "session/new") return send({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "malformed" } });
  if (frame.method === "session/prompt") return send({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } });
  if (frame.method === "session/cancel") return send({ jsonrpc: "2.0", id: frame.id, result: {} });
});
`;

test("ACP permission requests map to ui_request and resume on answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-acp-perm-"));
  const script = join(root, "fake-perm");
  await writeFile(script, FAKE_ACP_PERMISSION);
  await chmod(script, 0o755);
  const client = new AcpClient({ command: [process.execPath, script], cwd: root, transcriptPath: join(root, "perm.jsonl") });
  try {
    await client.start();
    const pending = client.prompt("needs permission");
    const request = await new Promise((resolve) => client.once("ui_request", resolve));
    assert.equal(request.method, "confirm");
    client.respondUi({ type: "extension_ui_response", id: request.id, confirmed: true });
    const result = await pending;
    assert.equal(result.success, true);
    const transcript = await readFile(join(root, "perm.jsonl"), "utf8");
    assert.match(transcript, /session\/request_permission/);
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP ignores malformed frames instead of failing the handshake", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-acp-malformed-"));
  const script = join(root, "fake-malformed");
  await writeFile(script, FAKE_ACP_MALFORMED);
  await chmod(script, 0o755);
  const client = new AcpClient({ command: [process.execPath, script], cwd: root, transcriptPath: join(root, "malformed.jsonl") });
  try {
    await client.start();
    const result = await client.prompt("hello");
    assert.equal(result.success, true);
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
});


test("ACP deny answers select a reject option instead of the first allow option", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-acp-deny-"));
  const script = join(root, "fake-perm");
  await writeFile(script, FAKE_ACP_PERMISSION);
  await chmod(script, 0o755);
  const transcriptPath = join(root, "deny.jsonl");
  const client = new AcpClient({ command: [process.execPath, script], cwd: root, transcriptPath });
  try {
    await client.start();
    const pending = client.prompt("needs permission");
    const request = await new Promise((resolve) => client.once("ui_request", resolve));
    client.respondUi({ type: "extension_ui_response", id: request.id, confirmed: false });
    await pending;
    const transcript = await readFile(transcriptPath, "utf8");
    assert.match(transcript, /"optionId":"deny_once"/);
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
});
