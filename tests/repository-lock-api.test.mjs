import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('MCP and HTTP manual claims propagate repo and release only that namespace', { timeout: 12000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-lock-api-'));
  const repos = [join(dir, 'a'), join(dir, 'b')];
  for (const repo of repos) {
    await mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
  }
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PI_MCP_')) delete env[key];
  Object.assign(env, { PI_MCP_HOST: '127.0.0.1', PI_MCP_PORT: String(port), PI_MCP_DEFAULT_REPO: repos[0], PI_MCP_DATA_DIR: join(dir, 'data'), PI_MCP_AUTO_CLEAN: '0' });
  const proc = spawn(process.execPath, ['dist/index.js'], { env, stdio: 'ignore' });
  const closed = new Promise(r => proc.once('close', r));
  const base = `http://127.0.0.1:${port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    return res.json();
  };
  const mcp = async (name, args) => {
    const res = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(res.result.isError, undefined);
    return JSON.parse(res.result.content[0].text);
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (proc.exitCode !== null) throw new Error('daemon exited');
      try { ready = (await fetch(base + '/internal/health')).ok; if (ready) break; } catch {}
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(ready);
    assert.equal((await mcp('pi_claim', { session_id: 'codex', paths: ['shared'], repo: repos[1] })).ok, true);
    assert.equal((await post('/internal/claim', { sessionId: 'peer', paths: ['shared'], mode: 'rw', repo: repos[0] })).ok, true);
    assert.equal((await post('/internal/claim', { sessionId: 'peer', paths: ['shared'], mode: 'rw', repo: repos[1] })).ok, false);
    assert.equal((await mcp('pi_release', { session_id: 'codex', repo: repos[0] })).released, 0);
    assert.equal((await post('/internal/claim', { sessionId: 'peer', paths: ['shared'], mode: 'rw', repo: repos[1] })).ok, false);
    assert.equal((await post('/internal/release', { sessionId: 'codex', repo: repos[1] })).released, 1);
    assert.equal((await mcp('pi_claim', { session_id: 'peer', paths: ['shared'], repo: repos[1] })).ok, true);
  } finally {
    proc.kill('SIGTERM');
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
    await closed; clearTimeout(timer);
    await rm(dir, { recursive: true, force: true });
  }
});
