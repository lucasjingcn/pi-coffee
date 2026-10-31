import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createDashboardHandler } from "../dist/dashboard.js";

/** Sessions the fake coordinator hands out; includes hostile names and secrets. */
function fakeSessions() {
  return [
    {
      id: "s1",
      name: "impl-dashboard",
      repo: "/workspace/repo",
      worktree: "/workspace/workers/s1",
      branch: "pi/s1",
      cwd: "/workspace/workers/s1",
      baseRef: "main",
      status: "working",
      createdAt: 1,
      lastActivity: 2,
      pendingQuestions: [{ id: "q1", method: "confirm", title: "approve?", message: "ok?" }],
      cost: 0.5,
      turns: 3,
      provider: "anthropic",
      model: "claude-sonnet",
      thinking: "high",
      tokens: { input: 10, output: 42 },
      context: { tokens: 100, contextWindow: 200000, percent: 0.05 },
      statsAt: 9,
      lastEntryId: "leaf-1",
      lastText: "worker report",
      instructionsSent: 2,
      testsOwnedByCodex: true,
      extension: true,
      spec: { goal: "ship the console", purpose: "implementation", scope: ["src/dashboard.ts"],
        requirements: [{ id: "R1", text: "endpoints exist" }] },
      acceptance: { files: ["tests/dashboard.test.mjs"], command: "npm run verify", hashes: { "tests/dashboard.test.mjs": "deadbeef" } },
      verification: {
        id: "v1", epoch: "e1", workerSha: "a".repeat(40), targetSha: "b".repeat(40), targetBranch: "main",
        candidateTree: "tree", command: "npm run verify", verifiedAt: 4, passed: true,
        changedFiles: ["src/dashboard.ts"], codeChanged: true, existingValidationChanges: [],
        reviewContractHash: "contract-hash",
        result: { code: 0, stdout: "SECRET-STDOUT", stderr: "", timedOut: false },
      },
      integration: { workerSha: "a".repeat(40), targetBranch: "main", previousTargetSha: "b".repeat(40),
        mergedSha: "d".repeat(40), candidateTree: "tree", integratedAt: 5 },
      // Secrets that must never reach the console:
      controlKeyHash: "c".repeat(64),
      scopeKeyHash: "f".repeat(64),
      workerProcess: { pid: 4242, pgid: 4242, startedAt: 3 },
      heldLocks: [{ path: "src/a.ts", mode: "rw", sessionId: "s1" }],
    },
    {
      id: "s2",
      name: '<script>alert("x")</script> & "quoted"',
      repo: "/workspace/repo",
      worktree: "/workspace/workers/s2",
      branch: "pi/s2",
      cwd: "/workspace/workers/s2",
      baseRef: "main",
      status: "idle",
      createdAt: 6,
      lastActivity: 7,
      pendingQuestions: [],
    },
  ];
}

function fakeCoordinator() {
  const sessions = fakeSessions();
  const calls = { diff: [], tail: [] };
  const find = (id) => sessions.find((session) => session.id === id);
  return {
    calls,
    list: () => sessions,
    snapshot: (id) => {
      const found = find(id);
      if (!found) throw new Error(`unknown session: ${id}`);
      return { ...found, pendingQuestions: [...found.pendingQuestions] };
    },
    // Mirrors Coordinator.get(): only live runtimes can be diffed or tailed.
    diff: async (id) => {
      calls.diff.push(id);
      if (!find(id)) throw new Error(`unknown session: ${id}`);
      return { base: "main", stat: "1 file changed", committed: "", uncommitted: "edit", untracked: [],
        status: " M src/dashboard.ts", files: ["src/dashboard.ts"] };
    },
    tail: async (id, since, max) => {
      calls.tail.push({ id, since, max });
      if (!find(id)) throw new Error(`unknown session: ${id}`);
      const entries = [{ type: "message", role: "assistant", text: "hello" }, { type: "message", role: "user", text: "next" }];
      return { entries: max === undefined ? entries : entries.slice(-max), leafId: "leaf-2" };
    },
  };
}

