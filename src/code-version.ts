import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** pi_status hint when the daemon executes code older than the built dist. */
export const CODE_STALE_HINT = "restart daemon to load current code";

/** Result of comparing the daemon's recorded dist mtime with the disk value now. */
export interface CodeVersionStatus {
  stale: boolean;
  /** mtimeMs copied into memory when the daemon started; null when dist was absent. */
  runningDistMtimeMs: number | null;
  /** mtimeMs of dist/manager.js read at check time; null when it is absent. */
  diskDistMtimeMs: number | null;
  hint?: string;
}

/** What the daemon captures once at startup and pi_status compares against disk. */
export interface CodeVersionRecord {
  dir: string;
  distMtimeMs: number | null;
}

/**
 * Package root that would load `<root>/dist/manager.js` on restart. Resolved
 * from this module's own location so it works from both src (tsx) and dist.
 */
export function daemonCodeDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** mtimeMs of `<dir>/dist/manager.js`, or null when it is missing or not a file. */
function distMtimeMs(dir: string): number | null {
  try {
    const stat = statSync(join(dir, "dist", "manager.js"));
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

/** Copy the on-disk mtime of dist/manager.js into memory at daemon startup. */
export function recordCodeVersion(dir: string): number | null {
  return distMtimeMs(dir);
}

/** Compare the recorded startup value with the mtime of dist/manager.js right now. */
export function checkCodeVersion(dir: string, recorded: number | null): CodeVersionStatus {
  const diskDistMtimeMs = distMtimeMs(dir);
  const stale = diskDistMtimeMs !== recorded;
  return {
    stale,
    runningDistMtimeMs: recorded,
    diskDistMtimeMs,
    ...(stale ? { hint: CODE_STALE_HINT } : {}),
  };
}
