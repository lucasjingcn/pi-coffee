import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../dist/config.js';
test('configuration validates merged numeric values and rejects invalid boolean env settings',()=>{
 const keys=['PI_MCP_PORT','PI_MCP_MAX_SESSIONS','PI_MCP_WORKTREE_TTL_MIN','PI_MCP_AUTO_CLEAN','PI_MCP_DELETE_BRANCHES'];
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));keys.forEach(k=>delete process.env[k]);
 try{
  assert.equal(loadConfig().port,8787);
  assert.equal(loadConfig({port:undefined,maxSessions:undefined,autoClean:undefined}).port,8787);
  for(const [field,key,values] of [
   ['port','PI_MCP_PORT',[0,-1,65536,1.5,NaN,Infinity]],
   ['maxSessions','PI_MCP_MAX_SESSIONS',[0,-1,1.5,NaN,Infinity]],
   ['worktreeTtlMin','PI_MCP_WORKTREE_TTL_MIN',[0,-1,NaN,Infinity]]]){
   for(const v of values)assert.throws(()=>loadConfig({[field]:v}),new RegExp(key+'|'+field));
   process.env[key]='bogus';assert.throws(()=>loadConfig(),new RegExp(key+'|'+field));delete process.env[key];
   process.env[key]=' ';assert.throws(()=>loadConfig(),new RegExp(key+'|'+field));delete process.env[key];
  }
  assert.equal(loadConfig({port:65535,maxSessions:1,worktreeTtlMin:1.5}).worktreeTtlMin,1.5);
  process.env.PI_MCP_PORT='broken';assert.equal(loadConfig({port:1234}).port,1234);delete process.env.PI_MCP_PORT;
  for(const key of ['PI_MCP_AUTO_CLEAN','PI_MCP_DELETE_BRANCHES']){
   process.env[key]='true';assert.throws(()=>loadConfig(),new RegExp(key));delete process.env[key];
   process.env[key]='0';assert.equal(loadConfig()[key==='PI_MCP_AUTO_CLEAN'?'autoClean':'deleteBranches'],false);
   process.env[key]='1';assert.equal(loadConfig()[key==='PI_MCP_AUTO_CLEAN'?'autoClean':'deleteBranches'],true);delete process.env[key];
  }
  assert.throws(()=>loadConfig({autoClean:'yes'}),/autoClean|PI_MCP_AUTO_CLEAN/);
 }finally{for(const k of keys)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
});
