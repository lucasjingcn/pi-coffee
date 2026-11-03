/**
 * Regression coverage for the defects found in the read-only audit of the last
 * 30 commits (2026-11-03). Each test names the behavior that was wrong; the
 * production fix lives next to the comment in the source file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../dist/audit.js";
import { checkCodeVersion, recordCodeVersion } from "../dist/code-version.js";
import { PiRpcClient } from "../dist/rpc-client.js";
import { resolveGitMounts } from "../dist/sandbox.js";
import { containsSecret, secretKinds } from "../dist/secrets.js";
import { loadConfig } from "../dist/config.js";
import { Coordinator } from "../dist/manager.js";
import { buildMetricsSnapshot } from "../dist/metrics.js";
import { GhClient, createGhRunner } from "../dist/gh.js";
import { reviewDiffBase } from "../dist/integration.js";
import { AcpClient } from "../dist/runner-acp.js";
import { worktreeDiff } from "../dist/worktree.js";
import { detectSupervisor, launchdBootoutArgs, restartCommand } from "../scripts/lib/supervisor.mjs";
import { commitAll, createWorktree, mergeBranch } from "../dist/worktree.js";

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function repoFixture(root) {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "file.txt"), "base");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  return repo;
}

/** A hooks directory + `core.hooksPath` pointing at it, so a marker proves execution. */
async function plantHooks(repo, root) {
  const hooks = join(root, "hooks");
  await mkdir(hooks, { recursive: true });
  const marker = join(root, "hook-ran");
  for (const name of ["pre-commit", "post-checkout", "post-merge"]) {
    await writeFile(join(hooks, name), `#!/bin/sh\necho ${name} >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  }
  git(repo, "config", "core.hooksPath", hooks);
  return { marker, read: async () => (existsSync(marker) ? await readFile(marker, "utf8") : "") };
}

test("daemon git calls can skip sandbox-planted hooks", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-"));
  try {
    const repo = await repoFixture(root);
    const hooks = await plantHooks(repo, root);

    // Control: without the override the fixture's hook really runs, so the
    // assertions below measure the override rather than a broken fixture.
    await writeFile(join(repo, "file.txt"), "changed-1");
    await commitAll(repo, "control commit");
    assert.match(await hooks.read(), /pre-commit/, "the fixture hook executes by default");

    await rm(hooks.marker, { force: true });
    await writeFile(join(repo, "file.txt"), "changed-2");
    await commitAll(repo, "sandboxed commit", { disableHooks: true });
    assert.equal(await hooks.read(), "", "disableHooks must not run a planted pre-commit hook");

    // `git worktree add` checks out a tree, so a redirected post-checkout hook
    // used to run in the daemon during the next spawn.
    await createWorktree({
      repo, dir: join(root, "wt-safe"), branch: "pi/safe", baseRef: "HEAD", disableHooks: true,
    });
    assert.equal(await hooks.read(), "", "a sandboxed spawn must not run a planted post-checkout hook");

    await createWorktree({ repo, dir: join(root, "wt-control"), branch: "pi/control", baseRef: "HEAD" });
    assert.match(await hooks.read(), /post-checkout/, "the fixture hook executes for a host-mode spawn");

    // `git merge` runs post-merge; a docker worker's config redirect must not
    // turn `pi_merge` into code execution.
    git(repo, "checkout", "-q", "main");
    await writeFile(join(repo, "file.txt"), "on-branch");
    git(repo, "checkout", "-q", "-b", "pi/topic");
    git(repo, "commit", "-qam", "topic");
    git(repo, "checkout", "-q", "main");
    // These fixture git calls run the planted hooks themselves; clear the marker
    // so the assertion measures `mergeBranch` only.
    await rm(hooks.marker, { force: true });
    const merged = await mergeBranch(repo, "pi/topic", "main", { disableHooks: true });
    assert.equal(merged.ok, true, merged.output);
    assert.equal(await hooks.read(), "", "disableHooks must not run a planted post-merge hook");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git metadata redirected outside the repository is never mounted", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-redirect-"));
  try {
    const repo = await repoFixture(root);
    const worktree = join(root, "worker");
    git(repo, "worktree", "add", "-q", "-b", "pi/w", worktree);

    const inside = await realpath(join(repo, ".git"));
    assert.deepEqual(
      resolveGitMounts(worktree, "/workspace", { allowedRepoRoot: repo }).map((mount) => mount.host)
        .filter((host) => host === inside),
      [inside],
      "metadata inside the repository is still mounted",
    );

    // A sandboxed worker rewrites its `.git` pointer (it is a plain file in a
    // linked worktree). Without the root check the daemon would bind-mount that
    // path into the next container — the host HOME in the reported defect.
    const elsewhere = join(root, "outside");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(worktree, ".git"), `gitdir: ${elsewhere}\n`);
    assert.deepEqual(resolveGitMounts(worktree, "/workspace", { allowedRepoRoot: repo }), [],
      "a pointer outside the repository yields no mount");
    assert.ok(resolveGitMounts(worktree, "/workspace").length > 0,
      "without the guard the mount still happens (what the guard is for)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a complete oversized RPC frame is parsed instead of killing the worker", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bigframe-"));
  const bin = join(dir, "fake-pi");
  // 9 MiB in one JSON line: `get_entries` on a long transcript really does this.
  await writeFile(bin, "#!/usr/bin/env node\n" + `const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const command=JSON.parse(line);
  if(command.type==='get_state')process.stdout.write(JSON.stringify({type:'response',id:command.id,success:true,data:{isStreaming:false}})+'\\n');
  if(command.type==='big')process.stdout.write(JSON.stringify({type:'response',id:command.id,success:true,data:{blob:'x'.repeat(9*1024*1024)}})+'\\n');
  if(command.type==='hang')process.stdout.write('x'.repeat(9*1024*1024));
});
process.stdin.on('end',()=>process.exit(0));`, { mode: 0o755 });
  const client = new PiRpcClient({ cwd: dir, piBin: bin });
  try {
    await client.start();
    const response = await client.command({ type: "big" }, 15000);
    assert.equal(response.success, true, "a valid 9 MiB line must not be reported as protocol desynchronized");
    assert.equal(client.hasExited, false, "the worker stays alive");
  } finally {
    await client.stop().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unterminated RPC line still fails closed past the cap", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bigline-"));
  const bin = join(dir, "fake-pi");
  await writeFile(bin, "#!/usr/bin/env node\n" + `const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const command=JSON.parse(line);
  if(command.type==='get_state')process.stdout.write(JSON.stringify({type:'response',id:command.id,success:true,data:{isStreaming:false}})+'\\n');
  // Larger than the 64 MiB unterminated-frame cap: this line never terminates.
  if(command.type==='hang')process.stdout.write('x'.repeat(65*1024*1024));
});
process.stdin.on('end',()=>process.exit(0));`, { mode: 0o755 });
  const client = new PiRpcClient({ cwd: dir, piBin: bin });
  try {
    await client.start();
    await client.command({ type: "hang" }, 5000).catch(() => undefined);
    const deadline = Date.now() + 10000;
    while (!client.hasExited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.equal(client.hasExited, true, "an unterminated 9 MiB line is still a protocol failure");
  } finally {
    await client.stop().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifying the audit chain while appending does not report a broken chain", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-audit-race-"));
  try {
    const log = new AuditLog({ dir });
    await log.append("orchestrator", "spawn", "s1");
    // Appends and verifies interleaved: an unserialized read used to observe the
    // window where the entry file was durable but the head sidecar was not.
    const pending = [];
    for (let i = 0; i < 12; i++) {
      pending.push(log.append("orchestrator", "verify", `s${i + 2}`));
      pending.push(log.verify().then((result) => assert.equal(result.ok, true, result.reason)));
    }
    await Promise.all(pending);
    const final = await log.verify();
    assert.equal(final.ok, true, final.reason);
    assert.equal(final.entries, 13);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rebuild that only rewrites another dist module marks the daemon stale", { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-code-version-all-"));
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "manager.js"), "export {};\n");
    await writeFile(join(root, "dist", "mcp-server.js"), "export const v = 1;\n");
    const recorded = recordCodeVersion(root);
    assert.equal(checkCodeVersion(root, recorded).stale, false);
    // Editing src/mcp-server.ts rewrites that emitted file only.
    await writeFile(join(root, "dist", "mcp-server.js"), "export const v = 2;\n");
    const status = checkCodeVersion(root, recorded);
    assert.equal(status.stale, true, "a changed sibling module must mark dist stale");
    assert.equal(status.hint, "restart daemon to load current code");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("credential shapes that used to slip through are detected", () => {
  const detected = [
    // Truncated PEM: the header alone is enough, people paste partial keys.
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA",
    // Passwords containing punctuation (the old value class rejected `!@#$%`).
    "password: Pa$$w0rd!2026xyz",
    "mysql_password=ab!cd@ef#gh$ij",
    // DSN with userinfo.
    "postgres://user:S3cr3tP4ssw0rd@db.internal:5432/app",
    // GCP service-account JSON field.
    '"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkq',
  ];
  for (const text of detected) assert.equal(containsSecret(text), true, text);
  assert.deepEqual(secretKinds("postgres://user:pass@db/app"), ["credential-url"]);
  // Prose and hashes stay clean: the filter must not reject ordinary messages.
  for (const text of [
    "the token must be rotated before release",
    "sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "password: short",
    "clone https://github.com/lucasjingcn/pi-coffee.git",
    "mail me at someone@example.com",
  ]) assert.equal(containsSecret(text), false, text);
});

