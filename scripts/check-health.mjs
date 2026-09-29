#!/usr/bin/env node
/** Verify the just-installed background daemon without exposing credentials. */
import { envFilePath, loadEnvFile } from "./lib/env.mjs";

loadEnvFile(envFilePath(), { override: true });
const port = Number(process.env.PI_COFFEE_PORT || "8787");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PI_COFFEE_PORT");
const url = `http://127.0.0.1:${port}/internal/health`;
const headers = process.env.PI_COFFEE_TOKEN ? { "x-pi-coord-token": process.env.PI_COFFEE_TOKEN } : {};
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(1500) });
    if (response.ok && (await response.json()).ok === true) {
      console.log(`pi-coffee is healthy at http://127.0.0.1:${port}/mcp`);
      process.exit(0);
    }
  } catch { /* daemon may still be starting */ }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
console.error("pi-coffee did not become healthy. Check the background task or service logs.");
process.exit(1);
