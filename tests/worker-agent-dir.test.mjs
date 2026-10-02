import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, stat, realpath, readdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareWorkerAgentDir} from '../dist/worker-agent-dir.js';
import {PiRpcClient} from '../dist/rpc-client.js';
import {SettingsManager} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js';
import {DefaultPackageManager} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'pi-private-settings-'));
  const source = join(root, 'global');
  const cwd = join(root, 'repo');
  await mkdir(source); await mkdir(cwd);
  try { await fn({root, source, cwd}); } finally { await rm(root, {recursive:true, force:true}); }
}
async function put(path, text) { await mkdir(dirname(path), {recursive:true}); await writeFile(path, text); }

test('workers wait for source writes, then independently write settings while the original lock is held', async () => fixture(async ({root,source,cwd}) => {
  const original = JSON.stringify({defaultProvider:'fixture',defaultModel:'same-model',defaultThinkingLevel:'xhigh',compaction:{enabled:false,keepRecentTokens:20000}});
  await put(join(source,'settings.json'), original);
  await put(join(source,'auth.json'), '{"fixture":{"type":"api_key","key":"fixture-only"}}');
  await put(join(source,'models.json'), '{"providers":{}}');
  await mkdir(join(source,'settings.json.lock'));
  await writeFile(join(source,'settings.json'),'');
  const writer=setTimeout(async()=>{
    await writeFile(join(source,'settings.json'),original);
    await rm(join(source,'settings.json.lock'),{recursive:true});
  },100);
  const dirs = await Promise.all([1,2].map(n=>prepareWorkerAgentDir(join(root,`worker${n}`),source)));
  clearTimeout(writer);
  await mkdir(join(source,'settings.json.lock'));
  await Promise.all(dirs.map(async (dir,n) => {
    const settings = SettingsManager.create(cwd,dir);
    assert.deepEqual(settings.getGlobalSettings(), JSON.parse(original));
    settings.setDefaultModel(`private-${n}`);
    await settings.flush();
    assert.equal(await readFile(join(dir,'auth.json'),'utf8'),await readFile(join(source,'auth.json'),'utf8'));
    assert.equal(await readFile(join(dir,'models.json'),'utf8'),await readFile(join(source,'models.json'),'utf8'));
    assert.equal((await stat(join(dir,'settings.json'))).mode & 0o777,0o600);
  }));
  assert.equal(await readFile(join(source,'settings.json'),'utf8'),original);
  assert.equal(JSON.parse(await readFile(join(dirs[0],'settings.json'),'utf8')).defaultModel,'private-0');
  assert.equal(JSON.parse(await readFile(join(dirs[1],'settings.json'),'utf8')).defaultModel,'private-1');
}));

test('relative, external and filtered resources resolve to the same installed content', async () => fixture(async ({root,source,cwd}) => {
  await put(join(source,'extensions','keep.js'),'export default () => {};');
  await put(join(source,'extensions','omit.js'),'export default () => {};');
  await put(join(source,'skills','use','SKILL.md'),'---\nname: use\ndescription: fixture\n---\ncontent');
  await put(join(source,'prompts','same.md'),'same prompt');
  await put(join(source,'themes','same.json'),'{}');
  await put(join(root,'external','extra.js'),'export default () => {};');
  await put(join(root,'package','package.json'),JSON.stringify({name:'local-fixture',pi:{extensions:['index.js']}}));
  await put(join(root,'package','index.js'),'export default () => {};');
  await put(join(source,'AGENTS.md'),'preserve full instructions');
  await put(join(source,'settings.json'),JSON.stringify({extensions:['extensions','../external/extra.js','!extensions/omit.js','-builtin:fixture'],packages:[{source:'../package',extensions:['index.js']}],skills:['skills'],prompts:['prompts'],themes:['themes']}));
  const target=await prepareWorkerAgentDir(join(root,'worker'),source,['*']);
  async function resources(agentDir) {
    const settingsManager=SettingsManager.create(cwd,agentDir);
    const paths=await new DefaultPackageManager({cwd,agentDir,settingsManager,builtinExtensions:['fixture']}).resolve();
    const result={};
    for(const field of ['extensions','skills','prompts','themes']) result[field]=await Promise.all(paths[field].map(async r=>({path:r.path.startsWith('builtin:')?r.path:await realpath(r.path),enabled:r.enabled})));
    for(const field of Object.keys(result)) result[field].sort((a,b)=>a.path.localeCompare(b.path));
    return result;
  }
  assert.deepEqual(await resources(target),await resources(source));
  assert.equal(await readFile(join(target,'AGENTS.md'),'utf8'),'preserve full instructions');
}));

