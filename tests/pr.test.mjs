import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";
import { resolveRepoIdentity } from "../dist/lock-repo.js";

const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
if (process.env.FAKE_GH_FAIL === "1") { console.error("gh auth failed"); process.exit(1); }
if (args[0] === "pr" && args[1] === "list") {
  const state = process.env.FAKE_GH_STATE;
  if (state && fs.existsSync(state)) console.log(JSON.stringify([JSON.parse(fs.readFileSync(state, "utf8"))]));
  else console.log("[]");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const pr = { number: 7, url: "https://example.test/pull/7", state: "OPEN", headRefOid: process.env.FAKE_GH_HEAD ?? "" };
  const labelIndex = args.indexOf("--label");
  if (labelIndex >= 0 && process.env.FAKE_GH_LABEL_FAIL === "1") { console.error("could not add label"); process.exit(1); }
  if (process.env.FAKE_GH_STATE) fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(pr));
  console.log(pr.url);
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  const state = process.env.FAKE_GH_STATE;
  const pr = state && fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : { number: 7, url: "https://example.test/pull/7", state: "OPEN", headRefOid: "" };
  if (process.env.FAKE_GH_HEAD) pr.headRefOid = process.env.FAKE_GH_HEAD;
  console.log(JSON.stringify(pr));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "edit") process.exit(0);
