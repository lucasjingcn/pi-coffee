import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Coordinator} from '../dist/manager.js';
import {loadConfig} from '../dist/config.js';
import {PiRpcClient} from '../dist/rpc-client.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
PiRpcClient.prototype.start=async function(){};
PiRpcClient.prototype.stop=async function(){};
PiRpcClient.prototype.prompt=async function(){return {success:true};};
PiRpcClient.prototype.getState=async function(){return {isStreaming:false};};
PiRpcClient.prototype.getSessionStats=async function(){return {cost:0,tokens:{}};};
async function fixture(fn,maxSessions=4){
 const dir=await mkdtemp(join(tmpdir(),'pi-manager-test-'));const repo=join(dir,'repo');await mkdir(repo);
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'});
 git('init','-q');git('config','user.name','test');git('config','user.email','test@example.com');await writeFile(join(repo,'base.txt'),'base');git('add','-A');git('commit','-qm','init');
 const config=loadConfig({dataDir:join(dir,'data'),workspaceRoot:join(dir,'worktrees'),defaultRepo:repo,maxSessions,autoClean:false});
 const c=new Coordinator(config);await c.init();
 try{await fn(c,config,git);}finally{await c.stopAll();await delay(650);await rm(dir,{recursive:true,force:true});}
}
test('parallel spawns respect concurrency cap before worktree creation',async()=>fixture(async(c)=>{
 const results=await Promise.allSettled([c.spawn({spec:{goal:'one',scope:['a']}}),c.spawn({spec:{goal:'two',scope:['b']}})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(c.list().filter(s=>s.status==='idle').length,1);
},1));
test('restart clears locks belonging to workers that cannot survive daemon restart',async()=>fixture(async(c,config)=>{
 const s=await c.spawn({spec:{goal:'one',scope:['a']},acceptanceFiles:[{path:'tests/one',content:'test'}]});
 c.claim(s.id,['extra'],'rw');await delay(650);
 const restarted=new Coordinator(config);await restarted.init();
 try{assert.deepEqual(restarted.locksList(),[]);}finally{await restarted.stopAll();}
}));
test('completed live scoreboard persists before stop and crash',async()=>fixture(async(c,config)=>{
 const s=await c.spawn({spec:{goal:'one',scope:['a']}});
 c.setOutcome(s.id,'success_first','done');c.setTestsOwned(s.id,true);await delay(650);
 const restarted=new Coordinator(config);await restarted.init();
 try{const report=await restarted.report();assert.equal(report.counts.success_first,1);assert.equal(report.tasks[0].tests_owned_by_codex,true);assert.equal(report.active_tasks,0);}finally{await restarted.stopAll();}
}));
test('stopAll flushes scoreboard synchronously before it resolves',async()=>fixture(async(c,config)=>{
 const s=await c.spawn({spec:{goal:'one',scope:['a']}});c.setOutcome(s.id,'success_first');c.setTestsOwned(s.id,true);
 await c.stopAll();const state=JSON.parse(await readFile(join(config.dataDir,'state.json'),'utf8'));
 assert.ok(state.history.some(h=>h.id===s.id&&h.outcome==='success_first'&&h.testsOwnedByCodex===true));
}));
test('failed startup releases acceptance reservations',async()=>fixture(async(c)=>{
 const original=PiRpcClient.prototype.start;PiRpcClient.prototype.start=async()=>{throw new Error('startup failure');};
 try{await assert.rejects(c.spawn({spec:{goal:'one',scope:['a']},acceptanceFiles:[{path:'tests/failure',content:'test'}]}),/startup failure/);
 assert.deepEqual(c.locksList(),[]);}finally{PiRpcClient.prototype.start=original;}
}));
test('acceptance reservation conflict is checked before writing or starting',async()=>fixture(async(c)=>{
 c.claim('codex',['tests/shared'],'rw');
 const original=PiRpcClient.prototype.start;let starts=0;PiRpcClient.prototype.start=async()=>{starts++;};
 try{await assert.rejects(c.spawn({spec:{goal:'one',scope:['tests']},acceptanceFiles:[{path:'tests/shared',content:'test'}]}),/conflict/);
 assert.equal(starts,0);}finally{PiRpcClient.prototype.start=original;}
}));
