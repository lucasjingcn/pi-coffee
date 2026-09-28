import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {mergeBranch} from '../dist/worktree.js';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-git-conflicts-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8'});
  try {
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.com');
    await writeFile(join(dir, 'tracked.txt'), 'base\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    await fn(dir, git);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

test('merge conflict paths are exact for unicode/space/newline filenames', async () =>
  fixture(async (dir, git) => {
    const into = git('branch', '--show-current').trim();
    const name = ' 空 格\nfile.txt ';

    await writeFile(join(dir, name), 'base\n');
    git('add', '-A');
    git('commit', '-qm', 'add special filename');

    git('checkout', '-qb', 'worker');
    await writeFile(join(dir, name), 'worker\n');
    git('add', '-A');
    git('commit', '-qm', 'worker edit');

    git('checkout', into);
    await writeFile(join(dir, name), 'main\n');
    git('add', '-A');
    git('commit', '-qm', 'main edit');

    const result = await mergeBranch(dir, 'worker', into);

    assert.equal(result.ok, false);
    // Exact, unquoted and untrimmed: leading/trailing spaces and the embedded
    // newline must all survive the porcelain parse.
    assert.deepEqual(result.conflicts, [name]);
  }));

test('merge conflict paths coexist with ordinary modified paths', async () =>
  fixture(async (dir, git) => {
    const into = git('branch', '--show-current').trim();
    const name = ' 空 格\nfile.txt ';
    const other = 'plain conflict.txt';

    for (const file of [name, other]) {
      await writeFile(join(dir, file), 'base\n');
    }
    git('add', '-A');
    git('commit', '-qm', 'add files');

    git('checkout', '-qb', 'worker');
    for (const file of [name, other]) {
      await writeFile(join(dir, file), 'worker\n');
    }
    await writeFile(join(dir, 'worker-only.txt'), 'worker only\n');
    git('add', '-A');
    git('commit', '-qm', 'worker edits');

    git('checkout', into);
    for (const file of [name, other]) {
      await writeFile(join(dir, file), 'main\n');
    }
    git('add', '-A');
    git('commit', '-qm', 'main edits');

    const result = await mergeBranch(dir, 'worker', into);

    assert.equal(result.ok, false);
    assert.deepEqual(new Set(result.conflicts), new Set([name, other]));
    assert.equal(result.conflicts.length, 2);
  }));
