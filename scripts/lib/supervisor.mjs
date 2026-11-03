#!/usr/bin/env node
/**
 * Which supervisor (if any) runs the daemon on this machine, and how to stop or
 * restart it.
 *
 * `scripts/upgrade.mjs` needs this because the correct stop sequence differs per
 * supervisor: systemd's `Restart=on-failure` ignores a graceful exit, while a
 * launchd agent with `KeepAlive` starts the *old* build again seconds after a
 * graceful shutdown — which made `npm run upgrade` look successful while the
 * daemon kept running stale code, and then made the installer refuse to run
 * because the daemon was "running".
 *
 * Pure lookups only: nothing here executes a command. The caller decides.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LAUNCHD_LABEL = "com.picoffee.daemon";
const WINDOWS_TASK_NAME = "pi-coffee";

/** LaunchAgent plist the macOS installer writes. */
function launchdPlistPath(home = homedir()) {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** `launchctl` target (`gui/<uid>/<label>`) for the per-user agent. */
export function launchdTarget(uid) {
  return `gui/${uid}/${LAUNCHD_LABEL}`;
}

/** argv that unloads the agent without restarting it (`KeepAlive` is ignored). */
export function launchdBootoutArgs(uid) {
  return ["bootout", launchdTarget(uid)];
}

/**
 * Supervisor installing this daemon, or `undefined` when it runs in the
 * foreground (`node scripts/start.mjs`).
 *
 * @param {{platform?: NodeJS.Platform, home?: string, exists?: (path: string) => boolean, taskRegistered?: () => boolean}} [input]
 */
export function detectSupervisor(input = {}) {
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  const exists = input.exists ?? existsSync;
  if (platform === "darwin") {
    return exists(launchdPlistPath(home)) ? "launchd" : undefined;
  }
  if (platform === "linux") {
    if (exists(join(home, ".config", "systemd", "user", "pi-coffee.service"))) return "systemd-user";
    if (exists("/etc/systemd/system/pi-coffee.service")) return "systemd-system";
    return undefined;
  }
  if (platform === "win32") {
    const registered = input.taskRegistered ? input.taskRegistered() : false;
    return registered ? "windows-task" : undefined;
  }
  return undefined;
}

/**
 * Command an operator can run to start the daemon again after an upgrade.
 *
 * Windows registers a *scheduled task*, not a service: `Restart-Service
 * pi-coffee` failed with "Cannot find any service with service name 'pi-coffee'"
 * and the task does not act as a supervisor for a graceful (exit 0) shutdown.
 */
export function restartCommand(kind, { uid = "$(id -u)" } = {}) {
  switch (kind) {
    case "launchd":
      return `launchctl kickstart -k ${launchdTarget(uid)}`;
    case "systemd-user":
      return "systemctl --user restart pi-coffee";
    case "systemd-system":
      return "systemctl restart pi-coffee";
    case "windows-task":
      return `Start-ScheduledTask -TaskName ${WINDOWS_TASK_NAME}`;
    default:
      return "node scripts/start.mjs";
  }
}

/**
 * What to do after the daemon stopped on a launchd host: the agent was unloaded,
 * so the installer (which bootstraps it again) is what loads the new build.
 */
export const LAUNCHD_NEXT_STEP = "npm run install:local";
