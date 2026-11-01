import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuditLog } from "../dist/audit.js";
import { buildServer } from "../dist/mcp-server.js";

/*
 * The chain and its verifier existed, but nothing outside the test suite could
 * reach `AuditLog.verify()`: an edited log stayed invisible to every deployed
 * daemon. These tests pin the production surface (`pi_audit`, and the route in
 * daemon-routes.test.mjs) to the same verdict.
 */

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-audit-mcp-"));
  const log = new AuditLog({ dir: join(root, "audit") });
  const server = buildServer({ audit: log }, { dir: join(root, "dist"), distMtimeMs: 0 });
  const client = new Client({ name: "audit-test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await fn({ log, root, client });
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function call(client, args) {
  const result = await client.callTool({ name: "pi_audit", arguments: args });
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}

test("pi_audit reports a clean chain and the newest entries", () =>
  fixture(async ({ log, client }) => {
    await log.append("orchestrator", "spawn", "s1", { repo: "/r" });
    await log.append("orchestrator", "merge", "s1", { target: "main" });

    const verified = await call(client, {});
    assert.equal(verified.isError, false);
    assert.equal(verified.body.ok, true);
    assert.equal(verified.body.entries, 2);

    const tailed = await call(client, { action: "tail", limit: 1 });
    assert.equal(tailed.isError, false);
    assert.deepEqual(tailed.body.entries.map((entry) => entry.action), ["merge"]);
  }));

test("pi_audit fails loudly on an edited entry instead of reporting a healthy log", () =>
  fixture(async ({ log, root, client }) => {
    await log.append("orchestrator", "spawn", "s1");
    await log.append("orchestrator", "merge", "s1");
    const file = join(root, "audit", "audit-0001.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const entry = JSON.parse(lines[0]);
    entry.target = "someone-else";
    lines[0] = JSON.stringify(entry);
    await writeFile(file, lines.join("\n") + "\n");

    const broken = await call(client, { action: "verify" });
    assert.equal(broken.isError, true, "a broken chain must be an error result, not a silent ok");
    assert.equal(broken.body.ok, false);
    assert.equal(broken.body.firstBrokenSeq, 1);
    assert.match(broken.body.reason, /payload hash mismatch/);
  }));
