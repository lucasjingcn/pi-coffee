import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** pi_status hint when the daemon executes code older than the built dist. */
export const CODE_STALE_HINT = "restart daemon to load current code";

/** Result of comparing the daemon's recorded dist fingerprint with the disk value now. */
interface CodeVersionStatus {
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
  /** sha256 of the whole dist directory at capture time; absent/null when dist was absent. */
  distSha256?: string | null;
}

/**
 * Package root that would load `<root>/dist/manager.js` on restart. Resolved
 * from this module's own location so it works from both src (tsx) and dist.
 */
export function daemonCodeDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * mtime + content hash of the whole `<dir>/dist`, or null when it is missing.
 *
 * Fingerprinting only `dist/manager.js` missed the common case: editing
 * `src/mcp-server.ts` (or any other module) and rebuilding rewrites that file
 * while manager.js keeps identical bytes, so `pi_status` kept reporting
 * `stale: false` for a daemon that was running old logic. Hashing every emitted
 * file is what the "restart daemon to load current code" hint actually promises;
 * dist is a few hundred kilobytes, so the cost is negligible at status cadence.
 */
function distFingerprint(dir: string): { mtimeMs: number; sha256: string } | null {
  const dist = join(dir, "dist");
  let names: string[];
  try {
    names = readdirSync(dist).filter((name) => !name.startsWith(".")).sort();
  } catch {
    return null;
  }
  const hash = createHash("sha256");
  let mtimeMs = 0;
  let files = 0;
  for (const name of names) {
    const path = join(dist, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files += 1;
    mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
    hash.update(`${name}\0${stat.size}\0`);
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  if (files === 0) return null;
  return { mtimeMs, sha256: hash.digest("hex") };
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
