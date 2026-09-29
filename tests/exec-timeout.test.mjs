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

async function waitForReady(path, execution) {
  let finished = false;
  execution.finally(() => { finished = true; });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(path, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert.equal(finished, false, 'command finished before its descendant ready handshake; check shell initialization');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('descendant did not complete its ready handshake within 2 seconds');
}

test('exec timeout kills shell descendants and resolves without waiting for their pipes', { timeout: 5000 }, async () => fixture(async (coord, dir) => {
  const start = Date.now();
  const execution = coord.exec('test', 'sleep 30 & pid=$!; printf ready; printf "%s" "$pid" > child.pid; wait', 500);
  let pid;
  try {
    pid = await waitForReady(join(dir, 'child.pid'), execution);
    const readyAt = Date.now();
    process.kill(pid, 0); // Prove the descendant was running before timeout.
    const result = await execution;
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - start < 2000, 'timeout must return promptly');
    assert.ok(Date.now() - readyAt < 1500, 'ready descendant must not keep result pipes open after timeout');
    assert.match(result.stdout, /ready/);
    let state = '';
    try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch {}
    assert.ok(state === '' || state.startsWith('Z'), `descendant still running: ${state}`);
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await execution;
  }
}));

test('exec bounds retained output while preserving exit status', async () => fixture(async coord => {
  const result = await coord.exec('test', `node -e 'process.stdout.write("x".repeat(300000));process.stderr.write("y".repeat(100000))'`, 3000);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.length, 200000);
  assert.equal(result.stderr.length, 50000);
}));

test('exec uses a non-login shell by default and inherits the daemon PATH', async () => fixture(async coord => {
  const command = `if shopt -q login_shell; then printf 'login'; else printf 'non-login'; fi; printf '\\n%s\\n' "$PATH"; node -p 'process.execPath'`;
  const result = await coord.exec('test', command, 3000);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  const [shell, inheritedPath, nodePath] = result.stdout.trimEnd().split('\n');
  assert.equal(shell, 'non-login');
  assert.equal(inheritedPath, process.env.PATH);
  assert.ok(nodePath?.length, 'node must remain discoverable from the daemon PATH');
}));

test('exec only starts a login shell when explicitly requested', async () => fixture(async coord => {
  const result = await coord.exec('test', `shopt -q login_shell && printf '\\nPI_EXEC_LOGIN=true\\n'`, 3000, true);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /(?:^|\n)PI_EXEC_LOGIN=true\n/);
}));
