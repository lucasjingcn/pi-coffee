import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createDashboardHandler } from "../dist/dashboard.js";

function fakeCoord() {
  const calls = [];
  return {
    calls,
    list: () => [],
    setOutcome: async (...args) => { calls.push(["finish", ...args]); },
    send: async (...args) => { calls.push(["send", ...args]); },
    merge: async (...args) => { calls.push(["merge", ...args]); },
    stop: async (...args) => { calls.push(["stop", ...args]); },
    diff: async () => "",
    tail: async () => ({ entries: [], leafId: null }),
  };
}

async function withServer(deps, fn) {
  const handler = createDashboardHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) { res.writeHead(404); res.end("not found"); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function actionHeaders(token, extra = {}) {
  return { authorization: `Bearer ${token}`, "x-pi-coffee-action": "1", "content-type": "application/json", ...extra };
}

const TOKEN = "dashboard-token";

test("actions stay disabled unless explicitly enabled", () =>
  withServer({ coord: fakeCoord(), token: TOKEN, actions: false }, async (base) => {
    const response = await fetch(`${base}/dashboard/api/actions/sessions/s1/merge`, {
      method: "POST", headers: actionHeaders(TOKEN, { "x-pi-coffee-confirm": "s1" }), body: "{}",
    });
    assert.equal(response.status, 405);
  }));

test("actions require both a configured token and a presented token", async () => {
  const coord = fakeCoord();
  await withServer({ coord, actions: true }, async (base) => {
    const response = await fetch(`${base}/dashboard/api/actions/sessions/s1/merge`, {
      method: "POST", headers: actionHeaders(TOKEN, { "x-pi-coffee-confirm": "s1" }), body: "{}",
    });
    assert.equal(response.status, 403);
  });
  await withServer({ coord, token: TOKEN, actions: true }, async (base) => {
    const response = await fetch(`${base}/dashboard/api/actions/sessions/s1/merge`, {
      method: "POST", headers: { "x-pi-coffee-action": "1", "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 401);
  });
});

test("actions enforce header, content-type, origin and confirmation guards", () =>
  withServer({ coord: fakeCoord(), token: TOKEN, actions: true }, async (base) => {
    const missingHeader = await fetch(`${base}/dashboard/api/actions/sessions/s1/merge`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(missingHeader.status, 403);

    const badType = await fetch(`${base}/dashboard/api/actions/sessions/s1/merge`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-pi-coffee-action": "1", "content-type": "text/plain" }, body: "{}",
    });
    assert.equal(badType.status, 415);

    const badOrigin = await fetch(`${base}/dashboard/api/actions/sessions/s1/merge`, {
      method: "POST", headers: actionHeaders(TOKEN, { origin: "https://evil.example", "x-pi-coffee-confirm": "s1" }), body: "{}",
    });
    assert.equal(badOrigin.status, 403);

    const noConfirm = await fetch(`${base}/dashboard/api/actions/sessions/s1/merge`, {
      method: "POST", headers: actionHeaders(TOKEN), body: "{}",
    });
    assert.equal(noConfirm.status, 400);
  }));

test("valid actions call the coordinator with explicit arguments", async () => {
  const coord = fakeCoord();
  await withServer({ coord, token: TOKEN, actions: true }, async (base) => {
    const merge = await fetch(`${base}/dashboard/api/actions/sessions/s1/merge`, {
      method: "POST", headers: actionHeaders(TOKEN, { "x-pi-coffee-confirm": "s1" }), body: "{}",
    });
    assert.equal(merge.status, 200);
    const send = await fetch(`${base}/dashboard/api/actions/sessions/s1/send`, {
      method: "POST", headers: actionHeaders(TOKEN), body: JSON.stringify({ message: "continue with fixes" }),
    });
    assert.equal(send.status, 200);
    const finish = await fetch(`${base}/dashboard/api/actions/sessions/s1/finish`, {
      method: "POST", headers: actionHeaders(TOKEN, { "x-pi-coffee-confirm": "s1" }), body: JSON.stringify({ note: "read-only accepted" }),
    });
    assert.equal(finish.status, 200);
    const stop = await fetch(`${base}/dashboard/api/actions/sessions/s1/stop`, {
      method: "POST", headers: actionHeaders(TOKEN, { "x-pi-coffee-confirm": "s1" }), body: "{}",
    });
    assert.equal(stop.status, 200);
  });
  assert.deepEqual(coord.calls, [
    ["merge", "s1"],
    ["send", "s1", "continue with fixes", "prompt"],
    ["finish", "s1", "success_first", "read-only accepted"],
    ["stop", "s1", { preserveWorktree: true }],
  ]);
});

test("messages and unknown routes are rejected before dispatch", async () => {
  const coord = fakeCoord();
  await withServer({ coord, token: TOKEN, actions: true }, async (base) => {
    const empty = await fetch(`${base}/dashboard/api/actions/sessions/s1/send`, {
      method: "POST", headers: actionHeaders(TOKEN), body: "{}",
    });
    assert.equal(empty.status, 400);
    const unknown = await fetch(`${base}/dashboard/api/actions/sessions/s1/explode`, {
      method: "POST", headers: actionHeaders(TOKEN, { "x-pi-coffee-confirm": "s1" }), body: "{}",
    });
    assert.equal(unknown.status, 404);
  });
  assert.deepEqual(coord.calls, []);
});

test("the HTML only advertises actions when they are enabled", async () => {
  await withServer({ coord: fakeCoord(), token: TOKEN, actions: true }, async (base) => {
    const response = await fetch(`${base}/dashboard`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = await response.text();
    assert.match(body, /actions enabled/);
    assert.match(body, /x-pi-coffee-action/);
  });
  await withServer({ coord: fakeCoord(), token: TOKEN, actions: false }, async (base) => {
    const response = await fetch(`${base}/dashboard`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = await response.text();
    assert.match(body, /read-only/);
    assert.doesNotMatch(body, /x-pi-coffee-action/);
  });
});