test('missing settings do not inherit another worker defaults; malformed settings fail explicitly without content leakage', async () => fixture(async ({root,source}) => {
  const target=await prepareWorkerAgentDir(join(root,'empty'),source);
  assert.equal((await stat(target)).mode & 0o777,0o700);
  await put(join(source,'settings.json'),'secret-fixture-invalid-json');
  await assert.rejects(prepareWorkerAgentDir(join(root,'bad'),source), e=>/invalid or unreadable JSON/.test(e.message)&&!e.message.includes('secret-fixture'));
}));

test('startup refuses configuration fallback and classifies locks without exposing stderr secrets', async () => fixture(async ({root,cwd}) => {
  const bin=join(root,'fake.js');
  await put(bin,`process.stderr.write('Warning: Invalid settings file /fixture/settings.json: Lock file is already being held; secret-fixture\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);process.stdout.write(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{}})+'\\n');});`);
  const client=new PiRpcClient({cwd,piBin:bin});
  try { await assert.rejects(client.start(1500),e=>e.message.includes('settings_lock_contention')&&!e.message.includes('secret-fixture')); }
  finally { await client.stop(); }
}));

test('plugin policy denies global packages, extension entries and MCP servers by default', async () => fixture(async ({root,source}) => {
  await put(join(source,'extensions','ext.js'),'export default () => {};');
  await put(join(source,'skills','s','SKILL.md'),'---\nname: s\ndescription: fixture\n---\nx');
  await put(join(source,'settings.json'),JSON.stringify({
    packages:['npm:@scope/plugin',{source:'git:github.com/a/b'}],
    extensions:['extensions','!builtin:fixture'],
    skills:['skills'],
  }));
  await put(join(source,'mcp.json'),JSON.stringify({mcpServers:{daemon:{command:'x'},safe:{command:'y'}}}));
  const target=await prepareWorkerAgentDir(join(root,'worker'),source);
  const settings=JSON.parse(await readFile(join(target,'settings.json'),'utf8'));
  assert.deepEqual(settings.packages,[]);
  assert.deepEqual(settings.extensions,['!builtin:fixture']);
  assert.deepEqual(settings.skills,[join(target,'skills')]);
  await assert.rejects(stat(join(target,'mcp.json')));
  assert.deepEqual(await readdir(join(target,'extensions')),[]);
  assert.equal(await readFile(join(target,'skills','s','SKILL.md'),'utf8'),'---\nname: s\ndescription: fixture\n---\nx');
}));

test('plugin policy mirrors only allowlisted packages, extension entries and MCP servers', async () => fixture(async ({root,source}) => {
  await put(join(source,'extensions','keep.js'),'export default () => {};');
  await put(join(source,'extensions','drop.js'),'export default () => {};');
  await put(join(source,'settings.json'),JSON.stringify({
    packages:['npm:@scope/keep','npm:@scope/drop'],
    extensions:['extensions/keep.js','extensions/drop.js'],
  }));
  await put(join(source,'mcp.json'),JSON.stringify({mcpServers:{keep:{command:'x'},drop:{command:'y'}}}));
  const target=await prepareWorkerAgentDir(join(root,'worker'),source,['npm:@scope/keep','extensions/keep.js','keep']);
  const settings=JSON.parse(await readFile(join(target,'settings.json'),'utf8'));
  assert.deepEqual(settings.packages,['npm:@scope/keep']);
  assert.equal(settings.extensions.length,1);
  assert.ok(settings.extensions[0].endsWith('keep.js'));
  assert.deepEqual(JSON.parse(await readFile(join(target,'mcp.json'),'utf8')).mcpServers,{keep:{command:'x'}});
  assert.deepEqual(await readdir(join(target,'extensions')),['keep.js']);
  await assert.rejects(stat(join(target,'extensions','drop.js')));
}));
