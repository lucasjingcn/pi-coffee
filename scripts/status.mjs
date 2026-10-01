#!/usr/bin/env node
/**
 * Live view of pi-coffee workers. Polls the daemon and prints a table.
 *
 *   node scripts/status.mjs             # one snapshot
 *   watch -n2 'node scripts/status.mjs' # live
 */
import { envFilePath, loadEnvFile } from "./lib/env.mjs";

loadEnvFile(envFilePath(), { override: true });
const endpoint = new URL(process.env.PI_COFFEE_URL || `http://127.0.0.1:${process.env.PI_COFFEE_PORT || 8787}`);
const BASE = endpoint.origin;
const headers = process.env.PI_COFFEE_TOKEN ? { "x-pi-coord-token": process.env.PI_COFFEE_TOKEN } : {};

async function get(path) {
  const response = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  return response.json();
}

let sessions, locks;
try {
  [sessions, locks] = await Promise.all([get("/internal/sessions"), get("/internal/locks")]);
  if (!Array.isArray(sessions.sessions) || !Array.isArray(locks.locks)) throw new Error("invalid daemon status response");
} catch (error) {
  console.error(`pi-coffee status unavailable: ${error.message}`);
  process.exit(1);
}

const list = sessions.sessions || [];
const active = list.filter((s) => ["starting", "idle", "working"].includes(s.status)).length;
const working = list.filter((s) => s.status === "working").length;

console.log(`pi-coffee @ ${BASE}   ${new Date().toLocaleTimeString()}`);
console.log(`sessions: ${list.length}  |  active: ${active}  |  working(pi busy): ${working}`);
if (list.length) {
  console.log("");
  for (const s of list) {
    const cost = typeof s.cost === "number" ? `¥${s.cost.toFixed(4)}` : "-";
    console.log(
      `  ${String(s.id).padEnd(4)} ${String(s.status).padEnd(8)} ${String(s.model || "-").padEnd(16)} ` +
        `instr=${String(s.instructionsSent ?? 0).padEnd(2)} ${String(s.outcome || "unrecorded").padEnd(15)} ${cost}`,
    );
    if (s.lastText) console.log(`        last: ${s.lastText.replace(/\s+/g, " ").slice(0, 90)}`);
  }
}
console.log(`\nlocks: ${(locks.locks || []).length}`);
for (const l of locks.locks || []) console.log(`  ${l.sessionId} ${l.mode} ${l.path}`);
