#!/usr/bin/env node
/**
 * Smooth upgrade of a running pi-coffee daemon.
 *
 *   node scripts/upgrade.mjs [--timeout=<seconds>] [--reason=<text>]
 *
 * 1. Puts the daemon in drain mode, so no new worker is spawned or resumed.
 * 2. Polls until no worker is active any more (bounded by --timeout, default 300s).
 * 3. Stops the daemon. With no supervisor it asks the daemon to stop itself
 *    (`POST /internal/shutdown`) and never signals a pid. A launchd agent with
 *    `KeepAlive` is different: a graceful exit makes launchd start the *old*
 *    build again within seconds, so the agent is booted out instead
 *    (`launchctl bootout`) — that is what makes the upgrade take effect, and it
 *    is why the installer no longer refuses with "pi-coffee is running".
 * 4. Prints the command that brings the daemon back (or, for launchd, the
 *    installer that re-bootstraps it with the new build).
 *
 * If the wait times out, the drain is cancelled so the daemon keeps working: a
 * half-drained daemon would otherwise silently refuse new work.
 */
import { execFileSync } from "node:child_process";
import { loadDaemonEnv } from "./lib/env.mjs";
import { sleep } from "./lib/cli.mjs";
import {
  LAUNCHD_NEXT_STEP,
  detectSupervisor,
  launchdBootoutArgs,
  launchdTarget,
  restartCommand as supervisorRestartCommand,
} from "./lib/supervisor.mjs";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: node scripts/upgrade.mjs [--timeout=<seconds>] [--reason=<text>]");
  process.exit(0);
}

function flag(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found === undefined ? fallback : found.slice(prefix.length);
}

const timeoutSeconds = Number(flag("timeout", "300"));
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86_400) {
  console.error("error: --timeout must be a positive number of seconds (max 86400)");
  process.exit(2);
}
const reason = flag("reason", `upgrade via scripts/upgrade.mjs (pid ${process.pid})`);

loadDaemonEnv();

const base = new URL(process.env.PI_COFFEE_URL || `http://127.0.0.1:${process.env.PI_COFFEE_PORT || 8787}`).origin;
const headers = { "content-type": "application/json" };
if (process.env.PI_COFFEE_TOKEN) headers["x-pi-coord-token"] = process.env.PI_COFFEE_TOKEN;


