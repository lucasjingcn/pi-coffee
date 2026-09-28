import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PiRpcClient} from '../dist/rpc-client.js';
async function fake(fn) {
 const dir=await mkdtemp(join(tmpdir(),'pi-rpc-test-'));const bin=join(dir,'fake-pi');
 await writeFile(bin,'#!/usr/bin/env node\n'+`const readline=require('node:readline');
 readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);
 if(c.type==='get_state')process.stdout.write(JSON.stringify({type:'response',id:c.id,success:true,data:{isStreaming:false}})+'\\n');
 if(c.type==='exit_now'){process.stdout.write(JSON.stringify({type:'response',id:c.id,success:true,data:{}})+'\\n');setTimeout(()=>process.exit(0),20);}
 });
 process.stdin.on('end',()=>process.exit(0));`,{mode:0o755});
 const c=new PiRpcClient({cwd:dir,piBin:bin});
 try{await c.start();await fn(c);}finally{await c.stop();await rm(dir,{recursive:true,force:true});}
}
const bound=async(p,ms)=>Promise.race([p,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('too slow')),ms);t.unref();})]);
test('missing executable fails promptly and becomes terminal',{timeout:3000},async()=>{
 const c=new PiRpcClient({cwd:tmpdir(),piBin:'/no/such/pi-test-bin'});
 try{await assert.rejects(bound(c.start(),1000),e=>!e.message.includes('too slow'));assert.equal(c.hasExited,true);}
 finally{await c.stop();}
});
test('commands after process exit reject immediately',{timeout:3000},async()=>fake(async(c)=>{
 const exit=new Promise(r=>c.once('exit',r));await c.command({type:'exit_now'});await exit;
 await assert.rejects(bound(c.command({type:'get_state'},2000),200),e=>!e.message.includes('too slow'));
}));
test('event wait rejects on process termination rather than hanging',{timeout:3000},async()=>fake(async(c)=>{
 const waiting=c.waitForEvent('never',2000);const rejected=assert.rejects(bound(waiting,500),e=>!e.message.includes('too slow'));
 await c.command({type:'exit_now'});await rejected;
}));
test('stop after exit and repeated stop are quick',{timeout:3000},async()=>fake(async(c)=>{
 const exit=new Promise(r=>c.once('exit',r));await c.command({type:'exit_now'});await exit;
 await bound(c.stop(),200);await bound(c.stop(),200);
}));
test('stop rejects pending commands and event waits',{timeout:3000},async()=>fake(async(c)=>{
 const command=c.command({type:'ignored'},2000);
 const event=c.waitForEvent('never',2000);
 const results=Promise.all([assert.rejects(bound(command,500),e=>!e.message.includes('too slow')),assert.rejects(bound(event,500),e=>!e.message.includes('too slow'))]);
 await c.stop();await results;
}));
test('duplicate in-flight command ids reject without losing original',{timeout:3000},async()=>fake(async(c)=>{
 const pending=c.command({type:'ignored',id:'duplicate'},1000);
 const p1=assert.rejects(pending,/timed out/);
 await assert.rejects(bound(c.command({type:'ignored',id:'duplicate'},1500),200),e=>!e.message.includes('too slow'));
 await p1;
}));
