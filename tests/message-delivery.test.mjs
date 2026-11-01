import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../dist/manager.js';
import { loadConfig } from '../dist/config.js';

test('successful immediate delivery is acknowledged and failed delivery stays in inbox', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-message-test-'));
  const coord = new Coordinator(loadConfig({ dataDir: dir, workspaceRoot: join(dir, 'w'), autoClean: false }));
  await coord.init();
  for (const id of ['one', 'two']) {
    coord.runtimes.set(id, {
      meta: { id, status: 'idle', pendingQuestions: [], lastActivity: Date.now(), createdAt: Date.now() },
      client: { isStreaming: false, followUp: async () => { if (id === 'two') throw new Error('failed injection'); }, stop: async () => {} },
    });
  }
  try {
    const result = await coord.postMessage('sender', '*', 'broadcast', 'broadcast', true);
    assert.equal(result.delivered, true, 'at least one live target confirmed delivery');
    assert.equal(coord.inbox('one', true).length, 0);
    assert.equal(coord.inbox('two', true).length, 1, 'a failed injection stays unread');
  } finally {
    await coord.stopAll();
    await rm(dir, { recursive: true, force: true });
  }
});
