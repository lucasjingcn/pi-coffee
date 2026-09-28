import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Coordinator} from '../dist/manager.js';import {loadConfig} from '../dist/config.js';
const state=(value)=>({counter:7,locks:[],mailbox:[],board:[{board:'test',key:'value',value,from:'codex',ts:1}],history:[]});
async function fixture(fn){
 const dir=await mkdtemp(join(tmpdir(),'pi-persistence-'));const dataDir=join(dir,'data');await mkdir(dataDir);
 const config=loadConfig({dataDir,workspaceRoot:join(dir,'workers'),autoClean:false});
 const logs=[];const original=console.error;console.error=(...args)=>logs.push(args.map(String).join(' '));
 try{await fn(config,logs,dir);}finally{console.error=original;await rm(dir,{recursive:true,force:true});}
}
test('first boot missing state is quiet; corrupt primary recovers validated backup and keeps evidence',async()=>fixture(async(config,logs)=>{
 const fresh=new Coordinator(config);await fresh.init();assert.equal(logs.length,0);await fresh.stopAll();
 const file=join(config.dataDir,'state.json');await writeFile(file,'{broken');await writeFile(file+'.bak',JSON.stringify(state('recovered')));
 const c=new Coordinator(config);await c.init();
 try{
  assert.equal(c.boardRead('test')[0].value,'recovered');assert.ok(logs.some(l=>/recover|backup/i.test(l)&&l.includes('state.json')));
  assert.equal(await readFile(file,'utf8'),'{broken','init must retain primary corruption evidence');
 }finally{await c.stopAll();}
 assert.equal(JSON.parse(await readFile(file,'utf8')).board[0].value,'recovered');
 assert.equal(JSON.parse(await readFile(file+'.bak','utf8')).board[0].value,'recovered','invalid primary must not replace good backup');
}));
test('unrecoverable syntax or shape corruption refuses fresh-start overwrite',async()=>fixture(async(config,logs)=>{
 const file=join(config.dataDir,'state.json');
 for(const raw of ['{broken',JSON.stringify({counter:2,mailbox:{},board:[],history:[]}),JSON.stringify({counter:2,board:[null],history:[]}),JSON.stringify({counter:2,history:[null]})]){
  await writeFile(file,raw);const c=new Coordinator(config);await assert.rejects(c.init(),/state|persist|load|mailbox|board|history/i);
  assert.equal(await readFile(file,'utf8'),raw);
 }
 assert.ok(logs.length>=4);
}));
test('save failure is logged, shutdown reports it, and later saves can recover',async()=>fixture(async(config,logs,dir)=>{
 const c=new Coordinator(config);await c.init();c.boardPost('test','value','before','codex');await c.stopAll();
 const preserved=join(dir,'preserved');await rename(config.dataDir,preserved);await writeFile(config.dataDir,'not a directory');
 c.boardPost('test','value','after','codex');
 try{await assert.rejects(c.stopAll(),/ENOTDIR|state|persist/i);assert.ok(logs.some(l=>/save|persist|write/i.test(l)));}
 finally{await rm(config.dataDir);await rename(preserved,config.dataDir);}
 await c.stopAll();
 assert.ok(JSON.parse(await readFile(join(config.dataDir,'state.json'),'utf8')).board.some(e=>e.value==='after'));
 assert.equal((await readdir(config.dataDir)).some(n=>n.endsWith('.tmp')),false);
}));
test('previous valid snapshot is backed up atomically and old format remains readable',async()=>fixture(async(config)=>{
 const file=join(config.dataDir,'state.json');await writeFile(file,JSON.stringify(state('old')));
 const c=new Coordinator(config);await c.init();c.boardPost('test','value','new','codex');await c.stopAll();
 const backup=JSON.parse(await readFile(file+'.bak','utf8'));assert.equal(backup.board[0].value,'old');
 const primary=JSON.parse(await readFile(file,'utf8'));assert.ok(primary.board.some(e=>e.value==='new'));
 const restarted=new Coordinator(config);await restarted.init();assert.deepEqual(restarted.locksList(),[]);await restarted.stopAll();
}));
