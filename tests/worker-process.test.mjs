import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {captureWorkerProcess,stopOwnedWorker} from '../dist/worker-process.js';
const posix={skip:process.platform==='win32'};
async function child(code='setInterval(()=>{},1000)') {
  const p=spawn(process.execPath,['-e',code],{detached:true,stdio:['ignore','pipe','ignore']});
  await new Promise((resolve,reject)=>{p.once('spawn',resolve);p.once('error',reject);});
  return p;
}
async function cleanup(p) {
  try { process.kill(-p.pid,'SIGKILL'); } catch {}
  if(p.exitCode===null&&p.signalCode===null) await new Promise(resolve=>p.once('exit',resolve));
}
test('persisted identity safely stops owned worker after coordinator restart',posix,async()=>{
  const p=await child();
  try {
    const persisted=JSON.parse(JSON.stringify(await captureWorkerProcess(p.pid)));
    await stopOwnedWorker(persisted);
    assert.throws(()=>process.kill(-p.pid,0),{code:'ESRCH'});
  } finally {await cleanup(p);}
});
test('wrong start fingerprint refuses to signal live root',posix,async()=>{
  const p=await child();
  try {
    const identity=await captureWorkerProcess(p.pid);
    identity.started+=' wrong';
    await assert.rejects(stopOwnedWorker(identity),/ownership; retain locks/);
    process.kill(p.pid,0);
    assert.equal(p.signalCode,null);
  } finally {await cleanup(p);}
});
test('already absent owned group needs no signal',posix,async()=>{
  const p=await child();
  const identity=await captureWorkerProcess(p.pid);
  await cleanup(p);
  await stopOwnedWorker(identity);
});
test('root absent but descendants still alive refuses automatic recovery',posix,async()=>{
  const p=await child(`const {spawn}=require('node:child_process');
const tool=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
console.log(tool.pid);setTimeout(()=>process.exit(0),250);`);
  try {
    const toolPid=await new Promise(resolve=>p.stdout.once('data',b=>resolve(Number(b.toString().trim()))));
    const identity=await captureWorkerProcess(p.pid);
    await new Promise(resolve=>p.once('exit',resolve));
    await assert.rejects(stopOwnedWorker(identity),/ownership; retain locks/);
    process.kill(toolPid,0);
  } finally {await cleanup(p);}
});
test('invalid identities and different platforms fail closed',async()=>{
  for(const pid of [0,1,-1,NaN,1.5,Number.MAX_SAFE_INTEGER+1]) {
    await assert.rejects(stopOwnedWorker({pid,platform:process.platform,started:'valid'}),/invalid/);
  }
  await assert.rejects(stopOwnedWorker({pid:100,platform:'different',started:'valid'}),/platform differs/);
});
test('recovery forces termination when owned root ignores TERM',posix,async()=>{
  const p=await child("process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)");
  try {
    await new Promise(resolve=>p.stdout.once('data',resolve));
    const identity=await captureWorkerProcess(p.pid);
    await stopOwnedWorker(identity);
    assert.throws(()=>process.kill(-p.pid,0),{code:'ESRCH'});
  } finally {await cleanup(p);}
});
