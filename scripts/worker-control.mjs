#!/usr/bin/env node
import { join } from "node:path";
import { loadEnvFile } from "./lib/env.mjs";

const [sessionId, ...flags] = process.argv.slice(2);
if (!/^s[1-9]\d*$/.test(sessionId || "") || flags.length > 1 || flags.some(flag => !["--show-key", "--stop"].includes(flag))) {
  console.error("Usage: node scripts/worker-control.mjs <session_id> [--show-key | --stop]");
  process.exitCode = 1;
} else {
  try {
    loadEnvFile();
    const { loadConfig } = await import("../dist/config.js");
    const { ControlVault } = await import("../dist/control-vault.js");
    const config = loadConfig();
    const vault = new ControlVault(config.dataDir);
    const credentials = await vault.read(sessionId);
    if (!credentials) throw new Error("missing credentials");
    if (flags.includes("--show-key")) {
      console.error("Sensitive output: stdout contains worker control credentials. Do not share or log it.");
      console.log(JSON.stringify({ session_id: sessionId, control_key: credentials.controlKey, scope_key: credentials.scopeKey }));
    } else if (flags.includes("--stop")) {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const client = new Client({ name: "pi-coffee-local-control", version: "1.0.0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(process.env.PI_COFFEE_URL || `http://${config.host}:${config.port}/mcp`), {
          requestInit: { headers: config.token ? { "x-pi-coord-token": config.token } : {} },
        }));
        const result = await client.callTool({ name: "pi_stop", arguments: {
          session_id: sessionId, control_key: credentials.controlKey, remove_worktree: false, delete_branch: false, preserve_worktree: true,
        } });
        if (result.isError) throw new Error("stop rejected");
        console.log(JSON.stringify({ session_id: sessionId, stop_confirmed: true, worktree_preserved: true, branch_preserved: true }));
      } finally { await client.close(); }
    } else {
      console.log(JSON.stringify({ session_id: sessionId, credentials_available: true, credential_path: join(vault.directory, `${sessionId}.json`) }));
    }
  } catch {
    console.error("Worker control operation failed. Check local credentials and daemon availability; no successful stop is confirmed.");
    process.exitCode = 1;
  }
}
