import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Coordinator} from '../dist/manager.js';import {loadConfig} from '../dist/config.js';import {PiRpcClient} from '../dist/rpc-client.js';
PiRpcClient.prototype.start=async()=>{};PiRpcClient.prototype.stop=async()=>{};PiRpcClient.prototype.prompt=async function(){this.emit("event",{type:"agent_settled"});return {success:true};};PiRpcClient.prototype.getState=async()=>({isStreaming:false});PiRpcClient.prototype.getSessionStats=async()=>({cost:0,tokens:{}});
async function fixture(fn){
 const dir=await mkdtemp(join(tmpdir(),'pi-repo-locks-'));const repos=[join(dir,'a'),join(dir,'b')];
 for(const repo of repos){await mkdir(repo);const git=(...a)=>execFileSync('git',['-C',repo,...a]);git('init','-q');git('config','user.name','test');git('config','user.email','test@test');await writeFile(join(repo,'base.txt'),'base');git('add','-A');git('commit','-qm','init');}
 const c=new Coordinator(loadConfig({dataDir:join(dir,'data'),workspaceRoot:join(dir,'workers'),defaultRepo:repos[0],autoClean:false}));
 await c.init();try{await fn(c,...repos,dir);}finally{await c.stopAll();await rm(dir,{recursive:true,force:true});}
}
test('scope and codex acceptance reservations isolate different repositories',async()=>fixture(async(c,a,b)=>{
 const one=await c.spawn({repo:a,spec:{goal:'a',scope:['src/same.ts']},acceptanceFiles:[{path:'tests/same',content:'a'}]});
 const two=await c.spawn({repo:b,spec:{goal:'b',scope:['src/same.ts']},acceptanceFiles:[{path:'tests/same',content:'b'}]});
 assert.equal(c.claim(one.id,['tests/same'],'rw').ok,false);assert.equal(c.claim(two.id,['tests/same'],'rw').ok,false);
 await c.stop(one.id);
 assert.equal(c.claim(two.id,['tests/same'],'rw').ok,false,'stopping A must retain B acceptance reservation');
 assert.ok(c.locksList().some(l=>l.sessionId===two.id));assert.ok(c.locksList().some(l=>l.sessionId==='codex'));
 await assert.rejects(c.spawn({repo:b,spec:{goal:'overlap',scope:['src']}}),/conflict/);
}));
test('Git worktree and symlink aliases share one repository lock namespace',async()=>fixture(async(c,a,b,dir)=>{
 const one=await c.spawn({repo:a,spec:{goal:'a',scope:['src/shared.ts']}});
 const alias=join(dir,'alias');await symlink(a,alias);
 await assert.rejects(c.spawn({repo:alias,spec:{goal:'alias',scope:['src/shared.ts']}}),/conflict/);
 const linked=join(dir,'linked');execFileSync('git',['-C',a,'worktree','add','--detach',linked],{stdio:'ignore'});
 await assert.rejects(c.spawn({repo:linked,spec:{goal:'linked',scope:['src/shared.ts']}}),/conflict/);
 const two=await c.spawn({repo:linked,spec:{goal:'different',scope:['other']}});
 assert.equal(c.claim(one.id,[join(one.worktree,'shared.txt')],'rw').ok,true);
 assert.equal(c.claim(two.id,['shared.txt'],'rw').ok,false);
}));
test('manual codex claims can select repo; release and ro/rw overlap remain scoped',async()=>fixture(async(c,a,b)=>{
 const one=await c.spawn({repo:a,spec:{goal:'a',scope:['a']}});const two=await c.spawn({repo:b,spec:{goal:'b',scope:['b']}});
 assert.equal(c.claim('codex',['manual'],'rw',b).ok,true);
 assert.equal(c.claim(one.id,['manual'],'rw').ok,true);assert.equal(c.claim(two.id,['manual'],'rw').ok,false);
 assert.equal(c.releaseLocks('codex',['manual'],a),0);
 assert.equal(c.claim(two.id,['manual'],'rw').ok,false);
 assert.equal(c.releaseLocks('codex',['manual'],b),1);
 assert.equal(c.claim(two.id,['manual'],'rw').ok,true);
 const peer=await c.spawn({repo:a,spec:{goal:'peer',scope:['peer']}});
 assert.equal(c.claim(one.id,['read/sub'],'ro').ok,true);assert.equal(c.claim(peer.id,['read'],'ro').ok,true);
 assert.equal(c.claim(peer.id,['read'],'rw').ok,false);
 assert.equal(c.releaseLocks(one.id,['read']),1);assert.equal(c.claim(peer.id,['read'],'rw').ok,true);
}));
