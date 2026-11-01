import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/mcp-server.js";

test("pi_spawn forwards blocked_by and spec.isolation instead of stripping them", async () => {
  let captured;
  const server = buildServer({
    spawn: async (args) => {
      captured = args;
      return { id: "s1", name: "x", status: "idle", branch: "pi/s1", worktree: "/tmp/w", pendingQuestions: [], spec: args.spec };
    },
    activeWorkers: () => 0,
    config: { parallelWarnThreshold: 4 },
  });
  const client = new Client({ name: "mcp-spawn-fields", version: "1" });
  const [s, c] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(s), client.connect(c)]);
    const tools = await client.listTools();
    const schema = tools.tools.find((tool) => tool.name === "pi_spawn").inputSchema.properties;
    assert.ok(schema.blocked_by, "blocked_by must be in the schema");
    assert.ok(schema.spec.properties.isolation, "spec.isolation must be in the schema");
    const result = await client.callTool({
      name: "pi_spawn",
      arguments: {
        blocked_by: ["dep1"],
        spec: { goal: "isolated change", scope: ["src"], isolation: "docker" },
      },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(captured.blocked_by, ["dep1"]);
    assert.equal(captured.spec.isolation, "docker");
  } finally {
    await client.close();
    await server.close();
  }
});
