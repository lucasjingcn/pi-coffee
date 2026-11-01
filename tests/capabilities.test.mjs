import test from "node:test";
import assert from "node:assert/strict";
import { capabilitiesPayload, DAEMON_FEATURES } from "../dist/capabilities.js";
import { MCP_TOOL_ORDER } from "../dist/mcp-server.js";
import { PI_COFFEE_VERSION } from "../dist/version.js";

test("capabilities payload advertises version, features and the exact tool order", () => {
  const payload = capabilitiesPayload({ workerStartupPolicy: "policy", internalEndpoints: ["/internal/hello"] });
  assert.equal(payload.api, "pi-coffee-internal/1");
  assert.equal(payload.version, PI_COFFEE_VERSION);
  assert.deepEqual(payload.mcp_tools, [...MCP_TOOL_ORDER]);
  assert.deepEqual(payload.features, [...DAEMON_FEATURES]);
  assert.deepEqual(payload.internal_endpoints, ["/internal/hello"]);
  assert.equal(payload.workerStartupPolicy, "policy");
  for (const feature of ["docker-sandbox", "acp-runner", "merge-queue", "dependency-gate"]) {
    assert.ok(payload.features.includes(feature));
  }
});