test("active_workers counts in-flight spawns like the capacity check does", async () => {
  const snapshot = await buildMetricsSnapshot({
    metrics: async () => ({ sessions: [], worker: {} }),
    activeWorkers: () => 2,
    pendingSpawns: () => 1,
    spawnsSinceStart: () => 4,
    config: { maxSessions: 3 },
  }, Date.now() - 1000);
  assert.equal(snapshot.activeWorkers, 3, "2 live workers + 1 in-flight spawn occupy three slots");
  assert.equal(snapshot.maxSessions, 3, "so the gauge shows a full deployment, matching the spawn refusal");
});

test("an outcome stops the worker with the caller's worktree options", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-outcome-stop-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "base"), "base");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const fake = join(root, "fake-pi.js");
  await writeFile(fake, "const readline=require('node:readline');" + `
readline.createInterface({input:process.stdin}).on('line',line=>{
  const cmd=JSON.parse(line);
  const data=cmd.type==='get_state'?{isStreaming:false}:{};
  process.stdout.write(JSON.stringify({type:'response',id:cmd.id,success:true,data})+'\\n');
  if(cmd.type==='prompt')process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
});`);
  const config = loadConfig({
    dataDir: join(root, "data"),
    workspaceRoot: join(root, "workers"),
    defaultRepo: repo,
    piBin: fake,
    autoClean: true,
    token: "",
  });
  const coordinator = new Coordinator(config);
  await coordinator.init();
  try {
    const meta = await coordinator.spawn({
      task: "outcome-fixture",
      prompt: "do the work",
      spec: { goal: "write src/out.txt", scope: ["src"], purpose: "implementation" },
    });
    assert.ok(existsSync(meta.worktree), "the spawned worktree exists");
    // The reported defect: passing an outcome dropped preserve_worktree, and the
    // default autoClean then removed a clean worktree the caller asked to keep.
    await coordinator.setOutcome(meta.id, "abandoned", "audit fixture", { preserveWorktree: true });
    assert.ok(existsSync(meta.worktree), "preserve_worktree survives an outcome stop");
  } finally {
    await coordinator.stopAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("the merge-queue method is configuration, not a hardcoded squash", async () => {
  const { loadConfig } = await import("../dist/config.js");
  assert.equal(loadConfig({}).prMergeMethod, "squash");
  assert.equal(loadConfig({ prMergeMethod: "merge" }).prMergeMethod, "merge");
  assert.throws(() => loadConfig({ prMergeMethod: "fast-forward" }), /prMergeMethod|PI_COFFEE_PR_MERGE_METHOD/);

  const seen = [];
  const gh = new GhClient(async (args) => { seen.push(args); return { code: 0, stdout: "", stderr: "" }; });
  await gh.queueMerge("/repo", 7, "rebase");
  assert.deepEqual(seen[0], ["pr", "merge", "7", "--rebase", "--auto"],
    "the configured method must reach gh pr merge");
});

test("the two-strikes gate reserves its slot before the first await", { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-twostrikes-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "base"), "base");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const fake = join(root, "fake-pi.js");
  await writeFile(fake, "const readline=require('node:readline');" + `
readline.createInterface({input:process.stdin}).on('line',line=>{
  const cmd=JSON.parse(line);
  const data=cmd.type==='get_state'?{isStreaming:false}:{};
  process.stdout.write(JSON.stringify({type:'response',id:cmd.id,success:true,data})+'\\n');
  if(cmd.type==='prompt')setTimeout(()=>process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n'),20);
});`);
  const coordinator = new Coordinator(loadConfig({
    dataDir: join(root, "data"), workspaceRoot: join(root, "workers"), defaultRepo: repo,
    piBin: fake, autoClean: false, token: "",
  }));
  await coordinator.init();
  try {
    const meta = await coordinator.spawn({
      task: "strikes", prompt: "do the work",
      spec: { goal: "write src/out.txt", scope: ["src"], purpose: "implementation" },
    });
    // The spawn prompt is instruction #1 (the initial task), so the limit is 2:
    // one correction is allowed and the third is refused.
    assert.equal(coordinator.snapshot(meta.id).instructionsSent, 1, "the spawn prompt counts as the first instruction");
    await coordinator.send(meta.id, "first correction", "prompt", true, { maxInstructions: 2 });
    await assert.rejects(coordinator.send(meta.id, "second correction", "prompt", true, { maxInstructions: 2 }),
      /two-strikes gate/);
    assert.equal(coordinator.snapshot(meta.id).instructionsSent, 2, "the rejected send is not counted");

    // Concurrent: exactly one of two simultaneous sends may pass.
    const other = await coordinator.spawn({
      task: "strikes-concurrent", prompt: "do the work",
      spec: { goal: "write tests/out2.txt", scope: ["tests"], purpose: "implementation" },
    });
    const results = await Promise.allSettled([
      coordinator.send(other.id, "a", "prompt", true, { maxInstructions: 2 }),
      coordinator.send(other.id, "b", "prompt", true, { maxInstructions: 2 }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1,
      "a concurrent pair must not both pass the gate");
    assert.equal(coordinator.snapshot(other.id).instructionsSent, 2,
      "only one of the two concurrent sends was charged");
  } finally {
    await coordinator.stopAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a worker that merges the target is judged on its own commits", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-attribution-"));
  try {
    const repo = await repoFixture(root);
    const base = git(repo, "rev-parse", "HEAD");
    const worker = join(root, "worker");
    git(repo, "worktree", "add", "-q", "-b", "pi/topic", worker);

    await writeFile(join(worker, "worker.txt"), "worker");
    git(worker, "add", "-A");
    git(worker, "commit", "-qm", "worker change");

    // Someone else lands a test edit on the target branch.
    await writeFile(join(repo, "someone-else.txt"), "theirs");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "target change");
    const targetTip = git(repo, "rev-parse", "HEAD");

    // The worker resolves the conflict the normal way: merge the target in.
    git(worker, "merge", "-q", "--no-edit", "main");

    const baseForReview = await reviewDiffBase(worker, base, targetTip);
    assert.equal(baseForReview, targetTip, "attribution starts at the target tip, not the spawn base");
    const diff = await worktreeDiff(worker, baseForReview);
    assert.deepEqual(diff.files, ["worker.txt"],
      "the target's own commits are not charged to the worker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tail appended past the audit head sidecar is rejected", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-audit-anchor-"));
  try {
    const log = new AuditLog({ dir });
    await log.append("orchestrator", "spawn", "s1");
    const headPath = join(dir, "audit.head.json");
    const anchored = await readFile(headPath, "utf8");
    await log.append("orchestrator", "merge", "s1");
    // Someone appends a hash-consistent entry without updating the chain head:
    // rewrite the sidecar so it still anchors at seq 1.
    await writeFile(headPath, anchored);
    const forged = await new AuditLog({ dir }).verify();
    assert.equal(forged.ok, false, "an unanchored tail is not a valid chain");
    assert.match(forged.reason, /past the head sidecar/);

    // Our own failed sidecar write is the one legitimate lag: the durable entry
    // owns its seq and the next append repairs the head.
    const self = new AuditLog({ dir });
    await self.append("orchestrator", "spawn", "x");
    const headBefore = await readFile(headPath, "utf8");
    await self.append("orchestrator", "merge", "x");
    await writeFile(headPath, headBefore); // simulate writeHead failing after the append
    const pending = await self.verify();
    assert.equal(pending.ok, true, pending.reason);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a timed-out ACP turn refuses the next one instead of racing the agent", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-acp-poison-"));
  const fake = join(dir, "fake-acp");
  await writeFile(fake, `#!/usr/bin/env node
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let frame; try { frame = JSON.parse(line); } catch { return; }
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
  if (frame.method === "initialize") return send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } });
  if (frame.method === "session/new") return send({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "s" } });
  // session/prompt is never answered: that is the timeout path.
  if (frame.method === "session/cancel" && frame.id !== undefined) return send({ jsonrpc: "2.0", id: frame.id, result: {} });
});
`, { mode: 0o755 });
  const client = new AcpClient({
    command: [process.execPath, fake],
    cwd: dir,
    transcriptPath: join(dir, "acp.jsonl"),
    promptTimeoutMs: 300,
  });
  try {
    await client.start();
    await assert.rejects(client.prompt("first"), /timed out/);
    // ACP v1 answers one prompt per turn; a second prompt while the first is
    // still being answered would break the serialization the queue promises.
    await assert.rejects(client.prompt("second"), /cannot accept another turn/);
  } finally {
    await client.stop().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("the upgrade plan matches the supervisor actually installed", () => {
  const plist = join("/h", "Library", "LaunchAgents", "com.picoffee.daemon.plist");
  assert.equal(detectSupervisor({ platform: "darwin", home: "/h", exists: (path) => path === plist }), "launchd");
  assert.equal(detectSupervisor({ platform: "darwin", home: "/h", exists: () => false }), undefined);
  assert.equal(detectSupervisor({ platform: "linux", home: "/h", exists: (path) => path === "/h/.config/systemd/user/pi-coffee.service" }), "systemd-user");
  assert.equal(detectSupervisor({ platform: "win32", home: "/h", exists: () => false, taskRegistered: () => true }), "windows-task");
  assert.equal(detectSupervisor({ platform: "win32", home: "/h", exists: () => false, taskRegistered: () => false }), undefined);

  // KeepAlive restarts the old build after a graceful exit, so launchd is unloaded.
  assert.deepEqual(launchdBootoutArgs(501), ["bootout", "gui/501/com.picoffee.daemon"]);
  assert.match(restartCommand("launchd", { uid: 501 }), /^launchctl kickstart -k gui\/501\/com\.picoffee\.daemon$/);
  // A scheduled task is not a Windows service: Restart-Service never worked.
  assert.equal(restartCommand("windows-task"), "Start-ScheduledTask -TaskName pi-coffee");
  assert.equal(restartCommand(undefined), "node scripts/start.mjs");
});

test("a gh spawn failure says what happened instead of `exit null`", async () => {
  const gh = new GhClient(createGhRunner("/nonexistent-dir/gh"));
  await assert.rejects(gh.findPr("/repo", "pi/x"), (error) => {
    assert.match(error.message, /ENOENT|spawn/i, "the real cause is kept");
    assert.match(error.message, /may already be applied/,
      "a missing exit status must warn that the effect may have landed");
    return true;
  });
});
