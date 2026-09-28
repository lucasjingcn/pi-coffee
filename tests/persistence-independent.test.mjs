import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../dist/manager.js';
import { loadConfig } from '../dist/config.js';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-state-independent-'));
  const config = loadConfig({ dataDir: dir, workspaceRoot: join(dir, 'w'), autoClean: false });
  const file = join(dir, 'state.json');
  const logs = [];
  const old = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try { await fn(config, file, logs); }
  finally { console.error = old; await rm(dir, { recursive: true, force: true }); }
}

test('recovery diagnostics never echo malformed state payload', async () => fixture(async (config, file, logs) => {
  await writeFile(file, '{"secret":"DO_NOT_PRINT_THIS_SECRET",broken');
  await writeFile(file + '.bak', JSON.stringify({ counter: 0, mailbox: [], board: [], history: [] }));
  const c = new Coordinator(config);
  await c.init();
  try {
    assert.match(logs.join('\n'), /state.json/);
    assert.doesNotMatch(logs.join('\n'), /DO_NOT_PRINT_THIS_SECRET/);
    assert.match(await readFile(file, 'utf8'), /DO_NOT_PRINT_THIS_SECRET/);
  } finally { await c.stopAll(); }
}));

test('filesystem read errors are logged and abort even with a valid backup', async () => fixture(async (config, file, logs) => {
  await mkdir(file);
  await writeFile(file + '.bak', '{}');
  await assert.rejects(new Coordinator(config).init(), /EISDIR|state|load/i);
  assert.ok(logs.some(l => l.includes(file) && /load|read/i.test(l)));
}));

test('unsafe historical session suffix cannot overflow restored counter', async () => fixture(async (config, file) => {
  const history = [{ id: 's999999999999999999999', name: 'old', repo: '', worktree: '', cwd: '', branch: '', baseRef: '', status: 'stopped', createdAt: 1, lastActivity: 1, pendingQuestions: [] }];
  const raw = JSON.stringify({ counter: 1, history });
  await writeFile(file, raw);
  await assert.rejects(new Coordinator(config).init(), /state|counter|history|safe/i);
  assert.equal(await readFile(file, 'utf8'), raw);
}));
