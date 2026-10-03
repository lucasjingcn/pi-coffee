import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Coordinator } from '../dist/manager.js';
import { loadConfig } from '../dist/config.js';
import { ControlVault } from '../dist/control-vault.js';
import { buildServer } from '../dist/mcp-server.js';
import { validateSnapshot } from '../dist/state-store.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
async function fixture(fn){
 const root=await mkdtemp(join(tmpdir(),'handoff-mcp-'));
 const c=new Coordinator(loadConfig({dataDir:root,workspaceRoot:join(root,'workers'),autoClean:false,workerWarnMs:100,workerStallMs:500,workerIdleMs:1000}));await c.init();
 const rpc=new EventEmitter();rpc.isStreaming=true;rpc.hasExited=false;rpc.stop=async()=>{rpc.hasExited=true;};rpc.getState=async()=>{throw Error('offline');};rpc.getStderr=()=>'';
 const meta={id:'s1',name:'test',status:'working',createdAt:Date.now(),lastActivity:Date.now(),repo:'/missing',worktree:'/missing/s1',branch:'pi/s1',cwd:'/missing',baseRef:'HEAD',pendingQuestions:[],controlKeyHash:hash('c'.repeat(43)),scopeKeyHash:hash('scope')};
 const rt={meta,client:rpc,repoIdentity:'repo',lastNotifiedQuestionIds:new Set()};c.runtimes.set('s1',rt);c.wireEvents(rt);c.claim('s1',['src'],'rw');
 const server=buildServer(c);const client=new Client({name:'handoff-test',version:'1'});const [st,ct]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
 const call=(name,args={})=>client.callTool({name,arguments:args});
 try{await fn({c,rt,rpc,root,call});}finally{await client.close();await server.close();await c.stopAll();await rm(root,{recursive:true,force:true});}
}
test('live MCP wait wakes for a warning, skips consumed notices and exposes safe final handoff',()=>fixture(async({c,rt,rpc,call})=>{
 rpc.emit('event',{type:'agent_start'});
 const waiting=call('pi_wait',{session_ids:['s1'],until:'question',timeout_ms:1000});
 await new Promise(r=>setImmediate(r));await c.checkWorkerHealth(rt.lastProgressAt+101);
 const warning=JSON.parse((await waiting).content[0].text);assert.equal(warning.timedOut,false);
 const notice=warning.sessions[0].handoff;assert.equal(notice.kind,'provider_wait');assert.equal(notice.safeToTakeOver,false);
 const next=JSON.parse((await call('pi_wait',{session_ids:['s1'],until:'question',timeout_ms:0,after_notice_ids:[notice.id]})).content[0].text);
 assert.equal(next.timedOut,true);
 assert.match(next.wait_hint,/does not stop workers or indicate task failure/);
 assert.equal(rt.meta.status,'working');assert.equal(c.locksList().length,1);
 assert.equal(rt.meta.handoff.id,notice.id);
 assert.equal(warning.wait_hint,undefined);
 await c.checkWorkerHealth(rt.lastProgressAt+501);
 const final=JSON.parse((await call('pi_status',{session_id:'s1'})).content[0].text);
 assert.equal(final.handoff.safeToTakeOver,true);assert.equal(final.handoff.locksReleased,true);
 assert.equal(final.outcome,'unrecorded');assert.equal(c.locksList().length,0);
}));
test('control recovery binds to scope, survives daemon restart and does not leak into views',()=>fixture(async({c,root,call})=>{
 await new ControlVault(root).save('s1','c'.repeat(43),'scope');
 const denied=await call('pi_recover_control',{session_id:'s1',scope_key:'other-scope'});assert.equal(denied.isError,true);
 const accepted=JSON.parse((await call('pi_recover_control',{session_id:'s1',scope_key:'scope'})).content[0].text);
 assert.equal(accepted.control_key,'c'.repeat(43));
 c.runtimes.get('s1').meta.lastText='complete report '.repeat(100);
 const full=JSON.parse((await call('pi_status',{session_id:'s1',detail:'full'})).content[0].text);
 assert.equal(full.lastText.length,'complete report '.repeat(100).length);
 const views=await Promise.all(['pi_status','pi_list','pi_report'].map(name=>call(name,name==='pi_list'||name==='pi_report'?{session_ids:['s1']}:{session_id:'s1',detail:'full'})));
 assert.equal(JSON.stringify(views).includes('c'.repeat(43)),false);await c.flush();
 const restarted=new Coordinator(loadConfig({dataDir:root,workspaceRoot:join(root,'workers'),autoClean:false}));
 try{await restarted.init();assert.equal((await restarted.recoverControl('s1','scope')).controlKey,'c'.repeat(43));}finally{await restarted.stopAll();}
}));
test('unexpected confirmed exit notification is persistable and safe across reload',()=>fixture(async({c,rpc,root})=>{
 rpc.hasExited=true;rpc.emit('exit',{code:1});
 assert.equal(c.snapshot('s1').handoff.kind,'worker_exited');assert.equal(c.snapshot('s1').handoff.safeToTakeOver,true);
 await c.flush();
 const restarted=new Coordinator(loadConfig({dataDir:root,workspaceRoot:join(root,'workers'),autoClean:false}));
 try{await restarted.init();assert.equal(restarted.snapshot('s1').handoff.kind,'worker_exited');}finally{await restarted.stopAll();}
}));
test('invalid timeout settings and impossible handoff proofs fail closed',()=>{
 for(const [field,value] of [['workerWarnMs',0],['workerStallMs',Infinity],['workerIdleMs',2147483648]])assert.throws(()=>loadConfig({[field]:value}),/configuration/);
 assert.throws(()=>loadConfig({workerWarnMs:100,workerStallMs:100}),/must exceed/);
 const meta={id:'s1',name:'test',status:'working',createdAt:1,lastActivity:1,repo:'repo',worktree:'w',branch:'b',cwd:'c',baseRef:'HEAD',pendingQuestions:[],handoff:{id:'a'.repeat(24),kind:'provider_timeout',at:1,safeToTakeOver:true,locksReleased:false,action:'take_over'}};
 assert.throws(()=>validateSnapshot({history:[meta]},'fixture'),/handoff/);
});
