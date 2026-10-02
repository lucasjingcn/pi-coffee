import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../dist/manager.js';
import { loadConfig } from '../dist/config.js';
import { captureWorkerProcess } from '../dist/worker-process.js';
async function fixture(identity,fn){
 const root=await mkdtemp(join(tmpdir(),'pi-restart-safe-'));const data=join(root,'data');await mkdir(data);
 const meta={id:'s1',name:'preserved',status:'working',createdAt:1,lastActivity:1,repo:root,worktree:join(root,'worktree'),branch:'pi/s1',cwd:root,baseRef:'HEAD',pendingQuestions:[],lastText:'existing report',shutdownUnconfirmed:true,lockRepoIdentity:'repo-identity',workerProcess:identity,spec:{goal:'finish work',scope:['src'],purpose:'implementation'},heldLocks:[{path:'/src',mode:'rw',sessionId:'s1',ts:1,repo:'repo-identity'}]};
 await mkdir(meta.worktree);await writeFile(join(meta.worktree,'result.txt'),'unfinished work');
 await writeFile(join(data,'state.json'),JSON.stringify({counter:1,history:[meta]}));
 const c=new Coordinator(loadConfig({dataDir:data,workspaceRoot:join(root,'workers'),autoClean:false}));
 try{await c.init();await fn(c,meta);}finally{await c.stopAll().catch(()=>{});await rm(root,{recursive:true,force:true});}
}
test('daemon recovery stops proven old process group before releasing scope, preserves output', {skip:process.platform==='win32'},async()=>{
 const proc=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await once(proc,'spawn');
 const exit=once(proc,'exit');const identity=await captureWorkerProcess(proc.pid);
 try{await fixture(identity,async(c,meta)=>{
  assert.equal(c.locksList().length,0);assert.equal(c.snapshot('s1').status,'stopped');assert.equal(c.snapshot('s1').handoff.safeToTakeOver,true);
  assert.equal(c.snapshot('s1').shutdownUnconfirmed,false);assert.equal(c.snapshot('s1').lastText,'existing report');
  assert.equal(await readFile(join(meta.worktree,'result.txt'),'utf8'),'unfinished work');
 });}finally{if(proc.exitCode===null&&proc.signalCode===null)process.kill(-proc.pid,'SIGKILL');await exit;}
});
test('missing startup ownership proof restores locks and blocks unsafe release and false outcomes',async()=>fixture(undefined,async(c,meta)=>{
 assert.equal(c.activeWorkers(),1);assert.equal(c.snapshot('s1').handoff.safeToTakeOver,false);assert.equal(c.locksList()[0].sessionId,'s1');
 await assert.rejects(c.stop('s1'),/ownership proof/);
 assert.throws(()=>c.releaseLocks('s1'),/unconfirmed/);
 await assert.rejects(c.setOutcome('s1','abandoned'),/unconfirmed/);
 await c.flush();assert.equal(await readFile(join(meta.worktree,'result.txt'),'utf8'),'unfinished work');
}));
test('reused process fingerprint does not kill unrelated process or release old scope', {skip:process.platform==='win32'},async()=>{
 const proc=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await once(proc,'spawn');const exit=once(proc,'exit');
 try{await fixture({...await captureWorkerProcess(proc.pid),started:'wrong fingerprint'},async(c)=>{
  assert.equal(c.locksList().length,1);assert.equal(c.snapshot('s1').handoff.kind,'shutdown_failed');
  assert.doesNotThrow(()=>process.kill(proc.pid,0));await assert.rejects(c.stop('s1'),/ownership/);
 });}finally{process.kill(-proc.pid,'SIGKILL');await exit;}
});
