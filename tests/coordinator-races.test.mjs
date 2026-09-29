import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Coordinator} from '../dist/manager.js';
import {loadConfig} from '../dist/config.js';
import {PiRpcClient} from '../dist/rpc-client.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
PiRpcClient.prototype.start=async function(){};
PiRpcClient.prototype.stop=async function(){};
PiRpcClient.prototype.prompt=async function(){this.emit("event",{type:"agent_settled"});return {success:true};};
PiRpcClient.prototype.getState=async function(){return {isStreaming:false};};
PiRpcClient.prototype.getSessionStats=async function(){return {cost:0,tokens:{}};};

async function until(fn, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('condition not met before timeout');
    await delay(5);
  }
}

async function fixture(fn, maxSessions = 4) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-manager-race-'));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'});
  git('init', '-q');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  await writeFile(join(repo, 'base.txt'), 'base');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const config = loadConfig({dataDir: join(dir, 'data'), workspaceRoot: join(dir, 'worktrees'), defaultRepo: repo, maxSessions, autoClean: false});
  const c = new Coordinator(config);
  await c.init();
  try {
    await fn(c, config, git);
  } finally {
    await c.stopAll();
    await delay(650);
    await rm(dir, {recursive: true, force: true});
  }
}

test('a distinct second spawn proceeds while the first is still starting', async () => fixture(async (c) => {
  const started = [];
  let releaseFirst;
  const gate = new Promise((r) => { releaseFirst = r; });
  const original = PiRpcClient.prototype.start;
  PiRpcClient.prototype.start = async function () {
    started.push(1);
    if (started.length === 1) await gate;
  };
  try {
    const first = c.spawn({spec: {goal: 'one', scope: ['a']}});
    await until(() => started.length === 1);
    // maxSessions=2 and only one runtime is registered (status starting); the second distinct
    // spawn must not be rejected by a leftover reservation double-counting the first slot.
    const second = await c.spawn({spec: {goal: 'two', scope: ['b']}});
    assert.equal(second.status, 'idle');
    assert.equal(c.list().filter((s) => s.status === 'idle' || s.status === 'starting').length, 2);
    releaseFirst();
    assert.equal((await first).status, 'idle');
  } finally {
    releaseFirst();
    PiRpcClient.prototype.start = original;
  }
}, 2));

test('duplicate acceptance reservation is rejected without touching the first lock or file', async () => fixture(async (c) => {
  const s1 = await c.spawn({spec: {goal: 'one', scope: ['a']}, acceptanceFiles: [{path: 'tests/shared', content: 'first'}]});
  const file = join(s1.worktree, 'tests/shared');
  const codexShared = () => c.locksList().filter((l) => l.sessionId === 'codex' && l.path === '/tests/shared');
  assert.equal(codexShared().length, 1, 'first worker must hold the codex acceptance lock');
  assert.equal(await readFile(file, 'utf8'), 'first');

  const original = PiRpcClient.prototype.start;
  let starts = 0;
  PiRpcClient.prototype.start = async function () { starts++; };
  try {
    // Same acceptance file under the shared codex owner must still conflict with the first worker.
    await assert.rejects(
      c.spawn({spec: {goal: 'two', scope: ['b']}, acceptanceFiles: [{path: 'tests/shared', content: 'second'}]}),
      /acceptance files conflict/,
    );
    assert.equal(starts, 0, 'conflicting spawn must never start a child');
    // The first worker's reservation and written file are untouched.
    assert.equal(codexShared().length, 1);
    assert.equal(await readFile(file, 'utf8'), 'first');
  } finally {
    PiRpcClient.prototype.start = original;
  }
}));

test('stopping a failed startup does not release a newer acceptance reservation', async () => fixture(async (c) => {
  const original = PiRpcClient.prototype.start;
  let fail = true;
  PiRpcClient.prototype.start = async function () {
    if (fail) throw new Error('startup failure');
  };
  try {
    // First spawn reserves then releases its acceptance lock on startup failure.
    await assert.rejects(
      c.spawn({spec: {goal: 'one', scope: ['a']}, acceptanceFiles: [{path: 'tests/shared', content: 'first'}]}),
      /startup failure/,
    );
    assert.deepEqual(c.locksList(), []);

    // A newer worker now acquires the same acceptance path.
    fail = false;
    await c.spawn({spec: {goal: 'two', scope: ['b']}, acceptanceFiles: [{path: 'tests/shared', content: 'second'}]});
    const codexShared = () => c.locksList().filter((l) => l.sessionId === 'codex' && l.path === '/tests/shared');
    assert.equal(codexShared().length, 1);

    // The failed session is still registered as error; stopping it must not release the newer
    // worker's codex acceptance lock.
    const failed = c.list().find((s) => s.status === 'error');
    assert.ok(failed, 'failed session should still be visible');
    await c.stop(failed.id);
    assert.equal(codexShared().length, 1, 'newer worker acceptance lock must survive stopping the failed session');
  } finally {
    PiRpcClient.prototype.start = original;
  }
}));

test('unresolvable baseRef propagates the error and releases all reservations', async () => fixture(async (c) => {
  const original = PiRpcClient.prototype.start;
  let starts = 0;
  PiRpcClient.prototype.start = async function () { starts++; };
  try {
    await assert.rejects(
      c.spawn({spec: {goal: 'one', scope: ['a']}, acceptanceFiles: [{path: 'tests/shared', content: 't'}], baseRef: 'does-not-exist'}),
      (err) => /rev-parse|fatal|does-not-exist/i.test(String(err?.message ?? err)),
    );
    assert.equal(starts, 0);
    assert.deepEqual(c.locksList(), [], 'scope and acceptance reservations must be released on resolve failure');
  } finally {
    PiRpcClient.prototype.start = original;
  }
}));
