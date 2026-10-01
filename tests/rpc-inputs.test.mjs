// Input-hardening coverage for PiRpcClient.
//
// Exercises the stdout JSONL parser, correlated-response validation,
// single-use request ids and bounded startup against real child processes
// (fake `pi --mode rpc` binaries).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

/** Write a fake `pi --mode rpc` binary whose per-line handler body is `body`. */
async function makeFakePi(body = '', prelude = '') {
  const dir = await mkdtemp(join(tmpdir(), 'pi-rpc-inputs-'));
  const bin = join(dir, 'fake-pi');
  await writeFile(
    bin,
    '#!/usr/bin/env node\n' +
      prelude +
      `const readline=require('node:readline');
const send=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
readline.createInterface({input:process.stdin}).on('line',(line)=>{
  let c;
  try{c=JSON.parse(line);}catch{return;}
  ${body}
});
process.stdin.on('end',()=>process.exit(0));`,
    {mode: 0o755},
  );
  return {dir, bin};
}

/** Start a client against a fake child, run `fn`, then always tear down. */
async function withClient(body, fn, {startTimeoutMs = 5000} = {}) {
  const {dir, bin} = await makeFakePi(body);
  const c = new PiRpcClient({cwd: dir, piBin: bin});
  try {
    await c.start(startTimeoutMs);
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

/** Handler that answers every command, echoing the request type and id. */
const ECHO = `send({type:'response',id:c.id,command:c.type,success:true,data:{id:c.id,type:c.type}});`;

// --- malformed JSONL records ----------------------------------------------

test('malformed JSONL records are ignored and later frames still process', {timeout: 8000}, async () => {
  await withClient(
    `if(c.type==='noise'){
      process.stdout.write('not json at all\\n');
      process.stdout.write('null\\n');
      process.stdout.write('[]\\n');
      process.stdout.write('42\\n');
      process.stdout.write('"str"\\n');
      process.stdout.write('true\\n');
      process.stdout.write('{}\\n');
      process.stdout.write('{"type":42}\\n');
      process.stdout.write('{"type":null}\\n');
      process.stdout.write('{"type":""}\\n');
      process.stdout.write('{"type":"response"}\\n');
      process.stdout.write('{"type":"response","id":0,"success":true}\\n');
      process.stdout.write('{"type":"response","id":"missing","success":"nope"}\\n');
      process.stdout.write('   \\n');
      send({type:'response',id:c.id,command:c.type,success:true,data:{ok:true}});
      return;
    }
    ${ECHO}`,
    async (c) => {
      const events = [];
      c.on('event', (e) => events.push(e));
      const r = await bound(c.command({type: 'noise'}, 2000), 1500);
      assert.equal(r.success, true);
      assert.deepEqual(r.data, {ok: true});
      assert.deepEqual(events, [], 'malformed records must not be emitted as events');
      assert.equal(c.pending.size, 0);
    },
  );
});

// --- malformed correlated responses ---------------------------------------

test('malformed correlated responses reject instead of resolving', {timeout: 8000}, async () => {
  await withClient(
    `if(c.type==='bad_success_missing'){send({type:'response',id:c.id,command:c.type,data:{}});return;}
     if(c.type==='bad_success_string'){send({type:'response',id:c.id,command:c.type,success:'true',data:{}});return;}
     if(c.type==='bad_success_number'){send({type:'response',id:c.id,command:c.type,success:1,data:{}});return;}
     if(c.type==='bad_command'){send({type:'response',id:c.id,command:'other',success:true,data:{}});return;}
     if(c.type==='bad_command_nonstring'){send({type:'response',id:c.id,command:7,success:true,data:{}});return;}
     if(c.type==='no_command'){send({type:'response',id:c.id,success:true,data:{ok:1}});return;}
     if(c.type==='late_valid'){send({type:'response',id:c.id,data:{}});send({type:'response',id:c.id,success:true,data:{late:true}});return;}
     ${ECHO}`,
    async (c) => {
      for (const type of ['bad_success_missing', 'bad_success_string', 'bad_success_number']) {
        await assert.rejects(bound(c.command({type}, 1000), 1000), /malformed response.*success must be boolean/);
      }
      for (const type of ['bad_command', 'bad_command_nonstring']) {
        await assert.rejects(bound(c.command({type}, 1000), 1000), /malformed response.*does not match/);
      }

      // Missing `command` stays compatible with minimal fixtures.
      const ok = await bound(c.command({type: 'no_command'}, 1000), 1000);
      assert.equal(ok.success, true);
      assert.deepEqual(ok.data, {ok: 1});

      // The malformed frame settles the command; the valid late frame for the
      // same id must neither resolve it nor wedge the client.
      await assert.rejects(bound(c.command({type: 'late_valid'}, 1000), 1000), /malformed response/);
      const after = await bound(c.command({type: 'get_state'}, 1000), 1000);
      assert.equal(after.success, true);
      assert.equal(c.pending.size, 0);
    },
  );
});

// --- request ids -----------------------------------------------------------

test('invalid explicit ids reject immediately without reaching the child', {timeout: 8000}, async () => {
  // Validation is independent of process state: a fresh client still rejects.
  const fresh = new PiRpcClient({cwd: tmpdir(), piBin: '/no/such/pi-test-bin'});
  await assert.rejects(bound(fresh.command({type: 'probe', id: 0}, 1000), 300), /invalid command id/);
  await assert.rejects(bound(fresh.command({type: 'probe', id: null}, 1000), 300), /invalid command id/);

  await withClient(
    `if(c.type==='record'){process.stderr.write('SEEN '+JSON.stringify(c.id)+'\\n');send({type:'response',id:c.id,command:c.type,success:true,data:{id:c.id}});return;}
     ${ECHO}`,
    async (c) => {
      let seen = '';
      c.proc.stderr.on('data', (d) => (seen += d.toString('utf8')));

      const t0 = Date.now();
      for (const bad of [0, 1, -1, '', null, false, {}, []]) {
        await assert.rejects(bound(c.command({type: 'record', id: bad}, 1000), 300), /invalid command id/);
      }
      assert.ok(Date.now() - t0 < 1000, 'invalid ids must reject immediately');

      await sleep(100);
      assert.equal(seen, '', 'invalid ids must never be written to the child');
      assert.equal(c.pending.size, 0);
    },
  );
});

test('duplicate in-flight ids keep the historical diagnostic and stay single-use', {timeout: 8000}, async () => {
  await withClient(
    `if(c.type==='slow'){return;}
     ${ECHO}`,
    async (c) => {
      const first = c.command({type: 'slow', id: 'dup'}, 300);
      await assert.rejects(bound(c.command({type: 'slow', id: 'dup'}, 1000), 300), /duplicate in-flight command id 'dup'/);
      await assert.rejects(bound(first, 1000), /timed out/);
      // A settled/timed-out id is never reusable.
      await assert.rejects(bound(c.command({type: 'slow', id: 'dup'}, 1000), 300), /already been used/);
    },
  );
});

test('a late response for a settled id cannot resolve reused work', {timeout: 8000}, async () => {
  await withClient(
    `if(c.type==='slow'){return;}
     if(c.type==='late'){
       send({type:'response',id:'settled-1',command:'slow',success:true,data:{late:true}});
       send({type:'response',id:c.id,command:c.type,success:true,data:{id:c.id,type:c.type}});
       return;
     }
     ${ECHO}`,
    async (c) => {
      await assert.rejects(bound(c.command({type: 'slow', id: 'settled-1'}, 250), 1200), /timed out/);
      await assert.rejects(bound(c.command({type: 'slow', id: 'settled-1'}, 1000), 300), /already been used/);

      // Trigger the late frame for the settled id, then prove the client is
      // still healthy and nothing was resolved by that stale response.
      const r = await bound(c.command({type: 'late'}, 1000), 1000);
      assert.equal(r.success, true);
      assert.equal(r.data.type, 'late');
      assert.notEqual(r.data.id, 'settled-1', 'stale response must not settle new work');
      const after = await bound(c.command({type: 'get_state'}, 1000), 1000);
      assert.equal(after.success, true);
      assert.equal(c.pending.size, 0);
    },
  );
});

test('auto ids skip explicit ids already issued', {timeout: 8000}, async () => {
  await withClient(ECHO, async (c) => {
    // startup's get_state already consumed auto id `c1`.
    const explicit = await bound(c.command({type: 'probe', id: 'c2'}, 1000), 1000);
    assert.equal(explicit.data.id, 'c2');

    const auto1 = await bound(c.command({type: 'probe'}, 1000), 1000);
    assert.equal(auto1.data.id, 'c3', 'auto id must skip the used explicit id');
    const auto2 = await bound(c.command({type: 'probe'}, 1000), 1000);
    assert.equal(auto2.data.id, 'c4');

    // Auto-issued ids are themselves single-use.
    await assert.rejects(bound(c.command({type: 'probe', id: 'c3'}, 1000), 300), /already been used/);
    assert.equal(c.pending.size, 0);
  });
});

// --- startup failure -------------------------------------------------------

test('invalid startup budgets reject before spawning a process', {timeout: 8000}, async () => {
  const marker = join(tmpdir(), `pi-rpc-inputs-spawn-${process.pid}-${Date.now()}`);
  const {dir, bin} = await makeFakePi(
    ECHO,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned');\n`,
  );
  const c = new PiRpcClient({cwd: dir, piBin: bin});
  try {
    for (const bad of [NaN, Infinity, -Infinity, 0, -0, -1, -0.001, '1000', null, true, {}]) {
      await assert.rejects(bound(c.start(bad), 300), /invalid start timeout/);
      assert.equal(c.proc, null, `no child for budget ${String(bad)}`);
      assert.equal(c.pid, undefined, `no pid for budget ${String(bad)}`);
    }
    assert.equal(existsSync(marker), false, 'no child process was ever spawned');

    // The rejections leave the client startable; the marker proves the
    // fixture would have recorded a real spawn.
    await c.start(5000);
    await waitFor(() => existsSync(marker), 2000);
    assert.equal(c.hasExited, false);
  } finally {
    await c.stop().catch(() => {});
    await rm(dir, {recursive: true, force: true});
  }
});

test('failed start kills an unresponsive child, clears pending work, and respects its deadline', {timeout: 8000}, async () => {
  const {dir, bin} = await makeFakePi(''); // never answers get_state
  const c = new PiRpcClient({cwd: dir, piBin: bin});
  try {
    const t0 = Date.now();
    const start = c.start(150);
    // Work accepted while startup is still probing must be cleared on failure.
    const duringStart = c.command({type: 'slow', id: 'during-start'}, 5000);
    const duringStartRejected = assert.rejects(bound(duringStart, 2500), /did not become ready/);

    await assert.rejects(bound(start, 2500), /did not become ready/);
    await duringStartRejected;

    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `start respected its deadline (took ${elapsed}ms)`);
    assert.equal(c.hasExited, true, 'failed start is terminal');
    assert.equal(c.pending.size, 0, 'pending work was cleared');

    const pid = c.pid;
    assert.ok(pid, 'child was spawned');
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 2000);
  } finally {
    await c.stop().catch(() => {});
    await rm(dir, {recursive: true, force: true});
  }
});

test('a child that exits during startup fails start promptly and stays terminal', {timeout: 8000}, async () => {
  const {dir, bin} = await makeFakePi('process.exit(3);');
  const c = new PiRpcClient({cwd: dir, piBin: bin});
  try {
    await assert.rejects(bound(c.start(2000), 2500), /did not become ready/);
    assert.equal(c.hasExited, true);
    assert.equal(c.pending.size, 0);
  } finally {
    await c.stop().catch(() => {});
    await rm(dir, {recursive: true, force: true});
  }
});
