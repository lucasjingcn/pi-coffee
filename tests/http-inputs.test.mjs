import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {createHash} from 'node:crypto';

async function daemon(fn, token = '', history = []) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-http-test-'));
  if (history.length) await writeFile(join(dir,'state.json'),JSON.stringify({counter:0,history,mailbox:[],board:[]}));
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PI_COFFEE_')) delete env[key];
  Object.assign(env, { PI_COFFEE_HOST: '127.0.0.1', PI_COFFEE_PORT: String(port), PI_COFFEE_DATA_DIR: dir, PI_COFFEE_WORKSPACE_ROOT: join(dir, 'worktrees'), PI_COFFEE_TOKEN: token, PI_COFFEE_AUTO_CLEAN: '0' });
  const proc = spawn(process.execPath, ['dist/index.js'], { env, stdio: 'ignore' });
  const closed = new Promise(r => proc.once('close', r));
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (proc.exitCode !== null) throw new Error('daemon exited during startup');
      try { await fetch(base + '/internal/health', { headers: { authorization: `Bearer ${token}` } }); ready = true; break; } catch {}
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(ready, 'daemon became ready');
    await fn(base, port, dir);
  } finally {
    proc.kill('SIGTERM');
    const killTimer = setTimeout(() => proc.kill('SIGKILL'), 2000);
    await closed; clearTimeout(killTimer);
    await rm(dir, { recursive: true, force: true });
  }
}

test('malformed Host cannot crash daemon and bad internal JSON returns 400', { timeout: 10000 }, async () => daemon(async (base, port) => {
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/internal/health', headers: { Host: '[' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 200);
  assert.equal((await fetch(base + '/internal/read', { method: 'POST', body: '{bad' })).status, 400);
  assert.equal((await fetch(base + '/internal/health')).status, 200);
}));

test('MCP authenticates before parsing untrusted bodies', { timeout: 10000 }, async () => daemon(async base => {
  assert.equal((await fetch(base + '/mcp', { method: 'POST', body: '{bad' })).status, 401);
  assert.equal((await fetch(base + '/mcp', { method: 'POST', body: '{bad', headers: { authorization: 'Bearer test-token' } })).status, 400);
}, 'test-token'));

test('HTTP broadcast read acknowledgements reach only their recipient', { timeout: 10000 }, async () => daemon(async base => {
  const post = async (path, body) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const message = await post('/internal/send', { from: 'sender', to: '*', text: 'broadcast', deliver: false });
  await post('/internal/read', { ids: [message.id], sessionId: 'one' });
  assert.equal((await (await fetch(base + '/internal/inbox?sessionId=one&unread=1')).json()).messages.length, 0);
  assert.equal((await (await fetch(base + '/internal/inbox?sessionId=two&unread=1')).json()).messages.length, 1);
}));

test('protected sessions close unauthenticated internal mutation bypass and redact hashes', {timeout:10000}, async()=>{
  const hash=createHash('sha256').update('secret-control').digest('hex');
  const history=[{id:'protected',name:'protected',repo:'/missing',worktree:'/missing/worker',branch:'pi/protected',
    cwd:'/missing',baseRef:'HEAD',status:'stopped',createdAt:1,lastActivity:1,pendingQuestions:[],controlKeyHash:hash,scopeKeyHash:hash}];
  await daemon(async base=>{
    const response=await fetch(base+'/internal/claim',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({sessionId:'protected',paths:['src/a']})});
    assert.equal(response.status,401);
    const status=await (await fetch(base+'/internal/status?sessionId=protected')).json();
    assert.equal(status.id,'protected');
    assert.equal(JSON.stringify(status).includes(hash),false);
  },'',history);
});
