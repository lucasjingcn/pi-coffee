import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('write policy fails closed on outages and malformed replies, recovers and rejects escaping paths', {timeout:15000}, async()=>{
  const code=String.raw`
    import assert from 'node:assert/strict';
    import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
    import {tmpdir} from 'node:os';import {join} from 'node:path';
    process.env.PI_COORD_URL='http://coordinator.test';process.env.PI_COORD_SESSION_ID='s1';
    const root=await mkdtemp(join(tmpdir(),'pi-write-policy-'));
    const cwd=join(root,'worker');const outside=join(root,'outside');await mkdir(cwd);await mkdir(outside);
    await symlink(outside,join(cwd,'escaped'));await symlink(join(outside,'not-created'),join(cwd,'dangling'));
    await mkdir(join(cwd,'.git'));await symlink(join(cwd,'.git'),join(cwd,'git-alias'));
    const handlers=new Map();let mode='ok';let claims=0;let permissions=0;
    globalThis.fetch=async(url,opts)=>{
      assert.ok(opts.signal instanceof AbortSignal);
      if(mode==='refused')throw Object.assign(new Error('refused'),{code:'ECONNREFUSED'});
      if(mode==='timeout')throw new DOMException('timeout','TimeoutError');
      if(mode==='http')return {ok:false,status:503,text:async()=>JSON.stringify({error:'unavailable'})};
      if(mode==='invalid')return {ok:true,text:async()=>'{broken'};
      const auth=new URL(url).pathname==='/internal/authorize-write';
      if(auth){permissions++;return {ok:true,text:async()=>JSON.stringify({ok:true})};}
      claims++;const body=JSON.parse(opts.body);
      if(mode==='invalid-claim')return {ok:true,text:async()=>JSON.stringify({ok:'yes'})};
      if(mode==='conflict')return {ok:true,text:async()=>JSON.stringify({ok:false,conflicts:[{path:'conflicted.txt',sessionId:'other'}]})};
      return {ok:true,text:async()=>JSON.stringify({ok:true,granted:body.paths,conflicts:[]})};
    };
    const extension=(await import('./extensions/pi-coordinator.ts')).default;
    extension({registerTool(){},on(name,fn){handlers.set(name,fn);}});
    const run=(toolName,input)=>handlers.get('tool_call')({toolName,input},{cwd});
    try {
      for(const failure of ['refused','timeout','http','invalid']){
        mode=failure;
        for(const [tool,input] of [['write',{path:'file.txt'}],['edit',{path:'file.txt'}],['bash',{command:'python3 dynamic-write.py'}]]){
          const result=await run(tool,input);assert.equal(result.block,true,failure+' '+tool);
          assert.match(result.reason,/Coordinator could not authorize/);
        }
      }
      mode='invalid-claim';assert.equal((await run('write',{path:'file.txt'})).block,true);
      mode='conflict';assert.match((await run('write',{path:'conflicted.txt'})).reason,/other/);
      mode='ok';assert.equal(await run('write',{path:'file.txt'}),undefined);
      const oldClaims=claims;mode='refused';assert.equal((await run('write',{path:'file.txt'})).block,true);
      assert.equal(claims,oldClaims,'cached claims still require live write permission');
      assert.equal(await run('read',{path:'file.txt'}),undefined,'reads stay available during outage');
      mode='ok';assert.equal(await run('write',{path:'file.txt'}),undefined);
      for(const path of ['../outside/new.txt',join(outside,'absolute.txt'),'escaped/new.txt','dangling/new.txt','.git/config','git-alias/config']){
        assert.equal((await run('write',{path})).block,true,path);
      }
      assert.equal((await run('bash',{command:'printf wrong > ../outside/file.txt'})).block,true);
      assert.ok(permissions>0);console.log('WRITE POLICY OK');
    }finally{await rm(root,{recursive:true,force:true});}
  `;
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),timeout:12000});
  assert.match(stdout,/WRITE POLICY OK/);
});
