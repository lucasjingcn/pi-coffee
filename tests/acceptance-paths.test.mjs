import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { acceptancePath, writeAcceptanceFile } from '../dist/acceptance.js';
import { Coordinator } from '../dist/manager.js';
import { loadConfig } from '../dist/config.js';
import { PiRpcClient } from '../dist/rpc-client.js';

test('acceptance paths reject traversal, absolute paths, directory targets and Git metadata', () => {
  for (const path of ['', '.', '../outside', 'tests/../../outside', '/tmp/outside', '.git', 'tests/.git/config', 'tests/', 'a\0b', '..\\outside']) {
    assert.throws(() => acceptancePath(path), undefined, path);
  }
  assert.equal(acceptancePath('./tests/ok.mjs'), 'tests/ok.mjs');
});

test('spawn validates acceptance paths and symlinks before starting any worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-spawn-path-test-'));
  const repo = join(dir, 'repo');
  const outside = join(dir, 'outside');
  await mkdir(repo); await mkdir(outside);
  await writeFile(join(outside, 'keep'), 'original');
  await symlink(outside, join(repo, 'linked'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.com');
  git('add', '-A'); git('commit', '-qm', 'base');
  git('branch', 'existing-worker');
  const coord = new Coordinator(loadConfig({ defaultRepo: repo, dataDir: join(dir, 'data'), workspaceRoot: join(dir, 'worktrees'), autoClean: false }));
  const original = PiRpcClient.prototype.start;
  let starts = 0;
  PiRpcClient.prototype.start = async () => { starts++; };
  await coord.init();
  try {
    for (const path of ['../outside/keep', 'linked/keep', '.git']) {
      await assert.rejects(coord.spawn({ acceptanceFiles: [{ path, content: 'bad' }], spec: { goal: 'test', scope: ['src/app'] } }));
      assert.equal(starts, 0);
      assert.deepEqual(coord.locksList(), []);
      assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'original');
    }
    await assert.rejects(coord.spawn({ branch: 'existing-worker', acceptanceFiles: [{ path: 'linked/keep', content: 'bad' }], spec: { goal: 'test', scope: ['src/app'] } }));
    git('rev-parse', '--verify', 'existing-worker');
  } finally {
    PiRpcClient.prototype.start = original;
    await coord.stopAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test('acceptance writes cannot follow checkout symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-acceptance-test-'));
  const root = join(dir, 'worktree');
  const outside = join(dir, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(join(outside, 'keep'), 'original');
  try {
    await symlink(outside, join(root, 'linked-parent'));
    await assert.rejects(writeAcceptanceFile(root, 'linked-parent/keep', 'bad'));
    await symlink(join(outside, 'keep'), join(root, 'linked-file'));
    await assert.rejects(writeAcceptanceFile(root, 'linked-file', 'bad'));
    assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'original');
    await writeAcceptanceFile(root, 'tests/nested/ok.mjs', 'valid');
    assert.equal(await readFile(join(root, 'tests/nested/ok.mjs'), 'utf8'), 'valid');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
