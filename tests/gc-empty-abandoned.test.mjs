import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Coordinator} from '../dist/manager.js';
import {loadConfig} from '../dist/config.js';

test('gc removes an empty abandoned historical worktree while preserving dirty and committed work',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pi-gc-empty-abandoned-'));
  const repo=join(root,'repo');await mkdir(repo);
  const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
  let c;
  try {
    git(repo,'init','-q','-b','main');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.test');
    await writeFile(join(repo,'base'),'base');git(repo,'add','base');git(repo,'commit','-qm','base');
    const base=git(repo,'rev-parse','HEAD');
    const dirs=Object.fromEntries(['s1','s2','s3'].map(id=>[id,join(root,id)]));
    for(const id of Object.keys(dirs))git(repo,'worktree','add','-q','-b',`pi/${id}`,dirs[id],base);
    await writeFile(join(dirs.s2,'base'),'uncommitted work');await writeFile(join(dirs.s2,'debug.tmp'),'retain');
    await writeFile(join(dirs.s3,'committed'),'retain');git(dirs.s3,'add','committed');git(dirs.s3,'commit','-qm','unfinished worker work');
    const history=['s1','s2','s3'].map(id=>({id,name:id,repo,worktree:dirs[id],cwd:dirs[id],branch:`pi/${id}`,
      baseRef:base,status:'stopped',createdAt:1,lastActivity:1,pendingQuestions:[],
      outcome:id==='s2'?undefined:'abandoned'}));
    const dataDir=join(root,'data');await mkdir(dataDir);
    await writeFile(join(dataDir,'state.json'),JSON.stringify({counter:3,history,mailbox:[],board:[]}));
    c=new Coordinator(loadConfig({dataDir,workspaceRoot:join(root,'workers'),autoClean:false}));await c.init();
    const empty=await c.gc(['s1']);
    assert.equal(empty.worktrees_cleaned,1);assert.equal(empty.branches_deleted,1);
    assert.deepEqual(empty.branches_retained,[],'other sessions do not fill a scoped cleanup reply');
    assert.equal(existsSync(dirs.s1),false);assert.equal(git(repo,'branch','--list','pi/s1'),'');
    assert.equal((await c.report(['s1','s2','s3'])).total_tasks,3,'audit history survives cleanup');
    const dirty=await c.gc(['s2']);
    assert.equal(dirty.worktrees_cleaned,0);assert.equal(existsSync(join(dirs.s2,'debug.tmp')),true);
    const committed=await c.gc(['s3']);
    assert.equal(committed.worktrees_cleaned,0);assert.equal(existsSync(dirs.s3),true);
    assert.match(committed.branches_retained.find(item=>item.branch==='pi/s3')?.reason??'',/abandoned/);
  } finally {if(c)await c.stopAll();await rm(root,{recursive:true,force:true});}
});
