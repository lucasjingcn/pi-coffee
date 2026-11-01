/** Machine-readable daemon capability manifest shared by /internal/capabilities and tests. */
import { MCP_TOOL_ORDER } from "./mcp-server.js";
import { PI_COFFEE_VERSION } from "./version.js";

export const DAEMON_FEATURES = [
  "evidence-bundles",
  "validator-chain",
  "hash-chained-audit",
  "docker-sandbox",
  "acp-runner",
  "pull-requests",
  "merge-queue",
  "dashboard-actions",
  "dependency-gate",
] as const;

export function capabilitiesPayload(opts: { workerStartupPolicy: string; internalEndpoints: string[] }) {
  return {
    ok: true,
    api: "pi-coffee-internal/1",
    version: PI_COFFEE_VERSION,
    features: [...DAEMON_FEATURES],
    mcp_tools: [...MCP_TOOL_ORDER],
    internal_endpoints: [...opts.internalEndpoints],
    workerStartupPolicy: opts.workerStartupPolicy,
  };
}
