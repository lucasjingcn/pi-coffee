import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';

async function bridge(handler, wire) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, ['dist/stdio-proxy.js'], {
    env: {
      ...process.env,
      PI_COFFEE_URL: 'http://127.0.0.1:' + server.address().port + '/mcp',
      PI_COFFEE_TOKEN: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
  child.stdin.end(wire);
  try {
    await done;
    return out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => server.close(r));
  }
}

const req = JSON.stringify({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'pi_spawn', arguments: {}}});

test('malformed or unmatched daemon responses yield one correlated -32000 and are never replayed', {timeout: 15000}, async () => {
  const bad = [
    '', // empty body
    'invalid-json', // unparseable
    '{}', // missing jsonrpc/id/result
    '[]', // array response
    'null', // null body
    'true', // non-object body
    '123', // non-object body
    '{"jsonrpc":"2.0","id":99,"result":{}}', // id mismatch
    '{"jsonrpc":"2.0","id":"7","result":{}}', // id type mismatch
    '{"jsonrpc":"1.0","id":7,"result":{}}', // wrong jsonrpc version
    '{"jsonrpc":"2.0","id":7}', // missing result/error
    '{"jsonrpc":"2.0","id":7,"result":{},"error":{"code":-32000,"message":"x"}}', // both members
    '{"jsonrpc":"2.0","id":7,"error":"boom"}', // error not object
    '{"jsonrpc":"2.0","id":7,"error":[]}', // error array
    '{"jsonrpc":"2.0","id":7,"error":{"message":"boom"}}', // error missing code
    '{"jsonrpc":"2.0","id":7,"error":{"code":-32000}}', // error missing message
    '{"jsonrpc":"2.0","id":7,"error":{"code":"-32000","message":"x"}}', // non-numeric code
  ];
  for (const body of bad) {
    let calls = 0;
    const records = await bridge((r, res) => {
      calls++;
      r.resume();
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(body);
    }, req + '\n');
    assert.equal(calls, 1, `must not retry, body: ${JSON.stringify(body)}`);
    assert.equal(records.length, 1, `exactly one reply, body: ${JSON.stringify(body)}`);
    assert.equal(records[0].id, 7, `correlated id, body: ${JSON.stringify(body)}`);
    assert.equal(records[0].error && records[0].error.code, -32000, `error code, body: ${JSON.stringify(body)}`);
  }
});

test('valid JSON and SSE responses are forwarded unchanged', {timeout: 15000}, async () => {
  const cases = [
    {
      ct: 'application/json',
      body: '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}',
      result: {ok: true},
    },
    {
      ct: 'application/json',
      body: '{"jsonrpc":"2.0","id":7,"result":null}',
      result: null,
    },
    {
      ct: 'application/json',
      body: '{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"boom","data":{"x":1}}}',
      error: {code: -32000, message: 'boom', data: {x: 1}},
    },
    {
      ct: 'text/event-stream',
      body: 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"sse":true}}\n\n',
      result: {sse: true},
    },
  ];
  for (const c of cases) {
    const records = await bridge((r, res) => {
      r.resume();
      res.writeHead(200, {'content-type': c.ct});
      res.end(c.body);
    }, req + '\n');
    assert.equal(records.length, 1, `one reply, ct=${c.ct}`);
    assert.equal(records[0].id, 7);
    if (c.error) assert.deepEqual(records[0].error, c.error);
    else assert.deepEqual(records[0].result, c.result);
  }
});

test('notification with 202 empty body produces no reply and exits cleanly', {timeout: 10000}, async () => {
  let calls = 0;
  const records = await bridge((r, res) => {
    calls++;
    r.resume();
    res.writeHead(202, {'content-type': 'application/json'});
    res.end('');
  }, JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
  assert.equal(calls, 1);
  assert.equal(records.length, 0);
});