if (args[0] === "pr" && args[1] === "merge") process.exit(0);
process.exit(0);
`;

async function fixture(fn, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-pr-"));
  const repo = join(root, "repo");
  const bare = join(root, "remote.git");
  const fake = join(root, "fake-gh");
  const log = join(root, "gh.log");
  const state = join(root, "gh-state.json");
  await writeFile(fake, FAKE_GH);
  await chmod(fake, 0o755);
  execFileSync("git", ["init", "--bare", "-q", bare]);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await mkdir(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "remote", "add", "origin", bare);
  await writeFile(join(repo, "src/item.txt"), "base");
  git(repo, "add", "src");
  git(repo, "commit", "-qm", "base");
  const baseRef = git(repo, "rev-parse", "HEAD");
  const workerDir = join(root, "worker");
  git(repo, "worktree", "add", "-q", "-b", "pi/test", workerDir, baseRef);
  await writeFile(join(workerDir, "src/item.txt"), "changed");
  git(workerDir, "add", "src/item.txt");
  git(workerDir, "commit", "-qm", "worker change");
  process.env.FAKE_GH_LOG = log;
  process.env.FAKE_GH_STATE = state;
  const config = loadConfig({
    dataDir: join(root, "data"), workspaceRoot: join(root, "workers"), defaultRepo: repo, autoClean: false,
    ghBin: fake, ghRemote: "origin", prLabel: "pi-coffee", allowPush: true,
    ...overrides,
  });
  const c = new Coordinator(config);
  await c.init();
  const meta = {
    id: "s1", name: "pr fixture", repo, worktree: workerDir, cwd: workerDir, branch: "pi/test",
    baseRef, status: "idle", createdAt: 1, lastActivity: 1, pendingQuestions: [],
    spec: { goal: "change item for PR", scope: ["src/item.txt"] },
    acceptance: { files: [], hashes: {}, command: 'test "$(cat src/item.txt)" = changed' },
  };
  c.runtimes.set("s1", {
    meta,
    client: { getState: async () => ({ isStreaming: false }), stop: async () => {}, isStreaming: false, refreshStreaming: async () => {} },
    repoIdentity: resolveRepoIdentity(repo),
    lastNotifiedQuestionIds: new Set(),
  });
  try {
    await fn({ c, meta, repo, bare, log, root, config });
  } finally {
    delete process.env.FAKE_GH_LOG;
    delete process.env.FAKE_GH_STATE;
    delete process.env.FAKE_GH_FAIL;
    delete process.env.FAKE_GH_HEAD;
    delete process.env.FAKE_GH_LABEL_FAIL;
    await c.stopAll();
    await rm(root, { recursive: true, force: true });
  }
}

async function calls(log) {
  try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}

test("pi_pr pushes the branch, embeds evidence and is idempotent", () =>
  fixture(async ({ c, meta, bare, log }) => {
    const proof = await c.verify("s1");
    assert.equal(proof.passed, true);
    const first = await c.createPr("s1");
    assert.equal(first.created, true);
    assert.equal(first.pr.number, 7);
    assert.equal(meta.pr.number, 7);
    const remoteBranches = execFileSync("git", ["-C", bare, "branch", "--list", "pi/test"], { encoding: "utf8" }).trim();
    assert.match(remoteBranches, /pi\/test/);
    const create = (await calls(log)).find((argv) => argv[0] === "pr" && argv[1] === "create");
    const body = create[create.indexOf("--body") + 1];
    assert.match(body, new RegExp(`Verification: ${proof.id}`));
    assert.match(body, new RegExp(proof.workerSha));
    if (proof.evidence) assert.match(body, new RegExp(proof.evidence.manifestSha256));

    const second = await c.createPr("s1");
    assert.equal(second.created, false);
    assert.equal(second.pr.number, 7);
    assert.equal((await calls(log)).filter((argv) => argv[0] === "pr" && argv[1] === "create").length, 1);
  }));

test("merge-queue mode queues the PR after evidence checks", () =>
  fixture(async ({ c, log, meta }) => {
    const proof = await c.verify("s1");
    await c.createPr("s1");
    process.env.FAKE_GH_HEAD = proof.workerSha;
    const queued = await c.mergeViaQueue("s1");
    assert.equal(queued.ok, true);
    assert.equal(queued.queued, true);
    const merge = (await calls(log)).find((argv) => argv[0] === "pr" && argv[1] === "merge");
    assert.deepEqual(merge.slice(0, 5), ["pr", "merge", "7", "--squash", "--auto"]);
    // Merge-queue mode must not pretend the work is integrated locally.
    assert.equal(c.snapshot("s1").integration, undefined);
  }));

test("PR operations are refused without PI_COFFEE_ALLOW_PUSH", () =>
  fixture(async ({ c, log, bare }) => {
    await c.verify("s1");
    await assert.rejects(c.createPr("s1"), /PI_COFFEE_ALLOW_PUSH=0/);
    await assert.rejects(c.mergeViaQueue("s1"), /PI_COFFEE_ALLOW_PUSH=0/);
    assert.deepEqual((await calls(log)).filter((argv) => argv[0] === "pr"), []);
    const branches = execFileSync("git", ["-C", bare, "branch", "--list", "pi/test"], { encoding: "utf8" }).trim();
    assert.equal(branches, "");
  }, { allowPush: false }));

test("gh failures surface without recording a PR", () =>
  fixture(async ({ c, meta }) => {
    await c.verify("s1");
    process.env.FAKE_GH_FAIL = "1";
    await assert.rejects(c.createPr("s1"), /gh pr list failed: gh auth failed/);
    assert.equal(meta.pr, undefined);
  }));


test("merge-queue refuses a PR whose head is not the verified worker", () =>
  fixture(async ({ c }) => {
    const proof = await c.verify("s1");
    await c.createPr("s1");
    process.env.FAKE_GH_HEAD = "f".repeat(40);
    await assert.rejects(c.mergeViaQueue("s1"), /does not match verified worker/);
    assert.equal((await calls(process.env.FAKE_GH_LOG)).filter((argv) => argv[1] === "merge").length, 0);
    assert.ok(proof.workerSha);
  }));

test("a missing PR label is retried without the label", () =>
  fixture(async ({ c, log }) => {
    await c.verify("s1");
    process.env.FAKE_GH_LABEL_FAIL = "1";
    const result = await c.createPr("s1");
    assert.equal(result.created, true);
    const creates = (await calls(log)).filter((argv) => argv[0] === "pr" && argv[1] === "create");
    assert.equal(creates.length, 2);
    assert.ok(creates[0].includes("--label"));
    assert.ok(!creates[1].includes("--label"));
  }));
