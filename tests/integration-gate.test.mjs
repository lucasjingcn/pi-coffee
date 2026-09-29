import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Coordinator} from '../dist/manager.js';
import {loadConfig} from '../dist/config.js';
import {acceptanceHashes} from '../dist/integration.js';
import {resolveRepoIdentity} from '../dist/lock-repo.js';

async function fixture(fn, command = 'test "$(cat src/item.txt)" = changed') {
  const root = await mkdtemp(join(tmpdir(), 'pi-integration-gate-'));
  const repo = join(root, 'repo'); const worker = join(root, 'worker');
  await mkdir(join(repo, 'src'), {recursive:true});
  const git = (cwd, ...args) => execFileSync('git', ['-C',cwd,...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(repo,'init','-q','-b','main');git(repo,'config','user.name','test');git(repo,'config','user.email','test@example.com');
  await writeFile(join(repo,'src/item.txt'),'base'); await writeFile(join(repo,'src/target.txt'),'base');
  git(repo,'add','src');git(repo,'commit','-qm','base');
  const baseRef = git(repo,'rev-parse','HEAD');
  git(repo,'worktree','add','-q','-b','pi/test',worker,baseRef);
  await mkdir(join(worker,'tests'));
  await writeFile(join(worker,'tests/acceptance.txt'),'owned by coordinator');
  const meta = {id:'s1',name:'gate fixture',repo,worktree:worker,cwd:worker,branch:'pi/test',baseRef,
    status:'idle',createdAt:1,lastActivity:1,pendingQuestions:[],spec:{goal:'change item',scope:['src/item.txt']},
    acceptance:{files:['tests/acceptance.txt'],command,hashes:await acceptanceHashes(worker,['tests/acceptance.txt'])}};
  await writeFile(join(worker,'src/item.txt'),'changed');
  git(worker,'add','src/item.txt','tests/acceptance.txt');git(worker,'commit','-qm','worker');
  const config = loadConfig({dataDir:join(root,'data'),workspaceRoot:join(root,'workers'),defaultRepo:repo,autoClean:false});
  const c = new Coordinator(config); await c.init();
  const client = {getState:async()=>{throw new Error('no live provider');},stop:async()=>{},isStreaming:false};
  c.runtimes.set(meta.id,{meta,client,repoIdentity:resolveRepoIdentity(repo),lastNotifiedQuestionIds:new Set()});
  const head = () => git(repo,'rev-parse','HEAD');
  const noSuccess = async () => assert.equal((await c.report()).counts.success_first,0);
  try {await fn({c,meta,config,git,repo,worker,head,noSuccess});}
  finally {await c.stopAll();await rm(root,{recursive:true,force:true});}
}

test('integration and successful finish require daemon-executed verification',()=>fixture(async({c,head,noSuccess})=>{
  const before=head();await assert.rejects(c.merge('s1'),/pi_verify/);
  await assert.rejects(c.setOutcome('s1','success_first'),/pi_verify/);
  assert.equal(head(),before);await noSuccess();
  await c.exec('s1','true');await assert.rejects(c.merge('s1'),/pi_verify/);
}));

test('takeover requires a reason and preserves verification and integration gates',()=>fixture(async({c,meta})=>{
  for (const note of [undefined, '', '   ']) {
    await assert.rejects(c.setOutcome('s1','taken_over',note),/nonempty note/);
    assert.equal(meta.outcome,undefined);
  }
  const reason='Worker failed the fixed acceptance twice; orchestrator repaired the scoped item.';
  await assert.rejects(c.setOutcome('s1','taken_over',reason),/pi_verify/);
  assert.equal((await c.verify('s1')).passed,true);
  await assert.rejects(c.setOutcome('s1','taken_over',reason),/target changed|integration/);
  assert.equal((await c.merge('s1')).ok,true);
  await c.setOutcome('s1','taken_over',reason);
  const report=await c.report();
  assert.equal(report.counts.taken_over,1);
  assert.equal(report.tasks[0].note,reason);
}));

test('passing merged candidate can integrate and close, and evidence survives as audit data',()=>fixture(async({c,meta,git,repo,worker})=>{
  // Target-side work must participate in verification too.
  await writeFile(join(repo,'src/target.txt'),'target');git(repo,'add','src/target.txt');git(repo,'commit','-qm','target');
  meta.acceptance.command='test "$(cat src/item.txt)" = changed && test "$(cat src/target.txt)" = target';
  const proof=await c.verify('s1');assert.equal(proof.passed,true);assert.equal(proof.codeChanged,true);
  assert.equal(proof.targetSha,git(repo,'rev-parse','HEAD'));assert.equal(proof.workerSha,git(worker,'rev-parse','HEAD'));
  await assert.rejects(c.setOutcome('s1','success_first'),/target changed|integration/);
  assert.equal((await c.merge('s1')).ok,true);
  assert.equal(git(repo,'rev-parse','HEAD^{tree}'),proof.candidateTree);
  await c.setOutcome('s1','success_first');assert.equal((await c.report()).counts.success_first,1);
  assert.equal(meta.integration.workerSha,proof.workerSha);
}));

for (const [name, command] of [['failed acceptance','exit 7'],['timed out acceptance','sleep 3'],['candidate mutation','printf tampered > src/item.txt']]) {
  test(`${name} cannot merge or be recorded as success`,()=>fixture(async({c,head,noSuccess})=>{
    const before=head(); const proof=await c.verify('s1',undefined,150);assert.equal(proof.passed,false);
    await assert.rejects(c.merge('s1'),/pi_verify/);await assert.rejects(c.setOutcome('s1','success_first'),/pi_verify/);
    assert.equal(head(),before);await noSuccess();
  },command));
}

test('acceptance tampering is rejected even if committed and shell reports success',()=>fixture(async({c,git,worker,head,noSuccess})=>{
  const before=head();await writeFile(join(worker,'tests/acceptance.txt'),'tampered');git(worker,'add','tests/acceptance.txt');git(worker,'commit','-qm','tamper');
  await assert.rejects(c.verify('s1'),/acceptance files changed/);await assert.rejects(c.merge('s1'),/pi_verify/);
  assert.equal(head(),before);await noSuccess();
}));

test('out of scope committed changes are rejected before verification or commit',()=>fixture(async({c,git,worker,head})=>{
  const before=head();await writeFile(join(worker,'outside.txt'),'outside');
  await assert.rejects(c.commit('s1','outside'),/outside declared scope/);
  git(worker,'add','outside.txt');git(worker,'commit','-qm','outside');
  await assert.rejects(c.verify('s1'),/outside declared scope/);assert.equal(head(),before);
}));

test('prototype-named files and renames cannot bypass scope checks',()=>fixture(async({c,git,worker})=>{
  await writeFile(join(worker,'constructor'),'outside');await assert.rejects(c.commit('s1','outside'),/outside declared scope/);
  await rm(join(worker,'constructor'));git(worker,'mv','src/target.txt','src/item-renamed.txt');
  await assert.rejects(c.commit('s1','rename'),/outside declared scope/);
}));

test('changes arriving during verification do not produce reusable evidence',()=>fixture(async({c,meta,repo,git,head})=>{
  meta.acceptance.command='sleep 0.3';const pending=c.verify('s1');
  await new Promise((resolve)=>setTimeout(resolve,150));
  await writeFile(join(repo,'src/target.txt'),'concurrent');git(repo,'add','src/target.txt');git(repo,'commit','-qm','concurrent target');
  const before=head();await assert.rejects(pending,/changed during verification/);
  await assert.rejects(c.merge('s1'),/pi_verify/);assert.equal(head(),before);
}));

test('candidate conflicts are isolated and never leave a merge in the target',()=>fixture(async({c,repo,git,head})=>{
  await writeFile(join(repo,'src/item.txt'),'conflict');git(repo,'add','src/item.txt');git(repo,'commit','-qm','conflict');
  const before=head();await assert.rejects(c.verify('s1'));assert.equal(head(),before);
  assert.equal(git(repo,'status','--porcelain'),'');await assert.rejects(c.merge('s1'),/pi_verify/);
  assert.equal(git(repo,'worktree','list','--porcelain').includes('pi-coffee-verify-'),false);
}));

test('worker modification invalidates evidence',()=>fixture(async({c,worker,head})=>{
  const before=head();assert.equal((await c.verify('s1')).passed,true);
  await writeFile(join(worker,'src/item.txt'),'new');await assert.rejects(c.merge('s1'),/worker changed/);
  assert.equal(head(),before);
}));

test('committed worker modification invalidates evidence',()=>fixture(async({c,worker,git,head})=>{
  const before=head();await c.verify('s1');await writeFile(join(worker,'src/item.txt'),'new');
  git(worker,'add','src/item.txt');git(worker,'commit','-qm','new');
  await assert.rejects(c.merge('s1'),/worker changed/);assert.equal(head(),before);
}));

test('target forward movement invalidates verification',()=>fixture(async({c,repo,git,head})=>{
  await c.verify('s1');await writeFile(join(repo,'src/target.txt'),'forward');git(repo,'add','src/target.txt');git(repo,'commit','-qm','forward');
  const before=head();await assert.rejects(c.merge('s1'),/target changed/);assert.equal(head(),before);
}));

test('dirty target is preserved, including its staged index',()=>fixture(async({c,repo,git,head})=>{
  await c.verify('s1');await writeFile(join(repo,'local.txt'),'other session');git(repo,'add','local.txt');
  const before=head();const index=git(repo,'diff','--cached');await assert.rejects(c.merge('s1'),/target worktree/);
  assert.equal(head(),before);assert.equal(git(repo,'diff','--cached'),index);assert.equal(await readFile(join(repo,'local.txt'),'utf8'),'other session');
}));

test('working workers, missing command and missing scope cannot verify',()=>fixture(async({c,meta,head})=>{
  const before=head();meta.status='working';await assert.rejects(c.verify('s1'),/settled/);
  meta.status='idle';meta.acceptance.command=undefined;await assert.rejects(c.verify('s1'),/acceptance_command/);
  meta.acceptance.command='true';meta.spec.scope=[];await assert.rejects(c.verify('s1'),/scope/);assert.equal(head(),before);
}));

test('verification serializes repository mutations and rejects writes while executing',()=>fixture(async({c,repo,git,head})=>{
  const before=head();const pending=c.verify('s1',undefined,5000);
  await assert.rejects(c.verify('s1'),/repository is verifying/);
  await assert.rejects(c.commit('s1','concurrent'),/repository is verifying/);
  await assert.rejects(c.exec('s1','true'),/repository is verifying/);
  assert.throws(()=>c.authorizeWrite('s1'),/repository is verifying/);
  await assert.rejects(c.spawn({repo,spec:{goal:'parallel',scope:['other']}}),/repository is verifying/);
  await pending;assert.equal(head(),before);
  const results=await Promise.allSettled([c.merge('s1'),c.merge('s1')]);
  assert.equal(results.filter((r)=>r.status==='fulfilled').length,1);
  assert.equal(results.filter((r)=>r.status==='rejected').length,1);
  assert.equal(git(repo,'status','--porcelain'),'');
}));

test('an instruction awaiting a model change is already working and blocks verification',()=>fixture(async({c,meta,head})=>{
  const before=head();const rt=c.get('s1');let release;
  rt.client.setModel=()=>new Promise((resolve)=>{release=resolve;});rt.client.prompt=async()=>{};
  const pending=c.send('s1','new task','prompt',true,{model:'explicit-model'});
  assert.equal(meta.status,'working');await assert.rejects(c.verify('s1'),/settled/);
  release();await pending;assert.equal(head(),before);meta.status='idle';
}));

test('model change failure is explicit and never continues a prompt on the old model',()=>fixture(async({c,meta})=>{
  const rt=c.get('s1');let prompted=false;
  rt.client.setModel=async()=>{throw new Error('model unavailable');};rt.client.prompt=async()=>{prompted=true;};
  await assert.rejects(c.send('s1','new task','prompt',true,{model:'explicit-model'}),/model unavailable/);
  assert.equal(prompted,false);assert.equal(meta.status,'idle');
}));

test('restart makes old proof unusable while retaining its audit and costs',()=>fixture(async({c,meta,config,head})=>{
  await c.verify('s1');const proof=meta.verification;const before=head();
  await c.stopAll();const restarted=new Coordinator(config);await restarted.init();
  const stored=restarted.history.find((s)=>s.id==='s1');assert.equal(stored.verification.workerSha,proof.workerSha);
  restarted.runtimes.set('s1',{meta:stored,client:{stop:async()=>{},getState:async()=>{throw new Error('offline');}},repoIdentity:resolveRepoIdentity(stored.repo)});
  try {await assert.rejects(restarted.merge('s1'),/pi_verify/);assert.equal(head(),before);}
  finally {await restarted.stopAll();}
}));

test('a verified observation with no code changes can close without merge',()=>fixture(async({c,meta,worker,git})=>{
  // Keep coordinator tests out of this observation: reset fixture worker to the base commit.
  git(worker,'reset','--hard',meta.baseRef);meta.acceptance={files:[],hashes:{},command:'test -f src/item.txt'};
  const proof=await c.verify('s1');assert.equal(proof.codeChanged,false);
  await c.setOutcome('s1','success_first');assert.equal((await c.report()).counts.success_first,1);
}));
