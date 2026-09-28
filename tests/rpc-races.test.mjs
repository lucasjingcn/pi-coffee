// Race + terminal-I/O + start-guard coverage for PiRpcClient.
//
// Complements the coordinator-authored acceptance test
// (tests/rpc-lifecycle.test.mjs), which must not be modified.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PiRpcClient} from '../dist/rpc-client.js';

const bound = async (p, ms) =>
  Promise.race([
    p,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('too slow')), ms);
      t.unref();
    }),
  ]);

/**
 * Spawn a long-lived fake `pi --mode rpc` child, run `fn`, then always tear the
 * child down. Uses the real start() path so production stream/error wiring is
 * under test.
 */
async function withFake(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-rpc-race-'));
  const bin = join(dir, 'fake-pi');
  await writeFile(
    bin,
    '#!/usr/bin/env node\n' +
      `const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',(line)=>{
  const c=JSON.parse(line);
  if(c.type==='get_state')process.stdout.write(JSON.stringify({type:'response',id:c.id,success:true,data:{isStreaming:false}})+'\\n');
});
process.stdin.on('end',()=>process.exit(0));`,
    {mode: 0o755},
  );
  const c = new PiRpcClient({cwd: dir, piBin: bin});
  try {
    await c.start();
    await fn(c);
  } finally {
    try {
      if (c.pid) process.kill(c.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await c.stop().catch(() => {});
    await rm(dir, {recursive: true, force: true});
  }
}

// --- missed-settled-event race --------------------------------------------

test('waitForSettled captures agent_settled emitted during the getState probe', async () => {
  const c = new PiRpcClient({cwd: process.cwd()});
  c.proc = {};
  c.getState = async () => {
    // Simulates the authoritative probe racing with a settled event: the
    // event lands while get_state is in flight, then state reports a stale
    // isStreaming=true.
    c.emit('event', {type: 'agent_settled'});
    return {isStreaming: true};
  };
  await bound(c.waitForSettled(1000), 500);
  assert.equal(c.listenerCount('event'), 0, 'event listener cleaned up');
  assert.equal(c.waiters.size, 0, 'waiter cleaned up');
});

test('waitForSettled resolves on authoritative idle and cleans up', async () => {
  const c = new PiRpcClient({cwd: process.cwd()});
  c.proc = {};
  c.getState = async () => ({isStreaming: false});
  await bound(c.waitForSettled(1000), 500);
  assert.equal(c.listenerCount('event'), 0, 'event listener cleaned up');
  assert.equal(c.waiters.size, 0, 'waiter cleaned up');
});

test('waitForSettled timeout applies to the event wait, not the probe', async () => {
  const c = new PiRpcClient({cwd: process.cwd()});
  c.proc = {};
  c.getState = async () => {
    await new Promise((r) => setTimeout(r, 60));
    return {isStreaming: false};
  };
  // Probe outlives timeoutMs but confirms idle, so this must resolve.
  await bound(c.waitForSettled(20), 500);
  assert.equal(c.listenerCount('event'), 0, 'event listener cleaned up');
  assert.equal(c.waiters.size, 0, 'waiter cleaned up');
});

test('waitForSettled skips getState when already streaming and waits for event', async () => {
  const c = new PiRpcClient({cwd: process.cwd()});
  c.proc = {};
  let probed = false;
  c.getState = async () => {
    probed = true;
    return {isStreaming: true};
  };
  c.streaming = true;
  const wait = c.waitForSettled(1000);
  setTimeout(() => c.emit('event', {type: 'agent_settled'}), 10);
  await bound(wait, 500);
  assert.equal(probed, false, 'did not probe state while streaming');
  assert.equal(c.listenerCount('event'), 0, 'event listener cleaned up');
  assert.equal(c.waiters.size, 0, 'waiter cleaned up');
});

test('waitForSettled timeout tears down listener/timer/waiter', async () => {
  const c = new PiRpcClient({cwd: process.cwd()});
  c.proc = {};
  c.getState = async () => ({isStreaming: true});
  await assert.rejects(bound(c.waitForSettled(30), 500), /timed out/);
  assert.equal(c.listenerCount('event'), 0, 'event listener cleaned up');
  assert.equal(c.waiters.size, 0, 'waiter cleaned up');
});

// --- terminal I/O failures ------------------------------------------------

test('stdin error rejects pending commands and notifies exit consumers', {timeout: 8000}, async () => {
  await withFake(async (c) => {
    const childClosed = new Promise((resolve) => c.proc.once('close', resolve));
    const exited = new Promise((resolve) => c.once('exit', resolve));
    const pending = c.command({type: 'ignored'}, 5000);
    c.proc.stdin.emit('error', new Error('EPIPE'));
    await assert.rejects(bound(pending, 500), /EPIPE/);
    await bound(exited, 500);
    assert.equal(c.hasExited, true);
    await bound(childClosed, 1000);
  });
});

test('stdout error rejects pending event waits and notifies exit consumers', {timeout: 8000}, async () => {
  await withFake(async (c) => {
    const exited = new Promise((resolve) => c.once('exit', resolve));
    const waiting = c.waitForEvent('never', 5000);
    c.proc.stdout.emit('error', new Error('EIO'));
    await assert.rejects(bound(waiting, 500), /EIO/);
    await bound(exited, 500);
    assert.equal(c.hasExited, true);
  });
});

test('terminal error is emitted at most once even if pipes fail repeatedly', {timeout: 8000}, async () => {
  await withFake(async (c) => {
    let exits = 0;
    c.on('exit', () => exits++);
    c.proc.stdin.emit('error', new Error('EPIPE'));
    c.proc.stdout.emit('error', new Error('EIO'));
    c.proc.stdin.emit('error', new Error('EPIPE again'));
    assert.equal(exits, 1);
  });
});

// --- start guards ----------------------------------------------------------

test('start rejects a duplicate start to avoid orphan subprocesses', async () => {
  const c = new PiRpcClient({cwd: process.cwd()});
  c.proc = {}; // pretend a child is already running
  await assert.rejects(bound(c.start(), 500), /already started/);
});

test('start rejects after disposal', async () => {
  const c = new PiRpcClient({cwd: process.cwd()});
  await c.stop(); // marks the client disposed
  await assert.rejects(bound(c.start(), 500), /disposed/);
});
