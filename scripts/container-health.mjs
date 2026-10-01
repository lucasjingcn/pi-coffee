#!/usr/bin/env node
/** One bounded authenticated probe using the container's own environment. */
const port = Number(process.env.PI_COFFEE_PORT || "8787");
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
const headers = process.env.PI_COFFEE_TOKEN ? { "x-pi-coord-token": process.env.PI_COFFEE_TOKEN } : {};
try {
  const response = await fetch(`http://127.0.0.1:${port}/internal/health`, { headers, signal: AbortSignal.timeout(4000) });
  process.exit(response.ok && (await response.json()).ok === true ? 0 : 1);
} catch {
  process.exit(1);
}
