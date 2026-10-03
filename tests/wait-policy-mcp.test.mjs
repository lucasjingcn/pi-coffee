import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/mcp-server.js";

async function fixture(fn) {
  const calls = [];
  const result = {
    timedOut: true,
    sessions: [{ id: "s1", status: "working", pendingQuestions: [], lastText: "full report" }],
  };
  const server = buildServer({
    wait: async (...args) => { calls.push(args); return result; },
  });
  const client = new Client({ name: "wait-policy-test", version: "1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = (args = {}) => client.callTool({ name: "pi_wait", arguments: { session_ids: ["s1"], ...args } });
    await fn({ calls, result, client, call });
  } finally {
    await client.close();
    await server.close();
  }
}

const body = (response) => JSON.parse(response.content[0].text);

test("pi_wait defaults to a 30-second window and explains expiry without claiming worker failure", () => fixture(async ({ calls, call }) => {
  const response = await call();
  assert.notEqual(response.isError, true);
  assert.deepEqual(calls, [[["s1"], "settled", 30_000, undefined]]);
  const value = body(response);
  assert.equal(value.timedOut, true);
  assert.equal(value.sessions[0].status, "working");
  assert.equal(value.sessions[0].outcome, "unrecorded");
  assert.equal(value.sessions[0].lastText, undefined);
  assert.match(value.wait_hint, /does not stop workers or indicate task failure/);
  assert.match(value.wait_hint, /statuses and handoff/);
  assert.match(value.wait_hint, /new call/);
}));

test("pi_wait preserves explicit windows, notice cursors and full detail for compatible clients", () => fixture(async ({ calls, call }) => {
  for (const timeout of [0, 45_000, 90_000, 120_000]) {
    const response = await call({ timeout_ms: timeout, until: "question", after_notice_ids: ["seen"], detail: "full" });
    assert.notEqual(response.isError, true);
    assert.deepEqual(calls.at(-1), [["s1"], "question", timeout, ["seen"]]);
    assert.equal(body(response).sessions[0].lastText, "full report");
  }
  for (const timeout of [-1, 120_001, 0.5]) {
    assert.equal((await call({ timeout_ms: timeout })).isError, true);
  }
  assert.equal(calls.length, 4);
}));

test("pi_wait does not suggest re-polling on a completed window", () => fixture(async ({ result, call }) => {
  result.timedOut = false;
  result.sessions[0].status = "idle";
  const value = body(await call());
  assert.equal(value.timedOut, false);
  assert.equal(value.wait_hint, undefined);
}));

test("MCP discovery exposes safe polling rules without relying on an installed skill", () => fixture(async ({ client }) => {
  const tool = (await client.listTools()).tools.find((item) => item.name === "pi_wait");
  assert.match(tool.description, /30000ms/);
  assert.match(tool.description, /one blocking wait per codemode script/);
  assert.match(tool.description, /new codemode call/);
  assert.match(tool.inputSchema.properties.timeout_ms.description, /outer.*deadline/);
  assert.equal(tool.inputSchema.properties.timeout_ms.maximum, 120_000);
  assert.match(client.getInstructions(), /30000ms/);
  assert.match(client.getInstructions(), /one blocking wait per codemode script/);
  const prompt = await client.getPrompt({ name: "orchestrate" });
  assert.match(prompt.messages[0].content.text, /pi_wait.*30000ms/);
  assert.match(prompt.messages[0].content.text, /timedOut:true/);
  assert.match(prompt.messages[0].content.text, /new codemode call/);
}));
