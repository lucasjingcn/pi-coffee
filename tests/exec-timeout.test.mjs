import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../dist/manager.js';
import { loadConfig } from '../dist/config.js';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-exec-test-'));
  const coord = new Coordinator(loadConfig());
  coord.runtimes.set('test', { meta: { worktree: dir } });
  try { await fn(coord, dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('exec timeout kills shell descendants and resolves without waiting for their pipes', { timeout: 5000 }, async () => fixture(async (coord, dir) => {
  const start = Date.now();
  const result = await coord.exec('test', 'sleep 30 & pid=$!; printf "%s" "$pid" > child.pid; printf ready; wait', 500);
  const pid = Number(await readFile(join(dir, 'child.pid'), 'utf8'));
  try {
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - start < 2000, 'timeout must return promptly');
    assert.match(result.stdout, /ready/);
    let state = '';
    try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch {}
    assert.ok(state === '' || state.startsWith('Z'), `descendant still running: ${state}`);
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}));

test('exec bounds retained output while preserving exit status', async () => fixture(async coord => {
  const result = await coord.exec('test', `node -e 'process.stdout.write("x".repeat(300000));process.stderr.write("y".repeat(100000))'`, 3000);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.length, 200000);
  assert.equal(result.stderr.length, 50000);
}));
