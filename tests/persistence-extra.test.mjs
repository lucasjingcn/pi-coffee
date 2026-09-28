import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Coordinator} from '../dist/manager.js';
import {loadConfig} from '../dist/config.js';

const state=(value)=>({counter:7,locks:[],mailbox:[],board:[{board:'test',key:'value',value,from:'codex',ts:1}],history:[]});
const delay=ms=>new Promise(r=>setTimeout(r,ms));

async function fixture(fn){
 const dir=await mkdtemp(join(tmpdir(),'pi-persistence-extra-'));
 const dataDir=join(dir,'data');await mkdir(dataDir);
 const config=loadConfig({dataDir,workspaceRoot:join(dir,'workers'),autoClean:false});
 const logs=[];const original=console.error;console.error=(...args)=>logs.push(args.map(String).join(' '));
 try{await fn(config,logs,dir);}finally{console.error=original;await rm(dir,{recursive:true,force:true});}
}

test('non-ENOENT primary read error is logged and never falls back to a valid backup',async()=>fixture(async(config,logs)=>{
 const file=join(config.dataDir,'state.json');
 await mkdir(file); // reading a directory yields EISDIR, not ENOENT
 await writeFile(file+'.bak',JSON.stringify(state('backup')));
 const c=new Coordinator(config);
 await assert.rejects(c.init(),/EISDIR|state|load/i);
 assert.ok(logs.some(l=>/load/i.test(l)&&l.includes('state.json')&&/EISDIR/i.test(l)));
}));

test('non-ENOENT backup read error is logged and aborts recovery',async()=>fixture(async(config,logs)=>{
 const file=join(config.dataDir,'state.json');
 await mkdir(file+'.bak'); // directory -> EISDIR on backup read
 const c=new Coordinator(config);
 await assert.rejects(c.init(),/EISDIR|state|load/i);
 assert.ok(logs.some(l=>/load/i.test(l)&&l.includes('state.json.bak')&&/EISDIR/i.test(l)));
}));

test('out-of-range history session number is a shape error, not a silent cap',async()=>fixture(async(config,logs)=>{
 const file=join(config.dataDir,'state.json');
 const raw={counter:2,locks:[],mailbox:[],board:[],history:[{id:'s99999999999999999999999999',repo:'r',worktree:'w',branch:'b',cwd:'c',baseRef:'h',name:'n',status:'stopped',createdAt:1,lastActivity:1,pendingQuestions:[]}]};
 await writeFile(file,JSON.stringify(raw));
 const c=new Coordinator(config);
 await assert.rejects(c.init(),/history|state|load/i);
 assert.equal(await readFile(file,'utf8'),JSON.stringify(raw));
 assert.ok(logs.length>=1);
}));

test('exhausted session id space refuses new sessions instead of reusing unsafe ids',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-persistence-extra-'));
 const dataDir=join(dir,'data');await mkdir(dataDir);
 const repo=join(dir,'repo');await mkdir(repo);
 const git=(...a)=>execFileSync('git',['-C',repo,...a],{encoding:'utf8'});
 git('init','-q');git('config','user.name','t');git('config','user.email','t@example.com');
 await writeFile(join(repo,'f'),'x');git('add','-A');git('commit','-qm','init');
 const config=loadConfig({dataDir,workspaceRoot:join(dir,'workers'),defaultRepo:repo,autoClean:false});
 await writeFile(join(dataDir,'state.json'),JSON.stringify({counter:Number.MAX_SAFE_INTEGER,locks:[],mailbox:[],board:[],history:[]}));
 const c=new Coordinator(config);await c.init();
 try{
  await assert.rejects(c.spawn({spec:{goal:'g',scope:['a']}}),/exhaust|session id|state/i);
 }finally{
  await c.stopAll();
  await rm(dir,{recursive:true,force:true});
 }
});

test('malformed JSON containing a secret never leaks into diagnostics',async()=>fixture(async(config,logs)=>{
 const file=join(config.dataDir,'state.json');
 const secret='super-secret-token-987654321';
 await writeFile(file,`{"counter":1,"board":[{"board":"b","key":"k","value":"${secret}","from":"f","ts":1}]} trailing`);
 const c=new Coordinator(config);
 await assert.rejects(c.init(),/state|load|malformed/i);
 assert.ok(logs.length>=1);
 for(const l of logs) assert.ok(!l.includes(secret),`secret leaked into log: ${l}`);
}));

test('missing primary recovers from a valid backup with a contextual warning',async()=>fixture(async(config,logs)=>{
 const file=join(config.dataDir,'state.json');
 await writeFile(file+'.bak',JSON.stringify(state('from-backup')));
 const c=new Coordinator(config);await c.init();
 try{
  assert.equal(c.boardRead('test')[0].value,'from-backup');
  assert.ok(logs.some(l=>/recover|backup/i.test(l)&&l.includes('state.json')));
 }finally{await c.stopAll();}
 assert.equal(JSON.parse(await readFile(file,'utf8')).board[0].value,'from-backup');
}));

test('background failed save is caught and a later save succeeds',async()=>fixture(async(config,logs,dir)=>{
 const file=join(config.dataDir,'state.json');
 const c=new Coordinator(config);await c.init();
 c.boardPost('test','value','before','codex');
 await delay(700);
 assert.ok(JSON.parse(await readFile(file,'utf8')).board.some(e=>e.value==='before'));

 const preserved=join(dir,'preserved');await rename(config.dataDir,preserved);await writeFile(config.dataDir,'not a directory');
 c.boardPost('test','value','after','codex');
 await delay(700);
 assert.ok(logs.some(l=>/save|persist|write/i.test(l)));

 await rm(config.dataDir);await rename(preserved,config.dataDir);
 c.boardPost('test','value','later','codex');
 await delay(700);
 assert.ok(JSON.parse(await readFile(file,'utf8')).board.some(e=>e.value==='later'));
 await c.stopAll();
}));
