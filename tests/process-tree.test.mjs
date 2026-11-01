import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDescendantPids, parseSurvivingPids } from '../dist/process-tree.js';

test('parseDescendantPids walks the whole tree and ignores malformed lines', () => {
  const table = [
    '  100     1',
    '  200   100',
    '  300   200',
    '  400   200',
    '  500     1',
    'not a line',
    '  201     x',
    '  202   100  trailing',
  ].join('\n');
  assert.deepEqual(parseDescendantPids(table, 100).sort((a, b) => a - b), [200, 300, 400]);
  assert.deepEqual(parseDescendantPids(table, 1).sort((a, b) => a - b), [100, 200, 300, 400, 500]);
  assert.deepEqual(parseDescendantPids(table, 999), []);
});

test('parseDescendantPids never loops on a cycle or duplicate edge', () => {
  assert.deepEqual(parseDescendantPids(['  2     1', '  1     2'].join('\n'), 1).sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(parseDescendantPids(['  2     1', '  2     1'].join('\n'), 1), [2]);
});

test('parseSurvivingPids treats zombies as already gone and keeps live processes', () => {
  const table = [
    '    10 S',
    '    11 Z',
    '    12 Z+',
    '    13 R+',
    'garbage',
  ].join('\n');
  assert.deepEqual(parseSurvivingPids(table, [10, 11, 12, 13, 14]), [10, 13]);
  assert.deepEqual(parseSurvivingPids('', [10]), []);
});
