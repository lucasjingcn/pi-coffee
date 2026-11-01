import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** pi_status hint when the daemon executes code older than the built dist. */
export const CODE_STALE_HINT = "restart daemon to load current code";

/** Result of comparing the daemon's recorded dist fingerprint with the disk value now. */
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
  /** sha256 of dist/manager.js at capture time; absent/null when dist was absent. */
  distSha256?: string | null;
}

/**
 * Package root that would load `<root>/dist/manager.js` on restart. Resolved
 * from this module's own location so it works from both src (tsx) and dist.
 */
export function daemonCodeDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** mtime + content hash of `<dir>/dist/manager.js`, or null when it is missing. */
function distFingerprint(dir: string): { mtimeMs: number; sha256: string } | null {
  try {
    const path = join(dir, "dist", "manager.js");
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    return { mtimeMs: stat.mtimeMs, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
  } catch {
    return null;
  }
}

/** Copy the on-disk fingerprint of dist/manager.js into memory at daemon startup. */
export function recordCodeVersion(dir: string): CodeVersionRecord {
  const fingerprint = distFingerprint(dir);
  return { dir, distMtimeMs: fingerprint?.mtimeMs ?? null, distSha256: fingerprint?.sha256 ?? null };
}

/**
 * Compare the recorded startup fingerprint with dist/manager.js right now.
 *
 * mtime alone is not proof: `cp -p`, rsync `-t` and container/image layers can
 * restore an old mtime onto new bytes. When both sides have a content hash the
 * hash decides; otherwise the mtime comparison is kept for callers/tests that
 * only recorded a timestamp.
 */
export function checkCodeVersion(dir: string, recorded: CodeVersionRecord | number | null): CodeVersionStatus {
  const runningDistMtimeMs = typeof recorded === "number" || recorded === null ? recorded : recorded.distMtimeMs;
  const runningSha = typeof recorded === "object" && recorded !== null && typeof recorded.distSha256 === "string"
    ? recorded.distSha256
    : null;
  const fingerprint = distFingerprint(dir);
  const diskDistMtimeMs = fingerprint?.mtimeMs ?? null;
  const stale = runningSha !== null && fingerprint !== null
    ? fingerprint.sha256 !== runningSha
    : diskDistMtimeMs !== runningDistMtimeMs;
  return {
    stale,
    runningDistMtimeMs,
    diskDistMtimeMs,
    ...(stale ? { hint: CODE_STALE_HINT } : {}),
  };
}
