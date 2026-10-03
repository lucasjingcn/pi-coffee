import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {worktreeDiff, commitAll, mergeBranch, git as gitRunner} from '../dist/worktree.js';
async function fixture(fn) {
 const dir=await mkdtemp(join(tmpdir(),'pi-git-test-'));
 const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'});
 try {git('init','-q');git('config','user.name','test');git('config','user.email','test@example.com');
 // Exercise fixture hooks even when the user has a global core.hooksPath.
 git('config','core.hooksPath',join(dir,'.git','hooks'));
 await writeFile(join(dir,'tracked.txt'),'base\n');git('add','-A');git('commit','-qm','base');await fn(dir,git);}
 finally {await rm(dir,{recursive:true,force:true});}
}
test('diff includes committed, staged, unstaged and expanded untracked names without quoted paths',async()=>fixture(async(dir,git)=>{
 const base=git('rev-parse','HEAD').trim();
 await writeFile(join(dir,'committed.txt'),'committed');git('add','-A');git('commit','-qm','next');
 await writeFile(join(dir,'staged.txt'),'staged');git('add','staged.txt');
 await writeFile(join(dir,'tracked.txt'),'edited\n');
 await mkdir(join(dir,'newdir'));const name='newdir/空 格\nname.txt';await writeFile(join(dir,name),'new');
 const d=await worktreeDiff(dir,base);
 for(const f of ['committed.txt','staged.txt','tracked.txt',name])assert.ok(d.files.includes(f),JSON.stringify(d.files));
 assert.deepEqual(d.untracked,[name]);assert.match(d.committed,/committed/);assert.match(d.uncommitted,/edited/);
}));
test('porcelain preserves initial status column',async()=>fixture(async(dir,git)=>{
 const base=git('rev-parse','HEAD').trim();await writeFile(join(dir,'tracked.txt'),'edited');
 assert.ok((await worktreeDiff(dir,base)).status.startsWith(' M '));
}));
test('invalid diff base rejects instead of returning empty success',async()=>fixture(async(dir)=>{
 await assert.rejects(worktreeDiff(dir,'missing-ref'));
}));
test('commit hook rejection is an error, clean commit remains no-op',async()=>fixture(async(dir)=>{
 await writeFile(join(dir,'.git/hooks/pre-commit'),'#!/bin/sh\nexit 1\n',{mode:0o755});
 await writeFile(join(dir,'tracked.txt'),'edited');await assert.rejects(commitAll(dir,'blocked'));
}));
test('merge reports failure even when there are no conflict markers',async()=>fixture(async(dir,git)=>{
 const into=git('branch','--show-current').trim();git('checkout','-qb','worker');
 await writeFile(join(dir,'worker.txt'),'worker');git('add','-A');git('commit','-qm','worker');git('checkout',into);
 await writeFile(join(dir,'.git/hooks/pre-merge-commit'),'#!/bin/sh\nexit 1\n',{mode:0o755});
 const result=await mergeBranch(dir,'worker',into);assert.equal(result.ok,false);assert.deepEqual(result.conflicts,[]);
}));
test('dirty merge is unsuccessful with no content conflict',async()=>fixture(async(dir,git)=>{
 const into=git('branch','--show-current').trim();git('checkout','-qb','worker');await writeFile(join(dir,'tracked.txt'),'worker');git('add','-A');git('commit','-qm','worker');git('checkout',into);await writeFile(join(dir,'tracked.txt'),'local');
 assert.equal((await mergeBranch(dir,'worker',into)).ok,false);
}));
test('git timeout kills the whole process group, not just the direct git process', async () => fixture(async (dir) => {
 await writeFile(join(dir,'tracked.txt'),'edited\n');
 // A pre-commit hook that hangs by exec'ing a long-lived sleep inside git's group.
 await writeFile(join(dir,'.git/hooks/pre-commit'),'#!/bin/sh\nexec sleep 3199\n',{mode:0o755});
 await assert.rejects(gitRunner(dir,['commit','-am','blocked'],2000),/timed out/);
 await new Promise(r=>setTimeout(r,80));
 let alive='';
 try { alive=execFileSync('pgrep',['-f','sleep 3199'],{encoding:'utf8'}).trim(); } catch { /* no match */ }
 assert.equal(alive,'');
}));