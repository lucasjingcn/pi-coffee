import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Coordinator} from '../dist/manager.js';import {loadConfig} from '../dist/config.js';
const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'safe.directory',GIT_CONFIG_VALUE_0:'*'} }).trim();
test('gc deletes only integrated historical task branches and reports actual deletions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pi-gc-'));const repo=join(root,'repo');await mkdir(repo);
 let c;
 try{
  git(repo,'init','-b','main');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.test');
  await writeFile(join(repo,'base'),'base');git(repo,'add','.');git(repo,'commit','-m','base');
  git(repo,'checkout','-b','pi/merged');await writeFile(join(repo,'merged'),'yes');git(repo,'add','.');git(repo,'commit','-m','worker');git(repo,'checkout','main');git(repo,'merge','--no-ff','pi/merged','-m','integrate');
  git(repo,'checkout','-b','pi/unmerged');await writeFile(join(repo,'unmerged'),'keep');git(repo,'add','.');git(repo,'commit','-m','unmerged');git(repo,'checkout','main');
  git(repo,'branch','pi/in-use');const inUse=join(root,'in-use');git(repo,'worktree','add',inUse,'pi/in-use');
  git(repo,'branch','pi/abandoned');git(repo,'branch','pi/dirty');const dirty=join(root,'dirty');git(repo,'worktree','add',dirty,'pi/dirty');await writeFile(join(dirty,'untracked'),'preserve');
  git(repo,'branch','unrelated');
  const branches=['pi/merged','pi/unmerged','pi/in-use','pi/abandoned','pi/dirty','main'];
  const history=branches.map((branch,i)=>({id:'s'+(i+1),name:'gc test',repo,branch,worktree:branch==='pi/dirty'?dirty:join(root,'missing-'+i),cwd:repo,baseRef:git(repo,'rev-parse','HEAD'),status:'stopped',createdAt:1,lastActivity:1,pendingQuestions:[],outcome:branch==='pi/abandoned'?'abandoned':'success_first'}));
  const missingRepo=join(root,'deleted-repo');history.unshift({...history[0],id:'s7',repo:missingRepo,cwd:missingRepo,branch:'pi/deleted-repo'});
  const dataDir=join(root,'data');await mkdir(dataDir);await writeFile(join(dataDir,'state.json'),JSON.stringify({counter:7,history,locks:[],mailbox:[],board:[]}));
  c=new Coordinator(loadConfig({dataDir,workspaceRoot:join(root,'workers'),autoClean:false,deleteBranches:true}));await c.init();
  const result=await c.gc();const names=git(repo,'for-each-ref','--format=%(refname:short)','refs/heads').split('\n');
  assert.ok(!names.includes('pi/merged'));for(const name of ['pi/unmerged','pi/in-use','pi/abandoned','pi/dirty','main','unrelated'])assert.ok(names.includes(name),name+' must survive');
  assert.equal(result.branches_deleted,1);assert.ok(result.branches_retained.some(entry=>entry.repo===missingRepo&&entry.reason));assert.ok(git(dirty,'status','--porcelain').includes('untracked'));assert.equal((await c.gc()).branches_deleted,0);
 }finally{if(c)await c.stopAll();await rm(root,{recursive:true,force:true});}
});
