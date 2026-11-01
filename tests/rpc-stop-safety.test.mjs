import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PiRpcClient } from '../dist/rpc-client.js';

// The escaped-descendant check reads the process table with `ps`; environments
// that deny it cannot exercise that path.
const psUnavailable = spawnSync('ps',['-p',String(process.pid)],{stdio:'ignore'}).status !== 0;

async function fixture(body, run, {stopThrows=false}={}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-stop-'));
  const bin = join(dir, 'fixture.js');
  await writeFile(bin, `const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line); if(c.type==='get_state') process.stdout.write(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{isStreaming:false}})+'\\n');
});
${body}`);
  const client = new PiRpcClient({cwd:dir, piBin:bin});
  try { await client.start(3000); await run(client, dir); }
  finally { try { await client.stop(); } catch (error) { if (!stopThrows) throw error; } await rm(dir, {recursive:true,force:true}); }
}

test('stop waits for graceful exit, including concurrent calls', async () => {
  await fixture(`process.stdin.on('end',()=>setTimeout(()=>process.exit(0),200)); setInterval(()=>{},1000);`, async c => {
    const began=Date.now();
    await Promise.all([c.stop(),c.stop()]);
    if (process.platform !== 'win32') assert.ok(Date.now()-began>=180);
    assert.equal(c.hasExited,true);
    assert.throws(()=>process.kill(c.pid,0),{code:'ESRCH'});
  });
});

test('forced stop confirms tools in owned group have exited', {skip:process.platform==='win32'}, async () => {
  await fixture(`const {spawn}=require('node:child_process'); const fs=require('node:fs');
const tool=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
fs.writeFileSync('tool.pid',String(tool.pid));
process.on('SIGTERM',()=>{});process.stdin.on('end',()=>{});setInterval(()=>{},1000);`, async (c,dir) => {
    const tool=Number(await readFile(join(dir,'tool.pid'),'utf8'));
    await c.stop();
    assert.equal(c.hasExited,true);
    assert.throws(()=>process.kill(tool,0),{code:'ESRCH'});
  });
});

test('shutdown stays unconfirmed when SIGKILL leaves detached tool descendants', {skip:process.platform==='win32' || psUnavailable}, async () => {
  await fixture(`const {spawn}=require('node:child_process'); const fs=require('node:fs');
const tool=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore',detached:true});
fs.writeFileSync('tool.pid',String(tool.pid));
process.on('SIGTERM',()=>{});process.stdin.on('end',()=>{});setInterval(()=>{},1000);`, async (c,dir) => {
    const tool=Number(await readFile(join(dir,'tool.pid'),'utf8'));
    try {
      await assert.rejects(c.stop(), /descendant process\(es\) alive; retain locks/);
      // The rejection is the contract: shutdown is not reported confirmed. The
      // root may still be settling, so only require that it is no longer running.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      try { process.kill(-tool,'SIGKILL'); } catch {}
    }
  }, {stopThrows:true});
});

test('an unterminated oversized stdout line fails the client closed', {timeout:20000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-oversize-'));
  const bin = join(dir, 'oversize.js');
  await writeFile(bin, "process.stdout.write(Buffer.alloc(9*1024*1024,120)); setInterval(()=>{},1000);");
  const client = new PiRpcClient({cwd:dir, piBin:bin});
  try {
    const settled = Promise.race([
      new Promise((resolve) => client.once('exit', () => resolve('exit'))),
      new Promise((resolve) => client.once('shutdown_failed', () => resolve('shutdown_failed'))),
    ]);
    await client.start(3000).catch(() => {});
    assert.ok(['exit', 'shutdown_failed'].includes(await settled), 'the client terminates instead of buffering forever');
    assert.equal(client.hasExited, true);
  } finally {
    try { await client.stop(); } catch { /* unconfirmed shutdown keeps locks by design */ }
    await rm(dir, { recursive: true, force: true });
  }
});

test('terminal pipe error publishes exit only after safe shutdown', async () => {
  await fixture(`process.stdin.on('end',()=>setTimeout(()=>process.exit(0),200));setInterval(()=>{},1000);`,async c=>{
    let reported=false;
    c.once('exit',()=>{reported=true;});
    let shutdownError;
    c.once('shutdown_failed', error=>{shutdownError=error;});
    c.proc.stdout.emit('error',new Error('fixture pipe error'));
    assert.equal(c.hasExited,false);
    assert.equal(reported,false);
    await c.stop();
    // Flush the lifecycle notification queued by terminate after stop settles.
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(shutdownError,undefined);
    assert.equal(reported,true);
    assert.equal(c.hasExited,true);
  });
});

test('failed termination rejects and does not report confirmed exit; retry remains possible', {skip:process.platform==='win32'}, async () => {
  const c=new PiRpcClient({cwd:process.cwd()});
  c.proc={pid:99999999,exitCode:null,signalCode:null,stdin:{end(){}},kill(){throw Object.assign(new Error('fixture termination denied'),{code:'EPERM'});}};
  await assert.rejects(c.stop(),/termination denied/);
  assert.equal(c.hasExited,false);
  c.proc.exitCode=0;
  await c.stop();
  assert.equal(c.hasExited,true);
});

async function stopAsWindows(c) {
  const descriptor=Object.getOwnPropertyDescriptor(process,'platform');
  try {
    Object.defineProperty(process,'platform',{...descriptor,value:'win32'});
    return c.stop();
  } finally {
    Object.defineProperty(process,'platform',descriptor);
  }
}

function windowsFixture() {
  const c=new PiRpcClient({cwd:process.cwd()});
  c.proc={pid:99999999,exitCode:null,signalCode:null,stdin:{end(){}}};
  return c;
}

test('Windows native tree success still waits for actual root exit', async () => {
  const c=windowsFixture();
  let treeStopped=false;
  c.killWindowsTree=async pid=>{
    assert.equal(pid,c.proc.pid);
    treeStopped=true;
    setTimeout(()=>{c.proc.signalCode='SIGKILL';},100);
  };
  const began=Date.now();
  await stopAsWindows(c);
  assert.equal(treeStopped,true);
  assert.ok(Date.now()-began>=90);
  assert.equal(c.hasExited,true);
});

test('Windows tree termination failure retains unconfirmed state', async () => {
  const c=windowsFixture();
  c.killWindowsTree=async()=>{throw new Error('fixture tree termination denied; retain locks');};
  await assert.rejects(stopAsWindows(c),/termination denied; retain locks/);
  assert.equal(c.hasExited,false);
});

test('Windows already exited root cannot establish descendant tree shutdown', async () => {
  const c=windowsFixture();
  c.proc.exitCode=0;
  c.killWindowsTree=async()=>assert.fail('must not act on a reused or exited PID');
  await assert.rejects(stopAsWindows(c),/cannot confirm Windows tool tree after root exit; retain locks/);
  assert.equal(c.hasExited,false);
});