/** Real HTTP server around the handler; the fallback proves `false` means "not mine". */
async function withServer(deps, fn) {
  const handler = createDashboardHandler(deps);
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).then((handled) => {
      if (handled) return;
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not handled by dashboard");
    }).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Raw request so malformed paths reach the handler exactly as written. */
function rawHttp(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers ?? {} }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

/** Every JSON assertion also pins the content type. */
async function readJson(response) {
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/,
    `expected JSON content-type, got ${response.headers.get("content-type")}`);
  return response.json();
}

test("sessions list returns redacted JSON summaries", async () => {
  const coord = fakeCoordinator();
  await withServer({ coord }, async (base) => {
    const response = await fetch(`${base}/dashboard/api/sessions`);
    assert.equal(response.status, 200);
    const body = await readJson(response);
    assert.equal(body.count, 2);
    assert.deepEqual(body.sessions.map((session) => session.id), ["s1", "s2"]);

    const first = body.sessions[0];
    assert.equal(first.name, "impl-dashboard");
    assert.equal(first.status, "working");
    assert.equal(first.purpose, "implementation");
    assert.equal(first.provider, "anthropic");
    assert.equal(first.model, "claude-sonnet");
    assert.equal(first.cost, 0.5);
    assert.equal(first.turns, 3);
    assert.equal(first.branch, "pi/s1");
    assert.equal(first.worktree, "/workspace/workers/s1");
    assert.equal(first.pendingQuestions, 1);
    assert.equal(first.verified, true);
    assert.equal(first.integrated, true);
    assert.deepEqual(first.verification, {
      passed: true, verifiedAt: 4, command: "npm run verify", codeChanged: true,
      changedFiles: ["src/dashboard.ts"], existingValidationChanges: [],
    });
    assert.deepEqual(first.integration, {
      targetBranch: "main", previousTargetSha: "b".repeat(40), mergedSha: "d".repeat(40), integratedAt: 5,
    });

    // Secrets, worker process identities and raw command output never leak.
    const text = JSON.stringify(body);
    for (const secret of ["c".repeat(64), "f".repeat(64), "controlKeyHash", "scopeKeyHash", "workerProcess",
      "4242", "SECRET-STDOUT", "deadbeef", "contract-hash", "heldLocks"]) {
      assert.equal(text.includes(secret), false, `list leaked ${secret}`);
    }
  });
});

test("session detail returns a fuller record and 404s unknown sessions", async () => {
  const coord = fakeCoordinator();
  await withServer({ coord }, async (base) => {
    const detail = await readJson(await fetch(`${base}/dashboard/api/sessions/s1`));
    assert.equal(detail.session.id, "s1");
    assert.equal(detail.session.repo, "/workspace/repo");
    assert.equal(detail.session.baseRef, "main");
    assert.equal(detail.session.instructionsSent, 2);
    assert.equal(detail.session.lastEntryId, "leaf-1");
    assert.equal(detail.session.lastText, "worker report");
    assert.equal(detail.session.lastTextTruncated, false);
    assert.equal(detail.session.extension, true);
    assert.equal(detail.session.testsOwnedByCodex, true);
    assert.deepEqual(detail.session.acceptance.files, ["tests/dashboard.test.mjs"]);
    assert.equal(detail.session.spec.goal, "ship the console");
    assert.equal(JSON.stringify(detail).includes("c".repeat(64)), false);

    for (const path of ["/dashboard/api/sessions/nope", "/dashboard/api/sessions/nope/diff",
      "/dashboard/api/sessions/nope/tail"]) {
      const missing = await fetch(`${base}${path}`);
      assert.equal(missing.status, 404, path);
      const body = await readJson(missing);
      assert.equal(body.error, "unknown session");
      assert.equal(body.session, "nope");
    }
  });
});

