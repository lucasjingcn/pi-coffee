import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Coordinator} from '../dist/manager.js';
import {loadConfig} from '../dist/config.js';
import {deleteMergedBranch} from '../dist/worktree.js';

test('invalid historical branch metadata cannot be normalized into a real branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gc-invalid-'));
  const repo = join(root, 'repo');
  let coordinator;
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'}).trim();
  try {
    await mkdir(repo);
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.test');
    await writeFile(join(repo, 'file'), 'base');
    git('add', '.'); git('commit', '-m', 'base'); git('branch', 'pi/safe');
    const dataDir = join(root, 'data'); await mkdir(dataDir);
    const history = [' pi/safe ', 'pi/safe^', 'pi/safe~0'].map((branch, i) => ({
      id: `s${i + 1}`, name: 'invalid branch test', repo, branch,
      worktree: join(root, `missing-${i}`), cwd: repo, baseRef: git('rev-parse', 'HEAD'),
      status: 'stopped', createdAt: 1, lastActivity: 1, pendingQuestions: [], outcome: 'success_first',
    }));
    await writeFile(join(dataDir, 'state.json'), JSON.stringify({counter: 3, history, mailbox: [], board: [], locks: []}));
    coordinator = new Coordinator(loadConfig({dataDir, workspaceRoot: join(root, 'workers'), autoClean: false}));
    await coordinator.init();
    const result = await coordinator.gc();
    assert.equal(result.branches_deleted, 0);
    assert.equal(git('rev-parse', '--verify', 'refs/heads/pi/safe'), git('rev-parse', 'HEAD'));
    assert.equal(result.branches_retained.length, 3);
    assert.ok(result.branches_retained.every(entry => /invalid/i.test(entry.reason)));
  } finally {
    if (coordinator) await coordinator.stopAll();
    await rm(root, {recursive: true, force: true});
  }
});

async function repository(fn) {
  const root = await mkdtemp(join(tmpdir(), 'pi-gc-safety-'));
  const repo = join(root, 'repo'); await mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'}).trim();
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    await writeFile(join(repo, 'file'), 'base'); git('add', '.'); git('commit', '-m', 'base');
    await fn(root, repo, git);
  } finally { await rm(root, {recursive: true, force: true}); }
}

test('Git inspection failure retains an otherwise merged branch', async () => repository(async (root, repo, git) => {
  git('branch', 'pi/merged');
  const realGit = execFileSync('which', ['git'], {encoding: 'utf8'}).trim();
  const bin = join(root, 'bin'); await mkdir(bin);
  const wrapper = join(bin, 'git');
  await writeFile(wrapper, `#!/bin/sh\ncase "$*" in *"worktree list"*) echo "injected inspection failure" >&2; exit 2;; esac\nexec '${realGit}' "$@"\n`);
  await chmod(wrapper, 0o755);
  const previous = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${previous}`;
    await assert.rejects(deleteMergedBranch(repo, 'pi/merged'), /injected inspection failure/);
  } finally { process.env.PATH = previous; }
  assert.ok(git('rev-parse', '--verify', 'refs/heads/pi/merged'));
}));

test('non-force deletion retains a merged branch when its upstream has not integrated it', async () => repository(async (root, repo, git) => {
  git('branch', 'upstream-base'); git('checkout', '-b', 'pi/worker');
  await writeFile(join(repo, 'worker'), 'change'); git('add', '.'); git('commit', '-m', 'worker');
  git('branch', '--set-upstream-to=upstream-base', 'pi/worker');
  git('checkout', 'main'); git('merge', '--no-ff', 'pi/worker', '-m', 'integrate');
  const result = await deleteMergedBranch(repo, 'pi/worker');
  assert.equal(result.deleted, false); assert.match(result.reason, /not .*merged/);
  assert.ok(git('rev-parse', '--verify', 'refs/heads/pi/worker'));
}));

test('repository aliases share abandoned-session branch protection', async () => repository(async (root, repo, git) => {
  git('branch', 'pi/shared'); const alias = join(root, 'alias'); await symlink(repo, alias);
  const dataDir = join(root, 'data'); await mkdir(dataDir);
  const entry = (id, path, outcome) => ({id, name: 'alias', repo: path, branch: 'pi/shared',
    worktree: join(root, `missing-${id}`), cwd: path, baseRef: git('rev-parse', 'HEAD'),
    status: 'stopped', createdAt: 1, lastActivity: 1, pendingQuestions: [], outcome});
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({counter: 2, mailbox: [], board: [],
    history: [entry('s1', repo, 'success_first'), entry('s2', alias, 'abandoned')]}));
  const c = new Coordinator(loadConfig({dataDir, workspaceRoot: join(root, 'workers'), autoClean: false}));
  await c.init();
  try {
    const result = await c.gc(); assert.equal(result.branches_deleted, 0);
    assert.equal(result.branches_retained.length, 1); assert.match(result.branches_retained[0].reason, /abandoned/);
    assert.ok(git('rev-parse', '--verify', 'refs/heads/pi/shared'));
  } finally { await c.stopAll(); }
}));
