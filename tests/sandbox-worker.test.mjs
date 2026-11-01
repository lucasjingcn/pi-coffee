import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";
import { PiRpcClient } from "../dist/rpc-client.js";
import { resolveRepoIdentity } from "../dist/lock-repo.js";
import {
  WORKER_EXTENSION,
  WORKER_SESSION_DIR,
  WORKER_WORKSPACE,
  buildWorkerDockerPrefix,
  workerContainerName,
} from "../dist/sandbox.js";

const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(argv) + "\\n");
if (argv[0] === "version") { console.log("26.1.0"); process.exit(0); }
if (argv[0] === "image" && argv[1] === "inspect") { console.log("sha256:" + "a".repeat(64)); process.exit(0); }
process.exit(0);
`;

test("worker docker prefix mounts the worker layout and no unrelated host paths", () => {
  const prefix = buildWorkerDockerPrefix({
    sessionId: "s42",
    // Missing on purpose: a worktree that is not there yet contributes no git mount.
    worktree: "/tmp/work",
    sessionDir: "/tmp/sessions/s42",
    extensionPath: "/repo/extensions/pi-coordinator.ts",
    image: "agent:latest",
    network: "bridge",
    envAllow: ["DEEPSEEK_API_KEY"],
    port: 8787,
    dockerBin: "docker",
    user: "1000:1000",
  });
  assert.equal(prefix.bin, "docker");
  const args = prefix.args;
  assert.equal(args[args.indexOf("--name") + 1], workerContainerName("s42"));
  assert.ok(args.includes(`${"/tmp/work"}:${WORKER_WORKSPACE}`));
  assert.ok(args.includes(`${"/tmp/sessions/s42"}:${WORKER_SESSION_DIR}`));
  assert.ok(args.includes(`${"/repo/extensions/pi-coordinator.ts"}:${WORKER_EXTENSION}:ro`));
  assert.equal(args[args.indexOf("-w") + 1], WORKER_WORKSPACE);
  assert.equal(args[args.indexOf("--network") + 1], "bridge");
  assert.ok(args.includes("PI_COORD_TOKEN"));
  assert.ok(args.includes("DEEPSEEK_API_KEY"));
  assert.ok(!args.some((arg) => arg.startsWith("PI_COORD_TOKEN=")), "token values must not appear in argv");
  assert.ok(args.includes("agent:latest"));
  assert.equal(args[args.length - 1], "pi");
  // An explicit user owns neither `/root` nor a HOME pointing into the image.
  assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
  assert.equal(args[args.indexOf("-e", args.indexOf("--user")) + 1], "HOME=/tmp");
  assert.equal(args.filter((arg) => arg.startsWith("HOME=")).length, 1);
  assert.deepEqual(args.filter((arg) => arg.includes(":") && arg.startsWith("/")), [
    `/tmp/work:${WORKER_WORKSPACE}`,
    `/tmp/sessions/s42:${WORKER_SESSION_DIR}`,
    `/repo/extensions/pi-coordinator.ts:${WORKER_EXTENSION}:ro`,
  ], "no git metadata mount without a real worktree");
});

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-worker-"));
  const repo = join(root, "repo");
  const dockerBin = join(root, "fake-docker");
  const dockerLog = join(root, "docker.log");
  await writeFile(dockerBin, FAKE_DOCKER);
  await chmod(dockerBin, 0o755);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await mkdir(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "src/item.txt"), "base");
  git(repo, "add", "src");
  git(repo, "commit", "-qm", "base");
  const config = loadConfig({
    dataDir: join(root, "data"), workspaceRoot: join(root, "workers"), defaultRepo: repo,
    autoClean: false, sandbox: "docker", sandboxImage: "agent:latest", dockerBin,
  });
  const c = new Coordinator(config);
  await c.init();
  process.env.FAKE_DOCKER_LOG = dockerLog;
  const original = {
    start: PiRpcClient.prototype.start,
    stop: PiRpcClient.prototype.stop,
    prompt: PiRpcClient.prototype.prompt,
    getState: PiRpcClient.prototype.getState,
  };
  PiRpcClient.prototype.start = async () => {};
  PiRpcClient.prototype.stop = async () => {};
  PiRpcClient.prototype.prompt = async function () { this.emit("event", { type: "agent_settled" }); return { success: true }; };
  PiRpcClient.prototype.getState = async () => ({ isStreaming: false });
  try {
    await fn({ c, repo, root, dockerLog, config });
  } finally {
    Object.assign(PiRpcClient.prototype, original);
    delete process.env.FAKE_DOCKER_LOG;
    await c.stopAll();
    await rm(root, { recursive: true, force: true });
  }
}

async function dockerCalls(log) {
  try {
    return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test("spawn builds a containerized worker and stop removes the container", () =>
  fixture(async ({ c, repo, dockerLog }) => {
    const worker = await c.spawn({ repo, spec: { goal: "containerized", scope: ["src/item.txt"] } });
    assert.equal(worker.sandbox?.kind, "docker");
    assert.equal(worker.sandbox?.image, "agent:latest");
    const client = c.get(worker.id).client;
    const prefix = client.opts.spawnPrefix;
    assert.ok(prefix, "expected a docker spawn prefix");
    assert.equal(prefix.bin, process.env.PI_COFFEE_DOCKER_BIN ?? c.config.dockerBin);
    assert.equal(prefix.args[prefix.args.indexOf("--name") + 1], workerContainerName(worker.id));
    assert.ok(prefix.args.includes(`${worker.worktree}:${WORKER_WORKSPACE}`));
    assert.ok(prefix.args.includes(`${join(c.config.dataDir, "sessions", worker.id)}:${WORKER_SESSION_DIR}`));
    assert.ok(prefix.args.includes(`${c.config.extensionPath}:${WORKER_EXTENSION}:ro`));
    // pi runs `git` inside the container; a linked worktree needs its metadata too.
    const gitDir = realpathSync(join(repo, ".git"));
    assert.ok(prefix.args.includes(`${gitDir}:${gitDir}`), `expected the git metadata mount in ${prefix.args.join(" ")}`);
    assert.equal(client.opts.sessionDir, WORKER_SESSION_DIR);
    assert.equal(client.opts.extensionPath, WORKER_EXTENSION);

    await c.stop(worker.id, { preserveWorktree: true });
    const calls = await dockerCalls(dockerLog);
    assert.ok(calls.some((argv) => argv[0] === "rm" && argv[1] === "-f" && argv[2] === workerContainerName(worker.id)));
  }));

test("a failed worker start also removes its container", () =>
  fixture(async ({ c, repo, dockerLog }) => {
    PiRpcClient.prototype.start = async () => { throw new Error("sandbox image is broken"); };
    await assert.rejects(
      c.spawn({ repo, spec: { goal: "will fail", scope: ["src/item.txt"] } }),
      /sandbox image is broken/,
    );
    const calls = await dockerCalls(dockerLog);
    assert.ok(calls.some((argv) => argv[0] === "rm" && argv[1] === "-f" && String(argv[2]).startsWith("pi-coffee-worker-")));
    // The failed session stays visible as an error record (unchanged behavior).
    assert.equal(c.list().length, 1);
    assert.equal(c.list()[0].status, "error");
  }));

test("stopping a sandboxed session removes its worker container", () =>
  fixture(async ({ c, root, dockerLog }) => {
    // A stopped, resumable session needs a transcript file and a worktree that still exists.
    const sessionId = "s99";
    const worktree = join(root, "worker-resume");
    execFileSync("git", ["-C", repoPath(root), "worktree", "add", "-q", "-b", "pi/resume", worktree]);
    const sessionDir = join(c.config.dataDir, "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    const transcript = join(sessionDir, "2026-01-01T00-00-00-000Z_test.jsonl");
    await writeFile(transcript, JSON.stringify({ type: "session", id: "x" }) + "\n");
    const meta = {
      id: sessionId, name: "resume fixture", repo: repoPath(root), worktree, cwd: worktree,
      branch: "pi/resume", baseRef: "HEAD", status: "stopped", createdAt: 1, lastActivity: 1,
      pendingQuestions: [], spec: { goal: "resume", scope: ["src/item.txt"] },
      sandbox: { kind: "docker", image: "agent:latest", network: "bridge" },
    };
    c.runtimes.set(sessionId, {
      meta,
      client: { stop: async () => {}, isStreaming: false, getState: async () => ({ isStreaming: false }) },
      repoIdentity: resolveRepoIdentity(repoPath(root)),
      lastNotifiedQuestionIds: new Set(),
    });
    // Nothing else to assert beyond the resume path building a container prefix;
    // this test focuses on stale-container cleanup happening first.
    const before = (await dockerCalls(dockerLog)).filter((argv) => argv[0] === "rm").length;
    await c.stop(sessionId, { preserveWorktree: true });
    const after = (await dockerCalls(dockerLog)).filter((argv) => argv[0] === "rm").length;
    assert.equal(after, before + 1);
  }));

function repoPath(root) {
  return join(root, "repo");
}
