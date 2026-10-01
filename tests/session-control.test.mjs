import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Coordinator} from '../dist/manager.js';
import {loadConfig} from '../dist/config.js';
import {buildServer} from '../dist/mcp-server.js';
import {validateSnapshot} from '../dist/state-store.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const meta = (id, controlKeyHash) => ({id,name:id,repo:'/missing/repo',worktree:'/missing/'+id,
  branch:'pi/'+id,cwd:'/missing/repo',baseRef:'HEAD',status:'stopped',createdAt:1,lastActivity:2,
  pendingQuestions:[],...(controlKeyHash ? {controlKeyHash,scopeKeyHash:controlKeyHash} : {})});

async function fixture(fn) {
  const root=await mkdtemp(join(tmpdir(),'pi-control-'));
  const dataDir=join(root,'data');await mkdir(dataDir);
  const history=[meta('a',hash('key-a')),meta('b',hash('key-b')),meta('legacy')];
  await writeFile(join(dataDir,'state.json'),JSON.stringify({counter:0,history,mailbox:[],board:[]}));
  const c=new Coordinator(loadConfig({dataDir,workspaceRoot:join(root,'workers'),autoClean:false}));
  try {await c.init();await fn(c);} finally {await c.stopAll();await rm(root,{recursive:true,force:true});}
}

test('control keys bind to one worker and survive persisted history; legacy sessions stay explicitly unprotected',()=>fixture(async c=>{
  assert.throws(()=>c.assertControl('a'),/control_key required/);
  assert.throws(()=>c.assertControl('a','key-b'),/invalid control_key/);
  assert.doesNotThrow(()=>c.assertControl('a','key-a'));
  assert.doesNotThrow(()=>c.assertControl('legacy'));
  assert.throws(()=>c.assertControlsForAll({a:'key-a'}),/session b/);
  assert.doesNotThrow(()=>c.assertControlsForAll({a:'key-a',b:'key-b'}));
  assert.throws(()=>c.assertSameScope('a','b'),/outside this session scope/);
  assert.equal(c.hasProtectedSessions(),true);
  assert.equal(JSON.stringify((await c.metrics()).sessions).includes('controlKeyHash'),false);
}));

test('MCP refuses cross-chat finish and global cleanup before any mutation',()=>fixture(async c=>{
  const server=buildServer(c);const client=new Client({name:'control-test',version:'1'});
  const [sTransport,cTransport]=InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(sTransport),client.connect(cTransport)]);
    const call=(name,args)=>client.callTool({name,arguments:args});
    const missing=await call('pi_finish',{session_id:'a',outcome:'abandoned'});
    assert.equal(missing.isError,true);assert.equal(c.snapshot('a').outcome,undefined);
    const wrong=await call('pi_finish',{session_id:'a',control_key:'key-b',outcome:'abandoned'});
    assert.equal(wrong.isError,true);assert.equal(c.snapshot('a').outcome,undefined);
    const gc=await call('pi_gc',{});
    assert.equal(gc.isError,true);
    const done=await call('pi_finish',{session_id:'a',control_key:'key-a',outcome:'abandoned',note:'closed'});
    assert.equal(done.isError,undefined);assert.equal(c.snapshot('a').outcome,'abandoned');
    const status=await call('pi_status',{session_id:'a',detail:'full'});
    assert.equal(JSON.stringify(status).includes('controlKeyHash'),false);
  } finally {await client.close();await server.close();}
}));

test('pi_spawn returns unique worker and scope capabilities without returning their hashes in status',async()=>{
  const calls=[];
  const fake={activeWorkers:()=>0,config:{parallelWarnThreshold:4},spawn:async opts=>{
    calls.push(opts);return {...meta('s'+calls.length,opts.controlKeyHash),scopeKeyHash:opts.scopeKeyHash};
  }};
  const server=buildServer(fake);const client=new Client({name:'spawn-control-test',version:'1'});
  const [sTransport,cTransport]=InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(sTransport),client.connect(cTransport)]);
    const spawn=async args=>JSON.parse((await client.callTool({name:'pi_spawn',arguments:{prompt:'Do a scoped task',...args}})).content[0].text);
    const one=await spawn({});const two=await spawn({scope_key:one.scope_key});
    assert.equal(one.scope_key,one.control_key);
    assert.notEqual(two.control_key,one.control_key);
    assert.equal(two.scope_key,one.scope_key);
    assert.equal(calls[0].controlKeyHash,hash(one.control_key));
    assert.equal(calls[1].scopeKeyHash,hash(one.scope_key));
    assert.equal(JSON.stringify(one).includes('controlKeyHash'),false);
  } finally {await client.close();await server.close();}
});

test('persisted capability hashes reject malformed state',()=>{
  const snapshot={counter:0,mailbox:[],board:[],history:[meta('a','not-a-hash')]};
  assert.throws(()=>validateSnapshot(snapshot,'fixture'),/controlKeyHash/);
});

test('protected workers never receive legacy global broadcasts, including immediate injection',()=>fixture(async c=>{
  const received=[];
  for (const id of ['a','legacy']) {
    const m=c.snapshot(id);m.status='idle';
    c.runtimes.set(id,{meta:m,repoIdentity:'fixture',lastNotifiedQuestionIds:new Set(),
      client:{isStreaming:false,followUp:async text=>received.push({id,text}),stop:async()=>{},getState:async()=>{throw new Error('offline');}}});
  }
  c.postMessage('legacy','*','global task details','broadcast',false);
  assert.equal(c.inbox('a').length,0);assert.equal(c.inbox('legacy').length,1);
  c.postMessage('codex','*','new global broadcast','broadcast',true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(received.map(r=>r.id),['legacy']);
  c.postMessage('codex','a','explicitly addressed','note',false);
  assert.deepEqual(c.inbox('a').map(m=>m.text),['explicitly addressed']);
}));