test("diff and tail delegate to the coordinator", async () => {
  const coord = fakeCoordinator();
  await withServer({ coord }, async (base) => {
    const diff = await readJson(await fetch(`${base}/dashboard/api/sessions/s1/diff`));
    assert.equal(diff.session, "s1");
    assert.deepEqual(diff.diff.files, ["src/dashboard.ts"]);
    assert.equal(diff.diff.status, " M src/dashboard.ts");
    assert.deepEqual(coord.calls.diff, ["s1"]);

    const tail = await readJson(await fetch(`${base}/dashboard/api/sessions/s1/tail?since=leaf-1&max=1`));
    assert.equal(tail.session, "s1");
    assert.equal(tail.since, "leaf-1");
    assert.equal(tail.max, 1);
    assert.equal(tail.leafId, "leaf-2");
    assert.deepEqual(tail.entries, [{ type: "message", role: "user", text: "next" }]);
    assert.deepEqual(coord.calls.tail, [{ id: "s1", since: "leaf-1", max: 1 }]);

    // Defaults: no since, no max -> coordinator defaults apply (max stays undefined).
    const plain = await readJson(await fetch(`${base}/dashboard/api/sessions/s1/tail`));
    assert.equal(plain.since, null);
    assert.equal(plain.max, null);
    assert.equal(plain.entries.length, 2);
    assert.deepEqual(coord.calls.tail[1], { id: "s1", since: undefined, max: undefined });

    for (const query of ["max=0", "max=201", "max=abc", "max=1.5", "max=-1"]) {
      const response = await fetch(`${base}/dashboard/api/sessions/s1/tail?${query}`);
      assert.equal(response.status, 400, query);
      await readJson(response);
    }
  });
});

test("health endpoint is minimal and needs no session state details", async () => {
  const coord = fakeCoordinator();
  await withServer({ coord }, async (base) => {
    const response = await fetch(`${base}/dashboard/api/health`);
    assert.equal(response.status, 200);
    const body = await readJson(response);
    assert.equal(body.ok, true);
    assert.equal(body.readOnly, true);
    assert.equal(body.sessions, 2);
    assert.equal(typeof body.time, "string");
    assert.deepEqual(Object.keys(body).sort(), ["ok", "readOnly", "service", "sessions", "time"]);
  });
});

test("configured token gates every route and is never echoed", async () => {
  const coord = fakeCoordinator();
  const token = "s3cret-master-token";
  const paths = ["/dashboard", "/dashboard/api/health", "/dashboard/api/sessions",
    "/dashboard/api/sessions/s1", "/dashboard/api/sessions/s1/diff", "/dashboard/api/sessions/s1/tail"];
  await withServer({ coord, token }, async (base, port) => {
    for (const path of paths) {
      const anonymous = await fetch(`${base}${path}`);
      assert.equal(anonymous.status, 401, path);
      assert.equal((await readJson(anonymous)).error, "unauthorized");

      const wrong = await fetch(`${base}${path}`, { headers: { "x-pi-coord-token": "wrong-token" } });
      assert.equal(wrong.status, 401, path);

      const wrongBearer = await fetch(`${base}${path}`, { headers: { authorization: "Bearer nope" } });
      assert.equal(wrongBearer.status, 401, path);

      // A prefix of the token must not authenticate either.
      const prefix = await fetch(`${base}${path}`, { headers: { "x-pi-coord-token": token.slice(0, -1) } });
      assert.equal(prefix.status, 401, path);
    }

    // Unauthorized requests never reach the coordinator.
    assert.deepEqual(coord.calls.diff, []);
    assert.deepEqual(coord.calls.tail, []);

    // A malformed path still authenticates first, so no route shape leaks.
    const anonymousMalformed = await rawHttp(port, "/dashboard/api/sessions//diff");
    assert.equal(anonymousMalformed.status, 401);

    for (const path of paths) {
      const header = await fetch(`${base}${path}`, { headers: { "x-pi-coord-token": token } });
      assert.equal(header.status, 200, path);
      assert.equal((await header.text()).includes(token), false, `token echoed by ${path}`);

      const bearer = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(bearer.status, 200, path);
      assert.equal((await bearer.text()).includes(token), false, `token echoed by ${path}`);
    }
  });
});

