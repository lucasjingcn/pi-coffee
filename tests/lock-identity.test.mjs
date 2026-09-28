import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRepoIdentity } from '../dist/lock-repo.js';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-lock-identity-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('separate git dir whose path ends in a space preserves identity characters', async () =>
  fixture(async (dir) => {
    const worktree = join(dir, 'wt');
    const gitDir = join(dir, 'gitdir '); // trailing space must survive
    await mkdir(worktree);
    execFileSync('git', ['init', '--separate-git-dir', gitDir, worktree], { stdio: 'ignore' });
    assert.equal(resolveRepoIdentity(worktree), realpathSync(gitDir));
  }));

test('git dir containing a newline preserves identity characters', async (t) =>
  fixture(async (dir) => {
    const worktree = join(dir, 'wt');
    const gitDir = join(dir, 'gitdir\nnl');
    await mkdir(worktree);
    try {
      execFileSync('git', ['init', '--separate-git-dir', gitDir, worktree], { stdio: 'ignore' });
    } catch {
      t.skip('git does not support a newline in the git dir path');
      return;
    }
    assert.equal(resolveRepoIdentity(worktree), realpathSync(gitDir));
  }));