async function request(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

const uid = typeof process.getuid === "function" ? process.getuid() : "$(id -u)";
/** Set once at startup: launchd/systemd/none, from the same layout the installers write. */
const supervisor = detectSupervisor({
  // A scheduled task is invisible to the filesystem; ask schtasks, and treat a
  // failing query (task absent) as "no supervisor".
  taskRegistered: () => {
    try {
      execFileSync("schtasks", ["/query", "/tn", "pi-coffee"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
});

/** The restart command of the supervisor this installation uses; never executed here. */
function restartCommand() {
  return supervisorRestartCommand(supervisor, { uid });
}

/** Unload the launchd agent so it cannot restart the old build behind our back. */
function bootoutLaunchd() {
  try {
    execFileSync("launchctl", launchdBootoutArgs(uid), { stdio: "ignore" });
    return true;
  } catch (error) {
    console.error(`error: launchctl ${launchdBootoutArgs(uid).join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function healthy() {
  try {
    const response = await fetch(`${base}/internal/health`, { headers, signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function fail(message) {
  console.error(`error: ${message}`);
  // Never leave the daemon draining on a failed upgrade: cancel is idempotent.
  // `request` resolves for any HTTP status, so the reply must be inspected rather
  // than trusted.
  const cancelled = await request("/internal/drain", { action: "cancel" }).catch(() => undefined);
  if (cancelled?.ok && cancelled.body?.draining === false) {
    console.error(`the daemon at ${base} is not draining any more; no worker was stopped`);
  } else {
    console.error(
      `warning: the daemon at ${base} may still be draining (cancel returned `
        + `${cancelled ? `HTTP ${cancelled.status}: ${JSON.stringify(cancelled.body)}` : "no response"}).\n`
        + "         New spawns and resumes will be rejected until you run: pi_drain action=cancel",
    );
  }
  process.exit(1);
}

const started = await request("/internal/drain", { action: "start", reason }).catch((error) => {
  console.error(`error: cannot reach the daemon at ${base}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
if (!started.ok || started.body?.draining !== true) {
  console.error(`error: the daemon refused to drain (HTTP ${started.status}: ${JSON.stringify(started.body)})`);
  process.exit(1);
}
console.log(`draining ${base}: new spawns and resumes are rejected; waiting for active workers to finish`);

const deadline = Date.now() + timeoutSeconds * 1000;
let status = started.body;
let lastReported = -1;
while (status.active > 0 && Date.now() < deadline) {
  if (status.active !== lastReported) {
    lastReported = status.active;
    const ids = Array.isArray(status.activeSessions) && status.activeSessions.length
      ? ` (${status.activeSessions.join(", ")})`
      : "";
    console.log(`  active workers: ${status.active}${ids}`);
  }
  await sleep(500);
  const polled = await request("/internal/drain", { action: "status" }).catch(() => undefined);
  if (!polled?.ok) await fail("the daemon stopped answering drain status during the wait");
  // A truncated reply must not crash the poller with a TypeError and leave the
  // daemon draining: keep the last good state instead.
  if (typeof polled.body?.active === "number") status = polled.body;
}

if (status.active > 0) {
  console.error(`error: ${status.active} worker(s) still active after ${timeoutSeconds}s; the upgrade was not applied`);
  await fail(`drain timed out after ${timeoutSeconds}s`);
}

console.log("all workers are idle: no worker is active");

if (supervisor === "launchd") {
  console.log(`unloading the LaunchAgent (${launchdTarget(uid)}) so launchd cannot restart the old build`);
  if (!bootoutLaunchd()) {
    await fail("could not unload the LaunchAgent; the daemon is still draining");
  }
  // bootout sends SIGTERM: the daemon drains its workers and exits; launchd has
  // nothing left to restart.
  let down = false;
  for (let i = 0; i < 40 && !down; i += 1) {
    await sleep(500);
    down = !(await healthy());
  }
  if (!down) {
    await fail(`the LaunchAgent was unloaded but ${base} still answers; stop it and rerun the upgrade`);
  }
  console.log("the daemon stopped and the LaunchAgent is unloaded (it will not restart the old build)");
  console.log(`update the checkout, then bring it back with: ${LAUNCHD_NEXT_STEP}`);
  console.log("sessions that were active when the daemon stopped are resumed automatically on the next start");
  process.exit(0);
}

const stop = await request("/internal/shutdown", { action: "stop" }).catch((error) => ({
  status: 0,
  ok: false,
  body: { error: error instanceof Error ? error.message : String(error) },
}));
if (!stop.ok) {
  // `fail` cancels the drain first: leaving the daemon draining would reject
  // every later pi_spawn/pi_resume until an operator noticed.
  await fail(`the daemon refused to stop (HTTP ${stop.status}: ${JSON.stringify(stop.body)}). `
    + `Stop it yourself once you are ready, then restart it with: ${restartCommand()}`);
}
console.log("the daemon accepted a graceful shutdown (no process was signalled by this script)");

// A supervisor with KeepAlive/Restart=always brings the daemon back on its own.
let restarted = false;
for (let i = 0; i < 30 && !restarted; i += 1) {
  await sleep(500);
  restarted = await healthy();
}
if (restarted) {
  console.log(`${base} is healthy again: the supervisor restarted the daemon`);
} else {
  console.log(`restart it with: ${restartCommand()}`);
}
console.log("sessions that were active at an unclean shutdown are resumed automatically on the next start");
