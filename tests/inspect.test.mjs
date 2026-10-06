import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/inspect.mjs", import.meta.url));

/** Run inspect with a clean PI_COFFEE_* environment plus per-test overrides. */
function runInspect(args, extraEnv = {}) {
  const env = { ...process.env };
  delete env.PI_COFFEE_DATA_DIR;
  delete env.PI_COFFEE_WORKSPACE_ROOT;
  delete env.PI_COFFEE_ENV_FILE;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}

async function stateHash(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function makeDataDir(root) {
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  return dataDir;
}

function writeState(dataDir, state) {
  return writeFile(join(dataDir, "state.json"), JSON.stringify(state, null, 2));
}

test("inspect reports missing and orphan worktrees in both directions with exit 1 and --json", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-inspect-diff-"));
  try {
    const dataDir = await makeDataDir(root);
    const worktrees = join(dataDir, "worktrees");
    await mkdir(join(worktrees, "s1"), { recursive: true });
    await mkdir(join(worktrees, "s4"), { recursive: true });
    await writeFile(join(worktrees, "s1", "payload.bin"), Buffer.alloc(4096, 7));
    await mkdir(join(dataDir, "sessions", "s1"), { recursive: true });

    const now = Date.now();
    const stateFile = join(dataDir, "state.json");
    await writeState(dataDir, {
      counter: 4,
      locks: [{ path: join(worktrees, "s1"), mode: "rw", sessionId: "codex", ts: now - 60_000, repo: "/repo/.git" }],
      mailbox: [],
      board: [],
      history: [
        { id: "s1", worktree: join(worktrees, "s1"), status: "working", lastActivity: now },
        { id: "s2", worktree: join(worktrees, "s2"), status: "stopped", outcome: "success_first", lastActivity: 1 },
      ],
    });

    const hashBefore = await stateHash(stateFile);
    const entriesBefore = (await readdir(dataDir)).sort();

    const result = runInspect(["--json", "--data-dir", dataDir]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);

    const byId = new Map(report.findings.map((finding) => [finding.id, finding]));
    assert.equal(report.findings.length, 2);
    assert.equal(byId.get("s2")?.kind, "missing_worktree");
    assert.match(byId.get("s2").detail, /s2/);
    assert.equal(byId.get("s4")?.kind, "orphan_worktree");
    assert.match(byId.get("s4").detail, /s4/);

    // Summary sections: locks list, session age buckets, worktree sizes.
    assert.equal(report.summary.activeLocks.length, 1);
    assert.equal(report.summary.activeLocks[0].sessionId, "codex");
    assert.equal(typeof report.summary.sessionAge.buckets.over48h, "number");
    assert.equal(report.summary.worktreeSizes[0].id, "s1");
    assert.ok(report.summary.worktreeSizes[0].bytes >= 4096);

    // Read-only proof: content hash unchanged, no new files, no removed files.
    assert.equal(await stateHash(stateFile), hashBefore);
    assert.deepEqual((await readdir(dataDir)).sort(), entriesBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect exits 0 and reports no findings when ledger and disk reconcile", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-inspect-clean-"));
  try {
    const dataDir = await makeDataDir(root);
    const worktrees = join(dataDir, "worktrees");
    await mkdir(join(worktrees, "s1"), { recursive: true });
    const stateFile = join(dataDir, "state.json");
    await writeState(dataDir, {
      counter: 1,
      locks: [],
      mailbox: [],
      board: [],
      history: [{ id: "s1", worktree: join(worktrees, "s1"), status: "stopped", outcome: "success_first", lastActivity: 1 }],
    });

    const hashBefore = await stateHash(stateFile);
    const human = runInspect(["--data-dir", dataDir]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /no differences/i);

    const json = runInspect(["--json", "--data-dir", dataDir]);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout).findings, []);

    assert.equal(await stateHash(stateFile), hashBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect resolves dataDir from PI_COFFEE_DATA_DIR and lets --data-dir win", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-inspect-env-"));
  try {
    const dataDir = await makeDataDir(root);
    await mkdir(join(dataDir, "worktrees", "s9"), { recursive: true });
    await writeState(dataDir, { counter: 0, locks: [], mailbox: [], board: [], history: [] });

    const fromEnv = runInspect(["--json"], { PI_COFFEE_DATA_DIR: dataDir });
    assert.equal(fromEnv.status, 1, fromEnv.stderr);
    const envReport = JSON.parse(fromEnv.stdout);
    assert.equal(envReport.summary.dataDir, dataDir);
    assert.equal(envReport.findings[0]?.kind, "orphan_worktree");

    const other = join(root, "other");
    await mkdir(other, { recursive: true });
    const fromFlag = runInspect(["--json", "--data-dir", other], { PI_COFFEE_DATA_DIR: dataDir });
    assert.equal(fromFlag.status, 0, fromFlag.stderr);
    const flagReport = JSON.parse(fromFlag.stdout);
    assert.equal(flagReport.summary.dataDir, other);
    assert.deepEqual(flagReport.findings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect reports session ages (48h TTL) and worktree sizes without making them findings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-inspect-age-"));
  try {
    const dataDir = await makeDataDir(root);
    const worktrees = join(dataDir, "worktrees");
    await mkdir(join(worktrees, "s1"), { recursive: true });
    await writeFile(join(worktrees, "s1", "payload.bin"), Buffer.alloc(2048, 1));
    await mkdir(join(dataDir, "sessions", "old"), { recursive: true });
    await mkdir(join(dataDir, "sessions", "fresh"), { recursive: true });
    const stale = new Date(Date.now() - 50 * 60 * 60 * 1000);
    await utimes(join(dataDir, "sessions", "old"), stale, stale);

    await writeState(dataDir, {
      counter: 2,
      locks: [],
      mailbox: [],
      board: [],
      history: [
        { id: "s1", worktree: join(worktrees, "s1"), status: "stopped", outcome: "success_first", lastActivity: 1 },
        { id: "old", worktree: "", status: "stopped", outcome: "success_first", lastActivity: 1 },
      ],
    });

    const result = runInspect(["--json", "--data-dir", dataDir]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.sessionAge.total, 2);
    assert.equal(report.summary.sessionAge.buckets.over48h, 1);
    assert.equal(report.summary.sessionAge.over48h, 1);
    assert.equal(report.summary.sessionAge.sweepCandidates, 1);
    assert.equal(report.summary.sessionAge.untracked, 1);
    assert.equal(report.summary.worktreeSizes[0].id, "s1");
    assert.ok(report.summary.worktreeSizes[0].bytes >= 2048);

    // Human output carries the same TTL framing.
    const human = runInspect(["--data-dir", dataDir]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, />=48h: 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect treats an unreadable ledger as a difference and rejects bad usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-inspect-bad-"));
  try {
    const dataDir = await makeDataDir(root);
    const stateFile = join(dataDir, "state.json");
    await writeFile(stateFile, "{ this is not json");
    const hashBefore = await stateHash(stateFile);

    const result = runInspect(["--json", "--data-dir", dataDir]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.stateStatus, "unreadable");
    assert.equal(report.findings[0]?.kind, "state_unreadable");
    assert.equal(await stateHash(stateFile), hashBefore);

    const usage = runInspect(["--nope"]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /unknown argument/);

    // A workspace root that exists but cannot be scanned must not look clean.
    const blockedData = join(root, "blocked", "data");
    await mkdir(blockedData, { recursive: true });
    await writeFile(join(blockedData, "worktrees"), "not a directory");
    const blocked = runInspect(["--json", "--data-dir", blockedData]);
    assert.equal(blocked.status, 1);
    const blockedReport = JSON.parse(blocked.stdout);
    assert.ok(blockedReport.findings.some((finding) => finding.kind === "unreadable_directory" && finding.id === "worktrees"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
