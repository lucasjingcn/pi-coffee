import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rename, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('daemon shutdown reports flush failure and exits nonzero', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-shutdown-state-'));
  const data = join(dir, 'data');
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PI_MCP_')) delete env[key];
  Object.assign(env, { PI_MCP_HOST: '127.0.0.1', PI_MCP_PORT: String(port), PI_MCP_DATA_DIR: data, PI_MCP_AUTO_CLEAN: '0' });
  const proc = spawn(process.execPath, ['dist/index.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-8000); });
  const closed = new Promise(r => proc.once('close', (code, signal) => r({ code, signal })));
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (proc.exitCode !== null) throw new Error(stderr);
      try { ready = (await fetch(`http://127.0.0.1:${port}/internal/health`)).ok; if (ready) break; } catch {}
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(ready);
    await rename(data, join(dir, 'preserved'));
    await writeFile(data, 'not a directory');
    proc.kill('SIGTERM');
    const result = await closed;
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.match(stderr, /shutdown failed/);
    assert.match(stderr, /state.json/);
    assert.doesNotMatch(stderr, /UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/);
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await closed;
    await rm(dir, { recursive: true, force: true });
  }
});