test("dashboard HTML escapes hostile session names and ships a nonce-based CSP", async () => {
  const coord = fakeCoordinator();
  await withServer({ coord }, async (base) => {
    const response = await fetch(`${base}/dashboard`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[0-9a-f]{32}'/);
    const nonce = csp.match(/script-src 'nonce-([0-9a-f]{32})'/)[1];

    const html = await response.text();
    // The hostile name is escaped, in element text and in the data-session attribute.
    assert.equal(html.includes('<script>alert("x")</script>'), false, "raw script payload leaked into HTML");
    assert.equal(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;quoted&quot;"), true,
      "escaped session name missing");
    assert.equal(html.includes('data-session="s2"'), true);
    assert.equal(html.includes("impl-dashboard"), true);

    // No external assets, no inline handlers, and the nonce matches the script tag.
    assert.equal(/<script[^>]+src=/.test(html), false);
    assert.equal(/<link[^>]+href=/.test(html), false);
    assert.equal(/\son[a-z]+=/i.test(html), false);
    assert.equal(html.includes(`<script nonce="${nonce}">`), true);
    assert.match(html, /<style nonce="[0-9a-f]{32}">/);
    assert.equal(html.includes("auto refresh"), true);
  });
});

test("malformed dashboard paths return 400 and unknown routes return 404", async () => {
  const coord = fakeCoordinator();
  await withServer({ coord }, async (base, port) => {
    const malformed = [
      "/dashboard/api/sessions//diff",
      "/dashboard/api/sessions/s1/bogus",
      "/dashboard/api/sessions/s1/diff/extra",
      "/dashboard/api/sessions/",
      "/dashboard/api/health/extra",
      "/dashboard//",
      "/dashboard/api/%zz",
      "/dashboard/api/sessions/s%2F1",
    ];
    for (const path of malformed) {
      const response = await rawHttp(port, path);
      assert.equal(response.status, 400, path);
      assert.match(response.headers["content-type"] ?? "", /^application\/json/);
      assert.equal(JSON.parse(response.body).error !== undefined, true, path);
    }

    for (const path of ["/dashboard/nope", "/dashboard/api/nope"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }

    // The conventional trailing slash is the page, not a malformed path.
    const slash = await fetch(`${base}/dashboard/`);
    assert.equal(slash.status, 200);
    assert.match(slash.headers.get("content-type") ?? "", /^text\/html/);
  });
});

test("non-GET methods are rejected and unrelated paths are not handled", async () => {
  const coord = fakeCoordinator();
  await withServer({ coord }, async (base, port) => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await rawHttp(port, "/dashboard/api/sessions", { method, body: "{}",
        headers: { "content-type": "application/json", "content-length": "2" } });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.allow, "GET");
      assert.equal(coord.calls.diff.length, 0);
    }

    // The handler reports "not mine" so the daemon keeps its own routing.
    for (const path of ["/", "/mcp", "/internal/health", "/dashboardx"]) {
      const response = await rawHttp(port, path);
      assert.equal(response.status, 404, path);
      assert.equal(response.body, "not handled by dashboard", path);
    }
  });
});

test("dashboard stays read-only: only list, snapshot, diff and tail are used", async () => {
  const coord = fakeCoordinator();
  const used = new Set();
  const spy = new Proxy(coord, {
    get(target, key) {
      if (typeof target[key] === "function") used.add(key);
      return target[key];
    },
  });
  await withServer({ coord: spy }, async (base) => {
    await fetch(`${base}/dashboard`);
    await fetch(`${base}/dashboard/api/health`);
    await fetch(`${base}/dashboard/api/sessions`);
    await fetch(`${base}/dashboard/api/sessions/s1`);
    await fetch(`${base}/dashboard/api/sessions/s1/diff`);
    await fetch(`${base}/dashboard/api/sessions/s1/tail`);
  });
  assert.deepEqual([...used].sort(), ["diff", "list", "snapshot", "tail"]);
});
