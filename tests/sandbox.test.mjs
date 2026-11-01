import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";
import { acceptanceHashes } from "../dist/integration.js";
import { resolveRepoIdentity } from "../dist/lock-repo.js";
import { evidenceDir, readEvidenceManifest } from "../dist/evidence.js";

const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require("fs");
const { spawnSync } = require("child_process");
const argv = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(argv) + "\\n");
if (argv[0] === "version") {
  if (process.env.FAKE_DOCKER_FAIL === "1") { console.error("cannot connect to the docker daemon"); process.exit(1); }
  console.log("26.1.0"); process.exit(0);
}
if (argv[0] === "image" && argv[1] === "inspect") { console.log("sha256:" + "a".repeat(64)); process.exit(0); }
if (argv[0] === "rm") { process.exit(0); }
if (argv[0] === "run") {
  const i = argv.indexOf("-v");
  const src = argv[i + 1].split(":")[0];
  const env = { ...process.env };
  for (let j = 0; j < argv.length; j += 1) {
    if (argv[j] !== "-e") continue;
    const spec = argv[j + 1];
    const eq = spec.indexOf("=");
    if (eq < 0) env[spec] = process.env[spec];
    else env[spec.slice(0, eq)] = spec.slice(eq + 1);
  }
  const bashIdx = argv.indexOf("bash");
  const cmd = argv[bashIdx + 2];
  const result = spawnSync("bash", ["-lc", cmd], { cwd: src, env, stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}
process.exit(0);
`;

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-"));
  const repo = join(root, "repo");
  const worker = join(root, "worker");
  const dockerBin = join(root, "fake-docker");
  const dockerLog = join(root, "docker.log");
  await writeFile(dockerBin, FAKE_DOCKER);
  await chmod(dockerBin, 0o755);
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await mkdir(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "src/item.txt"), "base");
  git(repo, "add", "src");
  git(repo, "commit", "-qm", "base");
  const baseRef = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "-q", "-b", "pi/test", worker, baseRef);
  await writeFile(join(worker, "src/item.txt"), "changed");
  git(worker, "add", "src/item.txt");
  git(worker, "commit", "-qm", "worker change");
  const config = loadConfig({
    dataDir: join(root, "data"),
    workspaceRoot: join(root, "workers"),
    defaultRepo: repo,
    // Container workers reach the daemon through the host gateway, so Linux
    // refuses a loopback-only listener; bind a reachable interface.
    host: "0.0.0.0",
    autoClean: false,
    sandbox: "docker",
    sandboxImage: "fake:test",
    sandboxEnvAllow: ["FAKE_PASSTHROUGH"],
    dockerBin,
  });
  const c = new Coordinator(config);
  await c.init();
  const meta = {
    id: "s1", name: "sandbox fixture", repo, worktree: worker, cwd: worker, branch: "pi/test",
    baseRef, status: "idle", createdAt: 1, lastActivity: 1, pendingQuestions: [],
    spec: { goal: "change item", scope: ["src/item.txt"] },
    acceptance: { files: [], hashes: {}, command: 'test "$(cat src/item.txt)" = changed' },
    sandbox: { kind: "docker", image: "fake:test", network: "bridge" },
  };
  c.runtimes.set("s1", {
    meta,
    client: { getState: async () => ({ isStreaming: false }), stop: async () => {}, isStreaming: false, refreshStreaming: async () => {} },
    repoIdentity: resolveRepoIdentity(repo),
    lastNotifiedQuestionIds: new Set(),
  });
  process.env.FAKE_DOCKER_LOG = dockerLog;
  try {
    await fn({ c, meta, repo, worker, root, dockerLog, dockerBin });
  } finally {
    delete process.env.FAKE_DOCKER_LOG;
    delete process.env.FAKE_DOCKER_FAIL;
    await c.stopAll();
    await rm(root, { recursive: true, force: true });
  }
}

async function dockerCalls(dockerLog) {
  try {
    const text = await readFile(dockerLog, "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test("verification commands run inside the docker sandbox and record the image", () =>
  fixture(async ({ c, meta, dockerLog, root }) => {
    process.env.FAKE_PASSTHROUGH = "yes";
    process.env.FAKE_SECRET_KEY = "should-not-be-forwarded";
    meta.spec.validators = [{ id: "tests", command: 'echo sandboxed; test "$(cat src/item.txt)" = changed' }];
    const proof = await c.verify("s1");
    delete process.env.FAKE_PASSTHROUGH;
    delete process.env.FAKE_SECRET_KEY;
    assert.equal(proof.passed, true);
    assert.equal(proof.validators[0].passed, true);
    const calls = await dockerCalls(dockerLog);
    const run = calls.find((argv) => argv[0] === "run");
    assert.ok(run, "expected a docker run call");
    assert.ok(run.indexOf("--network") >= 0);
    assert.equal(run[run.indexOf("--network") + 1], "bridge");
    const mount = run[run.indexOf("-v") + 1];
    assert.match(mount, /:\/workspace$/);
    assert.equal(run[run.indexOf("-w") + 1], "/workspace");
    assert.ok(run.includes("fake:test"));
    assert.ok(run.includes("FAKE_PASSTHROUGH"), "allowlisted names are forwarded by reference");
    // A git worktree keeps `.git` as a file pointing outside the worktree, so the
    // sandbox must also mount the git metadata at the path git recorded there.
    const gitDir = realpathSync(join(root, "repo", ".git"));
    assert.ok(run.includes(`${gitDir}:${gitDir}`), `expected the git metadata mount in ${run.join(" ")}`);
    assert.equal(run.includes("--user"), process.platform === "linux", "host user only where bind mounts keep real ownership");
    // Allowlisted host names are forwarded by reference (`-e NAME`), so no host
    // value may reach argv. The one value the sandbox writes itself is its own
    // writable HOME default, and only on Linux where `--user` applies.
    const hostValues = run.filter((arg) => arg.startsWith("FAKE_PASSTHROUGH=") || arg.startsWith("FAKE_SECRET_KEY="));
    assert.deepEqual(hostValues, [], "allowlisted values must not appear in docker argv");
    const homeValues = run.filter((arg) => arg.startsWith("HOME="));
    assert.deepEqual(
      homeValues,
      process.platform === "linux" ? ["HOME=/tmp"] : [],
      "only the sandbox's own writable HOME, never the host's HOME",
    );
    const manifest = await readEvidenceManifest(evidenceDir(c.config.dataDir, proof.evidence));
    assert.equal(manifest.sandbox.kind, "docker");
    assert.equal(manifest.sandbox.image, "fake:test");
    assert.match(manifest.sandbox.imageDigest, /^sha256:a{64}$/);
    assert.equal(manifest.sandbox.network, "bridge");
  }));

test("docker probe failure refuses the spawn without creating a worktree", () =>
  fixture(async ({ c, repo, dockerLog }) => {
    process.env.FAKE_DOCKER_FAIL = "1";
    const before = execFileSync("git", ["-C", repo, "branch", "--list", "pi/*"], { encoding: "utf8" }).trim();
    await assert.rejects(
      c.spawn({ repo, spec: { goal: "sandboxed", scope: ["src/item.txt"] } }),
      /sandbox requested but docker is unavailable/,
    );
    const after = execFileSync("git", ["-C", repo, "branch", "--list", "pi/*"], { encoding: "utf8" }).trim();
    assert.equal(after, before);
    assert.deepEqual((await dockerCalls(dockerLog)).filter((argv) => argv[0] === "run"), []);
  }));

test("verification never falls back to host execution when docker is unavailable", () =>
  fixture(async ({ c, meta, root }) => {
    process.env.FAKE_DOCKER_FAIL = "1";
    const marker = join(root, "host-fallback-marker");
    meta.spec.validators = [{ id: "escape", command: `touch ${marker}` }];
    await assert.rejects(c.verify("s1"), /sandbox requested but docker is unavailable/);
    assert.equal(existsSync(marker), false);
  }));

test("a validator timeout removes the container and fails the step", () =>
  fixture(async ({ c, meta, dockerLog }) => {
    meta.spec.validators = [{ id: "slow", command: "sleep 5", timeoutMs: 1000 }];
    const started = Date.now();
    const proof = await c.verify("s1");
    assert.ok(Date.now() - started < 5000);
    assert.equal(proof.passed, false);
    assert.equal(proof.validators[0].timedOut, true);
    const calls = await dockerCalls(dockerLog);
    assert.ok(calls.some((argv) => argv[0] === "rm" && argv[1] === "-f"), "expected docker rm -f after a timeout");
  }));

test("spec.isolation cannot bypass the configured sandbox policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const repo = join(root, "repo");
  try {
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await writeFile(join(repo, "file.txt"), "x");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
    const worktreeConfig = loadConfig({ dataDir: join(root, "data"), workspaceRoot: join(root, "workers"), defaultRepo: repo, autoClean: false });
    const worktreeCoord = new Coordinator(worktreeConfig);
    await worktreeCoord.init();
    try {
      await assert.rejects(
        worktreeCoord.spawn({ repo, spec: { goal: "docker please", scope: ["file.txt"], isolation: "docker" } }),
        /sandbox isolation was requested/,
      );
    } finally {
      await worktreeCoord.stopAll();
    }

    const dockerConfig = loadConfig({
      dataDir: join(root, "data2"), workspaceRoot: join(root, "workers2"), defaultRepo: repo,
      host: "0.0.0.0",
      autoClean: false, sandbox: "docker", sandboxImage: "fake:test", dockerBin: join(root, "fake-docker"),
    });
    await writeFile(join(root, "fake-docker"), "#!/bin/sh\nexit 1\n");
    await chmod(join(root, "fake-docker"), 0o755);
    const dockerCoord = new Coordinator(dockerConfig);
    await dockerCoord.init();
    try {
      await assert.rejects(
        dockerCoord.spawn({ repo, spec: { goal: "host please", scope: ["file.txt"], isolation: "worktree" } }),
        /requires the docker sandbox/,
      );
    } finally {
      await dockerCoord.stopAll();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("verify refuses when the recorded sandbox differs from the daemon backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-mismatch-"));
  try {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await writeFile(join(repo, "file.txt"), "x");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
    const config = loadConfig({ dataDir: join(root, "data"), workspaceRoot: join(root, "workers"), defaultRepo: repo, autoClean: false });
    const c = new Coordinator(config);
    await c.init();
    c.runtimes.set("s1", {
      meta: {
        id: "s1", name: "mismatch", repo, worktree: repo, cwd: repo, branch: "pi/test", baseRef: "HEAD",
        status: "idle", createdAt: 1, lastActivity: 1, pendingQuestions: [],
        spec: { goal: "x", scope: ["file.txt"] }, acceptance: { files: [], hashes: {}, command: "true" },
        sandbox: { kind: "docker", image: "x" },
      },
      client: { getState: async () => ({ isStreaming: false }), stop: async () => {}, isStreaming: false, refreshStreaming: async () => {} },
      repoIdentity: resolveRepoIdentity(repo), lastNotifiedQuestionIds: new Set(),
    });
    try {
      await assert.rejects(c.verify("s1"), /recorded with the docker sandbox but the daemon now uses worktree/);
    } finally {
      await c.stopAll();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a validator's explicit env wins over an allowlisted host name", () =>
  fixture(async ({ c, meta, dockerLog }) => {
    process.env.FAKE_PASSTHROUGH = "from-daemon";
    meta.spec.validators = [{ id: "env", command: "true", env: { FAKE_PASSTHROUGH: "from-validator" } }];
    await c.verify("s1");
    delete process.env.FAKE_PASSTHROUGH;
    const run = (await dockerCalls(dockerLog)).find((argv) => argv[0] === "run");
    assert.ok(run, "expected a docker run call");
    // Inline value present, by-name reference gone: docker resolves later `-e NAME`
    // entries from the CLI environment, so emitting both would silently win.
    assert.ok(run.includes("FAKE_PASSTHROUGH=from-validator"), run.join(" "));
    const occurrences = run.filter((arg) => arg === "FAKE_PASSTHROUGH").length;
    assert.equal(occurrences, 0, "the by-name reference must be dropped when a value is explicit");
  }));

test("a container that cannot be removed keeps the shutdown unconfirmed", async () => {
  const { DockerSandbox } = await import("../dist/sandbox.js");
  const config = { image: "fake:test", network: "bridge", envAllow: [], dockerBin: "docker" };
  const sandbox = new DockerSandbox(config,
    async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon", timedOut: false }));
  await assert.rejects(sandbox.removeWorker("s1"), /docker rm -f .* failed/);
  const missing = new DockerSandbox(config,
    async () => ({ code: 1, stdout: "", stderr: "Error: No such container: pi-coffee-s1", timedOut: false }));
  await missing.removeWorker("s1");
});


test("an explicit container user gets a writable HOME that a validator can still override", async () => {
  const { DockerSandbox } = await import("../dist/sandbox.js");
  const commands = [];
  const sandbox = new DockerSandbox(
    { image: "fake:test", network: "bridge", envAllow: ["FAKE_PASSTHROUGH"], dockerBin: "docker", user: "1000:1000" },
    async (command) => {
      commands.push(command);
      if (command.includes("version")) return { code: 0, stdout: "26.1.0\n", stderr: "", timedOut: false };
      if (command.includes("image inspect")) return { code: 0, stdout: "sha256:" + "a".repeat(64) + "\n", stderr: "", timedOut: false };
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  );
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-user-"));
  await writeFile(join(root, "file.txt"), "x");
  try {
    await sandbox.run(root, "true", 5000, { FAKE_PASSTHROUGH: "from-validator" });
    const run = commands.find((command) => command.includes(" run "));
    assert.ok(run, "expected a docker run command");
    // `/root` belongs to the image's default user: an overridden uid cannot write it.
    assert.match(run, /--user '1000:1000'/);
    assert.match(run, /-e 'HOME=\/tmp'/);
    assert.equal((run.match(/-e .HOME=/g) ?? []).length, 1, "one HOME, not a forwarded host value as well");
    assert.match(run, /-e 'FAKE_PASSTHROUGH=from-validator'/);

    // An allowlisted HOME is an explicit opt-in and outranks the sandbox default.
    const allowHome = new DockerSandbox(
      { image: "fake:test", network: "bridge", envAllow: ["HOME"], dockerBin: "docker", user: "1000:1000" },
      async (command) => {
        commands.push(command);
        if (command.includes("version")) return { code: 0, stdout: "26.1.0\n", stderr: "", timedOut: false };
        if (command.includes("image inspect")) return { code: 0, stdout: "sha256:" + "a".repeat(64) + "\n", stderr: "", timedOut: false };
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    );
    commands.length = 0;
    await allowHome.run(root, "true", 5000);
    const allowRun = commands.find((command) => command.includes(" run "));
    assert.doesNotMatch(allowRun, /HOME=\/tmp/, "the forwarded host name replaces the default");
    assert.match(allowRun, /-e 'HOME'/, "allowlisted names are forwarded by reference");

    // A validator value outranks both: one `-e`, with the explicit value, because
    // docker resolves a later `-e NAME` from the CLI environment and would win.
    commands.length = 0;
    await allowHome.run(root, "true", 5000, { HOME: "/custom-home" });
    const bothRun = commands.find((command) => command.includes(" run "));
    assert.deepEqual(bothRun.match(/-e 'HOME(=[^']*)?'/g), ["-e 'HOME=/custom-home'"],
      "one HOME entry, with the validator value");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
