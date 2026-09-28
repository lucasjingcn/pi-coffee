import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Coordinator} from '../dist/manager.js';import {loadConfig} from '../dist/config.js';
const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'safe.directory',GIT_CONFIG_VALUE_0:'*'} }).trim();
const commitFile=async(repo,file,name)=>{await writeFile(join(repo,file),name);git(repo,'add','.');git(repo,'commit','-m',name)};
const initRepo=async(root)=>{
 const repo=join(root,'repo');await mkdir(repo);
 git(repo,'init','-b','main');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.test');
 await commitFile(repo,'base','base');
 return repo;
};

test('gc does not force-delete unmerged or active branches with autoClean+deleteBranches',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pi-gc-extra-'));const repo=await initRepo(root);
 let c;
 try{
  for(const branch of ['pi/live-merged','pi/live-active','pi/live-unmerged']){
   git(repo,'checkout','-b',branch);await commitFile(repo,branch.replace(/\W+/g,'_'),branch);git(repo,'checkout','main');
  }
  git(repo,'merge','--no-ff','pi/live-merged','-m','merge live-merged');
  git(repo,'merge','--no-ff','pi/live-active','-m','merge live-active');
  const mergedWt=join(root,'ww-merged'),activeWt=join(root,'ww-active'),unmergedWt=join(root,'ww-unmerged');
  git(repo,'worktree','add',mergedWt,'pi/live-merged');
  git(repo,'worktree','add',activeWt,'pi/live-active');
  git(repo,'worktree','add',unmergedWt,'pi/live-unmerged');
  const baseRef=git(repo,'rev-parse','HEAD');
  const meta=(id,branch,worktree,status='idle')=>({id,name:branch,repo,branch,worktree,cwd:repo,baseRef,status,createdAt:1,lastActivity:1,pendingQuestions:[],outcome:'success_first'});
  const runtime=(m)=>({meta:m,client:{stop:async()=>{}},lastNotifiedQuestionIds:new Set(),repoIdentity:repo});
  const dataDir=join(root,'data');await mkdir(dataDir);
  c=new Coordinator(loadConfig({dataDir,workspaceRoot:join(root,'workers'),autoClean:true,deleteBranches:true}));
  await c.init();
  c.runtimes.set('s1',runtime(meta('s1','pi/live-merged',mergedWt)));
  c.runtimes.set('s2',runtime(meta('s2','pi/live-unmerged',unmergedWt)));
  c.runtimes.set('s3',runtime(meta('s3','pi/live-active',activeWt,'working')));
  const result=await c.gc();
  const names=git(repo,'for-each-ref','--format=%(refname:short)','refs/heads').split('\n');
  assert.equal(result.branches_deleted,1,'only the ancestry-proven merged branch is deleted');
  assert.ok(!names.includes('pi/live-merged'));
  assert.ok(names.includes('pi/live-unmerged'),'unmerged branch must survive even with deleteBranches=true');
  assert.ok(names.includes('pi/live-active'),'active-session branch must survive');
  assert.equal(existsSync(mergedWt),false);
  assert.equal(existsSync(unmergedWt),false);
  assert.equal(existsSync(activeWt),true,'active worktree is not removed');
  const reasons=Object.fromEntries(result.branches_retained.map((r)=>[r.branch,r.reason]));
  assert.equal(reasons['pi/live-unmerged'],'not an ancestor of HEAD');
  assert.equal(reasons['pi/live-active'],'active session');
 }finally{if(c)await c.stopAll();await rm(root,{recursive:true,force:true});}
});

test('gc deduplicates repo/branch metadata and never deletes on invalid refs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pi-gc-extra-'));const repo=await initRepo(root);
 let c;
 try{
  git(repo,'checkout','-b','pi/mixed');await commitFile(repo,'mixed','mixed');git(repo,'checkout','main');
  git(repo,'merge','--no-ff','pi/mixed','-m','merge mixed');
  const baseRef=git(repo,'rev-parse','HEAD');
  const entry=(id,branch,outcome)=>({id,name:'gc test',repo,branch,worktree:join(root,'missing-'+id),cwd:repo,baseRef,status:'stopped',createdAt:1,lastActivity:1,pendingQuestions:[],outcome});
  const history=[entry('s1','pi/mixed','success_first'),entry('s2','pi/mixed','abandoned'),entry('s3','pi/ghost','success_first'),entry('s4','refs/heads/evil','success_first')];
  const dataDir=join(root,'data');await mkdir(dataDir);
  await writeFile(join(dataDir,'state.json'),JSON.stringify({counter:4,history,locks:[],mailbox:[],board:[]}));
  c=new Coordinator(loadConfig({dataDir,workspaceRoot:join(root,'workers'),autoClean:false,deleteBranches:true}));
  await c.init();
  const result=await c.gc();
  const names=git(repo,'for-each-ref','--format=%(refname:short)','refs/heads').split('\n');
  assert.equal(result.branches_deleted,0);
  assert.ok(names.includes('pi/mixed'),'one abandoned session must protect the shared repo/branch');
  const mixed=result.branches_retained.filter((r)=>r.branch==='pi/mixed');
  assert.equal(mixed.length,1,'repo/branch candidates are deduplicated');
  assert.equal(mixed[0].reason,'outcome abandoned');
  assert.equal(result.branches_retained.find((r)=>r.branch==='pi/ghost')?.reason,'branch not found');
  assert.ok(result.branches_retained.some((r)=>r.branch==='refs/heads/evil'),'invalid metadata is retained, not deleted');
 }finally{if(c)await c.stopAll();await rm(root,{recursive:true,force:true});}
});
