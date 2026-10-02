import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../dist/manager.js';
import { loadConfig } from '../dist/config.js';

async function fixture(fn) {
 const root=await mkdtemp(join(tmpdir(),'pi-handoff-'));
 const c=new Coordinator(loadConfig({dataDir:root,workspaceRoot:join(root,'workers'),autoClean:false,
   workerWarnMs:100,workerStallMs:500,workerIdleMs:1000}));await c.init();
 const client=new EventEmitter();client.isStreaming=true;client.hasExited=false;
 client.stop=async()=>{client.hasExited=true;};client.getState=async()=>{throw Error('offline');};
 const meta={id:'s1',name:'task',repo:'/missing',worktree:'/missing/s1',branch:'pi/s1',cwd:'/missing',baseRef:'HEAD',
  status:'working',createdAt:Date.now(),lastActivity:Date.now(),pendingQuestions:[],spec:{purpose:'investigation',goal:'investigate',scope:['src']}};
 const rt={meta,client,repoIdentity:'repo',lastNotifiedQuestionIds:new Set()};c.runtimes.set('s1',rt);c.claim('s1',['src'],'rw');c.wireEvents(rt);
 try {await fn(c,rt,client);}finally{client.stop=async()=>{client.hasExited=true;};await c.stopAll();await rm(root,{recursive:true,force:true});}
}

test('no model progress warns and wakes main agent, then stops before releasing locks',()=>fixture(async(c,rt,client)=>{
 client.emit('event',{type:'agent_start'});const start=rt.lastProgressAt;
 await c.checkWorkerHealth(start+101);
 assert.equal(rt.meta.handoff.kind,'provider_wait');assert.equal(rt.meta.handoff.safeToTakeOver,false);
 assert.equal(c.locksList().length,1);
 const res=await c.wait(['s1'],'question',1000);assert.equal(res.timedOut,false);
 let heldWhileStopping=false;client.stop=async()=>{heldWhileStopping=c.locksList().length===1;client.hasExited=true;};
 await c.checkWorkerHealth(start+501);
 assert.equal(heldWhileStopping,true);assert.equal(rt.meta.status,'stopped');assert.equal(c.locksList().length,0);
 assert.equal(rt.meta.handoff.kind,'provider_timeout');assert.equal(rt.meta.handoff.safeToTakeOver,true);
 assert.equal(rt.meta.outcome,undefined);
}));

test('stop failure retains locks, revokes writes and publishes unsafe handoff',()=>fixture(async(c,rt,client)=>{
 client.emit('event',{type:'agent_start'});client.stop=async()=>{throw Error('cannot confirm exit');};
 await c.checkWorkerHealth(rt.lastProgressAt+501);
 assert.equal(c.locksList().length,1);assert.equal(rt.meta.handoff.kind,'shutdown_failed');
 assert.equal(rt.meta.handoff.safeToTakeOver,false);assert.equal(rt.meta.status,'error');
 await assert.rejects(c.send('s1','continue'),/shutdown is unconfirmed/);
}));

test('local tools and owner questions are not mistaken for provider stalls; real deltas reset deadline',()=>fixture(async(c,rt,client)=>{
 client.emit('event',{type:'agent_start'});const start=rt.lastProgressAt;
 client.emit('event',{type:'tool_execution_start',toolCallId:'t1'});
 await c.checkWorkerHealth(start+10000);assert.equal(rt.meta.handoff,undefined);
 client.emit('event',{type:'tool_execution_end',toolCallId:'t1'});
 client.emit('event',{type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'work'}});
 await c.checkWorkerHealth(rt.lastProgressAt+50);assert.equal(rt.meta.handoff,undefined);
 rt.meta.pendingQuestions=[{id:'q',method:'confirm'}];await c.checkWorkerHealth(rt.lastProgressAt+10000);
 assert.equal(rt.meta.status,'working');assert.equal(c.locksList().length,1);
}));

test('provider failure is terminal only after retries settle, preserves report and does not claim success',()=>fixture(async(c,rt,client)=>{
 rt.meta.lastText='prior findings';client.emit('event',{type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'secret diagnostic'}});
 client.emit('event',{type:'auto_retry_start'});assert.equal(rt.meta.status,'working');assert.equal(c.locksList().length,1);
 client.emit('event',{type:'message_end',message:{role:'assistant',stopReason:'error'}});
 client.emit('event',{type:'agent_settled'});await new Promise(r=>setImmediate(r));
 assert.equal(rt.meta.handoff.kind,'provider_error');assert.equal(rt.meta.status,'stopped');assert.equal(c.locksList().length,0);
 assert.equal(rt.meta.lastText,'prior findings');assert.equal(rt.meta.outcome,undefined);
 assert.equal(JSON.stringify(rt.meta.handoff).includes('secret'),false);
}));

test('completed investigation asks for acceptance; abandoned ownership expires safely with files retained',()=>fixture(async(c,rt,client)=>{
 client.isStreaming=false;rt.meta.lastText='delivered investigation';client.emit('event',{type:'agent_settled'});
 assert.equal(rt.meta.handoff.kind,'awaiting_acceptance');assert.equal(c.locksList().length,1);
 await c.checkWorkerHealth(rt.meta.lastActivity+1001);
 assert.equal(rt.meta.status,'stopped');assert.equal(rt.meta.handoff.kind,'owner_timeout');
 assert.equal(rt.meta.outcome,undefined);assert.equal(rt.meta.worktree,'/missing/s1');
}));

test('background watchdog notifies the waiting owner even with auto cleanup disabled',()=>fixture(async(c,rt,client)=>{
 c.config.workerStallMs=10000;
 client.emit('event',{type:'agent_start'});
 const result=await c.wait(['s1'],'question',2000);
 assert.equal(result.timedOut,false);assert.equal(result.sessions[0].handoff.kind,'provider_wait');
 assert.equal(result.sessions[0].handoff.safeToTakeOver,false);assert.equal(c.locksList().length,1);
}));
