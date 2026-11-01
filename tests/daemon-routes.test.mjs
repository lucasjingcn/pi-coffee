import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../dist/audit.js";

const token = "route-token";

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function daemonFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-routes-"));
  const port = await freePort();
  const env = {
    ...process.env,
    PI_COFFEE_HOST: "127.0.0.1",
    PI_COFFEE_PORT: String(port),
    PI_COFFEE_DATA_DIR: join(root, "data"),
    PI_COFFEE_WORKSPACE_ROOT: join(root, "workers"),
    PI_COFFEE_DEFAULT_REPO: join(root, "repo"),
    PI_COFFEE_TOKEN: token,
    PI_COFFEE_AUTO_CLEAN: "0",
    // Never read the real ~/.pi credential store from a daemon fixture.
    PI_CODING_AGENT_DIR: join(root, "pi-agent"),
  };
  const proc = spawn(process.execPath, ["dist/index.js"], { env, stdio: "ignore" });
  const closed = new Promise((resolve) => proc.once("close", resolve));
  const base = `http://127.0.0.1:${port}`;
  const auth = { "x-pi-coord-token": token };
  try {
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      try {
        ready = (await fetch(`${base}/internal/health`, { headers: auth })).ok;
      } catch { /* still starting */ }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(ready, "daemon did not become healthy");
    await fn({ base, auth, root });
  } finally {
    proc.kill("SIGTERM");
    const timer = setTimeout(() => proc.kill("SIGKILL"), 3000);
    await closed;
    clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
}

test("metrics endpoint hides behind the token and exposes Prometheus text", async () => {
  await daemonFixture(async ({ base, auth }) => {
    const unauthorized = await fetch(`${base}/metrics`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${base}/metrics`, { headers: auth });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain; version=0\.0\.4/);
    const body = await response.text();
    assert.match(body, /^# HELP pi_coffee_uptime_seconds /m);
    assert.match(body, /^# TYPE pi_coffee_uptime_seconds gauge$/m);
    assert.match(body, /^pi_coffee_active_workers \d+$/m);
    assert.match(body, /^pi_coffee_max_sessions \d+$/m);
    assert.match(body, /^pi_coffee_draining [01]$/m);
    assert.doesNotMatch(body, /token|controlKeyHash|scopeKeyHash/i);
  });
});

test("metrics rejects non-GET methods with 405", async () => {
  await daemonFixture(async ({ base, auth }) => {
    const response = await fetch(`${base}/metrics`, { method: "POST", headers: auth });
    assert.equal(response.status, 405);
  });
});

test("dashboard serves HTML and API behind the token", async () => {
  await daemonFixture(async ({ base, auth }) => {
    assert.equal((await fetch(`${base}/dashboard`)).status, 401);

    const page = await fetch(`${base}/dashboard`, { headers: auth });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    const html = await page.text();
    assert.match(html, /pi-coffee/);
    assert.match(html, /orchestrator console/);
    assert.match(html, /<table>/);
    assert.doesNotMatch(html, /route-token/);

    const api = await fetch(`${base}/dashboard/api/sessions`, { headers: auth });
    assert.equal(api.status, 200);
    const body = await api.json();
    assert.ok(Array.isArray(body.sessions));
  });
});

test("health exposes drain state for the upgrade script", async () => {
  await daemonFixture(async ({ base, auth }) => {
    const health = await (await fetch(`${base}/internal/health`, { headers: auth })).json();
    assert.equal(health.ok, true);
    assert.equal(health.draining, false);
    assert.equal(health.active, 0);
  });
});

test("capabilities lists every internal route the daemon serves", async () => {
  await daemonFixture(async ({ base, auth }) => {
    const response = await fetch(`${base}/internal/capabilities`, { headers: auth });
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const route of ["/internal/sessions", "/internal/locks", "/internal/health", "/internal/shutdown",
      "/internal/audit/verify", "/internal/claim", "/internal/board/post"]) {
      assert.ok(body.internal_endpoints.includes(route), `missing ${route}`);
    }
    // Every advertised route must really answer.
    for (const route of ["/internal/sessions", "/internal/locks", "/internal/audit/verify"]) {
      const probe = await fetch(`${base}${route}`, { headers: auth });
      assert.equal(probe.status, 200, route);
    }
  });
});

test("the audit verification route reports a tampered chain, not a healthy one", async () => {
  await daemonFixture(async ({ base, auth, root }) => {
    // The route is operator-facing: without the token it must not answer.
    assert.equal((await fetch(`${base}/internal/audit/verify`)).status, 401);

    const log = new AuditLog({ dir: join(root, "data", "audit") });
    await log.append("orchestrator", "spawn", "s1");
    await log.append("orchestrator", "merge", "s1");

    const clean = await (await fetch(`${base}/internal/audit/verify`, { headers: auth })).json();
    assert.equal(clean.ok, true);
    assert.equal(clean.entries, 2);

    const file = join(root, "data", "audit", "audit-0001.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const entry = JSON.parse(lines[0]);
    entry.target = "someone-else";
    lines[0] = JSON.stringify(entry);
    await writeFile(file, lines.join("\n") + "\n");

    const broken = await (await fetch(`${base}/internal/audit/verify`, { headers: auth })).json();
    assert.equal(broken.ok, false);
    assert.equal(broken.firstBrokenSeq, 1);
  });
});

test("an oversized internal body is reported as 413", async () => {
  await daemonFixture(async ({ base, auth }) => {
    const response = await fetch(`${base}/internal/send`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ to: "s1", text: "x".repeat(33 * 1024 * 1024) }),
    });
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.match(body.error, /exceeds 32 MiB/);
  });
});
