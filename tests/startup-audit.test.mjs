import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeEnvFile} from '../scripts/lib/env.mjs';

function run(script, env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.once('error', reject);
    child.once('close', code => resolve({code, stdout, stderr}));
  });
}
function cleanEnv() {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (key.startsWith('PI_COFFEE_')) delete env[key];
  return env;
}
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-startup-audit-'));
  const server = createServer((req, res) => {
    if (req.headers['x-pi-coord-token'] !== 'fixture-token') { res.writeHead(401); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/internal/health') res.end(JSON.stringify({ok: true}));
    else if (req.url === '/internal/sessions') res.end(JSON.stringify({sessions: [{id: 's-fixture', status: 'idle'}]}));
    else res.end(JSON.stringify({locks: []}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = String(server.address().port);
  try { await fn(dir, port); } finally {
    server.closeAllConnections(); await new Promise(r => server.close(r));
    await rm(dir, {recursive: true, force: true});
  }
}

test('status loads daemon settings, authenticates and accepts MCP endpoint URLs', async () => fixture(async (dir, port) => {
  const file = join(dir, 'env');
  // The file only fills gaps: the exported port wins (the file's `1` is a trap)
  // while the token, which the shell does not export, still comes from the file.
  writeEnvFile({PI_COFFEE_PORT: '1', PI_COFFEE_TOKEN: 'fixture-token'}, file);
  const env = {...cleanEnv(), PI_COFFEE_ENV_FILE: file, PI_COFFEE_PORT: port};
  const result = await run('scripts/status.mjs', env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /sessions: 1/);
  assert.match(result.stdout, /s-fixture/);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-token/);
  const endpoint = await run('scripts/status.mjs', {...env, PI_COFFEE_URL: `http://127.0.0.1:${port}/mcp`});
  assert.equal(endpoint.code, 0, endpoint.stderr);
  assert.match(endpoint.stdout, /sessions: 1/);
}));

test('status rejects unauthorized responses instead of printing an empty scoreboard', async () => fixture(async (dir, port) => {
  const result = await run('scripts/status.mjs', {...cleanEnv(), PI_COFFEE_ENV_FILE: join(dir, 'missing'), PI_COFFEE_PORT: port});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /401/);
  assert.doesNotMatch(result.stdout, /sessions: 0/);
}));

test('container health authenticates at the configured port and fails unauthorized probes', async () => fixture(async (dir, port) => {
  const env = {...cleanEnv(), PI_COFFEE_PORT: port, PI_COFFEE_TOKEN: 'fixture-token'};
  assert.equal((await run('scripts/container-health.mjs', env)).code, 0);
  assert.equal((await run('scripts/container-health.mjs', {...env, PI_COFFEE_TOKEN: 'wrong'})).code, 1);
  const docker = await readFile('Dockerfile', 'utf8');
  const compose = await readFile('docker-compose.yml', 'utf8');
  assert.match(docker, /COPY scripts\/container-health\.mjs/);
  assert.match(docker, /CMD node scripts\/container-health\.mjs/);
  // `ps` proves worker process ownership; the runtime image must ship it.
  assert.match(docker, /apt-get install -y --no-install-recommends [^\n]*procps/);
  assert.match(docker, /ARG PI_VERSION=/, "the bundled pi version is pinned");
  assert.match(docker, /@earendil-works\/pi-coding-agent@\$\{PI_VERSION\}/);
  assert.match(compose, /127\.0\.0\.1:\$\{PI_COFFEE_HOST_PORT:-8787\}:8787/);
  assert.match(compose, /scripts\/container-health\.mjs/);
}));

test('doctor uses daemon env precedence and background checks require persisted credentials', async () => fixture(async (dir) => {
  const file = join(dir, 'env');
  // A private HOME keeps a real ~/.pi/agent/auth.json from supplying credentials:
  // the machine running this test must not be able to make the check pass.
  const home = join(dir, 'home');
  writeEnvFile({PI_COFFEE_PROVIDER: 'deepseek', PI_COFFEE_DATA_DIR: join(dir, 'data'), DEEPSEEK_API_KEY: 'fixture-key'}, file);
  const env = {...cleanEnv(), HOME: home, USERPROFILE: home, PI_COFFEE_ENV_FILE: file, PI_COFFEE_PROVIDER: 'openai', OPENAI_API_KEY: 'fixture-only-shell-key'};
  // An exported value wins over the settings file, exactly like scripts/start.mjs:
  // otherwise the doctor reports on a provider the daemon is not running with.
  // This is the interactive form (`npm run doctor`), where a transient shell key
  // is a legitimate credential; persistence is what --background demands.
  const result = await run('scripts/doctor.mjs', env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ok\s+credentials for openai/);
  assert.doesNotMatch(result.stdout, /credentials for deepseek/);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-key|fixture-only-shell-key/);
  writeEnvFile({PI_COFFEE_PROVIDER: 'pi-audit-no-auth-provider', PI_COFFEE_DATA_DIR: join(dir, 'data')}, file);
  // The exported provider still wins, and its key exists only in the shell, so the
  // background check must fail: nothing persisted would let a service start.
  const background = await run('scripts/doctor.mjs', {...env, PI_AUDIT_NO_AUTH_PROVIDER_API_KEY: 'shell-only'}, ['--background']);
  assert.match(background.stdout, /FAIL\s+credentials for openai/);
  assert.equal(background.code, 1);
}));

test('every launcher and client script uses the daemon env precedence', async () => {
  const start = await readFile('scripts/start.mjs', 'utf8');
  assert.match(start, /loadEnvFile\(envFilePath\(\), \{ override: false \}\)/);
  assert.doesNotMatch(start, /override: true/);
  // The proxy, health probe, status, inspect, doctor, upgrade and setup-dsh used
  // to let the file win, so a conflicting PI_COFFEE_PORT/TOKEN/DATA_DIR made them
  // talk to a different daemon than the launcher started.
  for (const script of ['proxy', 'check-health', 'status', 'inspect', 'doctor', 'upgrade', 'setup-dsh']) {
    const text = await readFile(`scripts/${script}.mjs`, 'utf8');
    assert.match(text, /loadDaemonEnv\(/, `${script} must load the settings file like the daemon`);
    assert.doesNotMatch(text, /override: true/, `${script} must not let the file override the environment`);
  }
});
