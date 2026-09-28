#!/usr/bin/env node
/**
 * Live view of pi-coffee workers. Polls the daemon and prints a table.
 *
 *   node scripts/status.mjs             # one snapshot
 *   watch -n2 'node scripts/status.mjs' # live
 */
const BASE = process.env.PI_COFFEE_URL || `http://127.0.0.1:${process.env.PI_COFFEE_PORT || 8787}`;

async function get(path) {
  try {
    const r = await fetch(`${BASE}${path}`);
    return r.ok ? await r.json() : { error: r.status };
  } catch (e) {
    return { error: String(e) };
  }
}

const [sessions, locks] = await Promise.all([get("/internal/sessions"), get("/internal/locks")]);
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
