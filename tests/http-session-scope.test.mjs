import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('worker internal token is limited to its own session and intentional peer scope', {timeout:15000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'pi-http-scope-'));
  const repo=join(root,'repo');await mkdir(repo);
  execFileSync('git',['init','-q','-b','main',repo]);
  execFileSync('git',['-C',repo,'config','user.name','Test']);
  execFileSync('git',['-C',repo,'config','user.email','test@example.test']);
  await writeFile(join(repo,'base'),'base');
  execFileSync('git',['-C',repo,'add','base']);
  execFileSync('git',['-C',repo,'commit','-qm','base']);
  const tokenFile=join(root,'worker-tokens');const fake=join(root,'fake-pi.js');
  await writeFile(fake,`const fs=require('node:fs');const readline=require('node:readline');
fs.appendFileSync(process.env.FAKE_TOKEN_FILE,process.env.PI_COORD_SESSION_ID+':'+process.env.PI_COORD_TOKEN+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const cmd=JSON.parse(line);
const data=cmd.type==='get_state'?{isStreaming:false}:{};
process.stdout.write(JSON.stringify({type:'response',id:cmd.id,success:true,data})+'\\n');
if(cmd.type==='prompt')process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');});`);
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const env={...process.env,PI_COFFEE_HOST:'127.0.0.1',PI_COFFEE_PORT:String(port),PI_COFFEE_DATA_DIR:join(root,'data'),
    PI_COFFEE_WORKSPACE_ROOT:join(root,'workers'),PI_COFFEE_DEFAULT_REPO:repo,PI_COFFEE_PI_BIN:fake,
    PI_COFFEE_TOKEN:'master-for-test',PI_COFFEE_AUTO_CLEAN:'0',FAKE_TOKEN_FILE:tokenFile};
  const proc=spawn(process.execPath,['dist/index.js'],{env,stdio:'ignore'});
  const closed=new Promise(resolve=>proc.once('close',resolve));
  const base=`http://127.0.0.1:${port}`;
  const post=async(path,body,token)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',
    accept:'application/json, text/event-stream',
    ...(token?{'x-pi-coord-token':token}:{})},body:JSON.stringify(body)});
  const mcp=async(name,args)=>{
    const response=await post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},'master-for-test');
    assert.equal(response.status,200);const data=await response.json();assert.equal(data.result.isError,undefined);
    return JSON.parse(data.result.content[0].text);
  };
  try {
    let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(base+'/internal/health',{headers:{'x-pi-coord-token':'master-for-test'}})).ok;if(ready)break;}catch{}await pause(20);}
    assert.ok(ready);
    const a=await mcp('pi_spawn',{prompt:'Task a',task:'a'});
    const b=await mcp('pi_spawn',{prompt:'Task b',task:'b'});
    const c=await mcp('pi_spawn',{prompt:'Task c',task:'c',scope_key:a.scope_key});
    const tokens=Object.fromEntries((await readFile(tokenFile,'utf8')).trim().split('\n').map(line=>line.split(':')));
    assert.equal(Object.keys(tokens).length,3);
    assert.notEqual(tokens[a.id],'master-for-test');
    assert.equal((await post('/internal/claim',{sessionId:a.id,paths:['own']},tokens[a.id])).status,200);
    assert.notEqual((await post('/internal/claim',{sessionId:b.id,paths:['foreign']},tokens[a.id])).status,200);
    assert.notEqual((await post('/internal/release',{sessionId:b.id},tokens[a.id])).status,200);
    assert.notEqual((await post('/internal/authorize-write',{sessionId:b.id},tokens[a.id])).status,200);
    assert.notEqual((await post('/internal/send',{from:a.id,to:b.id,text:'foreign'},tokens[a.id])).status,200);
    assert.equal((await post('/internal/send',{from:a.id,to:c.id,text:'peer',deliver:false},tokens[a.id])).status,200);
    assert.equal((await post('/internal/board/post',{board:'shared',key:'fact',value:'ours'},tokens[a.id])).status,200);
    const board=async token=>(await (await fetch(base+'/internal/board/get?board=shared',{headers:{'x-pi-coord-token':token}})).json()).entries;
    assert.equal((await board(tokens[b.id])).length,0);
    assert.equal((await board(tokens[c.id])).length,1);
    assert.equal((await post('/mcp',{jsonrpc:'2.0',id:2,method:'tools/list'},tokens[a.id])).status,401);
    assert.equal((await (await fetch(base+'/internal/sessions',{headers:{'x-pi-coord-token':tokens[a.id]}})).json()).sessions.length,2);
  } finally {
    proc.kill('SIGTERM');const timer=setTimeout(()=>proc.kill('SIGKILL'),2000);await closed;clearTimeout(timer);
    await rm(root,{recursive:true,force:true});
  }
});
