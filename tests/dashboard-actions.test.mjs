import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createDashboardHandler } from "../dist/dashboard.js";

function fakeCoord() {
  const calls = [];
  return {
    calls,
    audit: { append: async (...args) => { calls.push(["audit", ...args]); } },
    list: () => [],
    allSessions: () => [],
    setOutcome: async (...args) => { calls.push(["finish", ...args]); },
    send: async (...args) => { calls.push(["send", ...args]); },
    merge: async (...args) => { calls.push(["merge", ...args]); },
    stop: async (...args) => { calls.push(["stop", ...args]); },
    diff: async () => "",
    tail: async () => ({ entries: [], leafId: null }),
    snapshot: () => ({ instructionsSent: 0 }),
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

test("actions enforce header, content-type, origin and confirmation guards", () => {
  const coord = fakeCoord();
  return withServer({ coord, token: TOKEN, actions: true }, async (base) => {
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
    const denials = coord.calls.filter((call) => call[0] === "audit" && call[2] === "dashboard_denied");
    assert.ok(denials.length >= 4, "every rejected action must be audited");
  });
});

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
    // The two-strikes limit travels with the send so the coordinator can enforce
    // it atomically (see the dedicated gate test below).
    ["send", "s1", "continue with fixes", "prompt", true, { maxInstructions: 2 }],
    ["finish", "s1", "success_first", "read-only accepted"],
    ["stop", "s1", { preserveWorktree: true }],
  ]);
});

test("finish records the outcome the operator asks for", async () => {
  const coord = fakeCoord();
  await withServer({ coord, token: TOKEN, actions: true }, async (base) => {
    const second = await fetch(`${base}/dashboard/api/actions/sessions/s1/finish`, {
      method: "POST",
      headers: actionHeaders(TOKEN, { "x-pi-coffee-confirm": "s1" }),
      body: JSON.stringify({ note: "needed a correction", outcome: "success_second" }),
    });
    assert.equal(second.status, 200);
    // `abandoned` belongs to pi_stop, and an unknown value must not be recorded.
    const bogus = await fetch(`${base}/dashboard/api/actions/sessions/s1/finish`, {
      method: "POST",
      headers: actionHeaders(TOKEN, { "x-pi-coffee-confirm": "s1" }),
      body: JSON.stringify({ note: "x", outcome: "abandoned" }),
    });
    assert.equal(bogus.status, 400);
  });
  assert.deepEqual(coord.calls, [["finish", "s1", "success_second", "needed a correction"]]);
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


test("enabling dashboard actions without a token is a startup error", async () => {
  const { loadConfig } = await import("../dist/config.js");
  assert.throws(() => loadConfig({ dashboardActions: true }), /PI_COFFEE_DASHBOARD_ACTIONS/);
});


test("dashboard send delegates the two-strikes gate to the coordinator", async () => {
  // Checking `instructionsSent` in the dashboard and sending afterwards was a
  // read-then-act window: two concurrent clicks both passed the gate. The gate
  // now lives (and reserves the slot) inside Coordinator.send.
  const coord = fakeCoord();
  coord.send = async (...args) => {
    coord.calls.push(["send", ...args]);
    throw new Error("two-strikes gate: this session already has 2 instruction(s); take the work over instead");
  };
  await withServer({ coord, token: TOKEN, actions: true }, async (base) => {
    const response = await fetch(`${base}/dashboard/api/actions/sessions/s1/send`, {
      method: "POST", headers: actionHeaders(TOKEN), body: JSON.stringify({ message: "one more fix" }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /two-strikes gate/);
  });
  // The dashboard passes its limit so the coordinator can enforce it atomically.
  const sends = coord.calls.filter((call) => call[0] === "send");
  assert.equal(sends.length, 1);
  assert.equal(sends[0][5].maxInstructions, 2);
});
