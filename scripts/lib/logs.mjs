#!/usr/bin/env node
/**
 * Rotation for the supervisor-managed daemon log files.
 *
 * launchd and systemd open StandardErrorPath/StandardOutputPath *before* the
 * daemon starts and keep that file descriptor for the life of the process, so
 * renaming a full log would send every later line into the rotated name.
 * Rotation is therefore copytruncate: archive the content, then truncate the
 * same inode in place.
 *
 * Truncating a file this process does not own would destroy another daemon's
 * history, so a file is only touched when it is the very file backing one of
 * this process's own standard descriptors (checked by device+inode).
 *
 * Knobs: `PI_COFFEE_LOG_MAX_MB` (default 5, `0` disables rotation) and
 * `PI_COFFEE_LOG_KEEP` (default 1).
 */
import { copyFileSync, existsSync, fstatSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_KEEP = 1;

/** Log file names written by the platform supervisors (macOS/Linux split, Windows combined). */
export const DAEMON_LOG_NAMES = ["daemon.err.log", "daemon.out.log", "daemon.log"];

/** Directory the installers point their supervisors at; independent of PI_COFFEE_DATA_DIR. */
export function defaultLogDir(home = homedir()) {
  return join(home, ".pi-coffee", "logs");
}

/** Resolve the rotation knobs from the environment, falling back to the defaults on garbage. */
export function rotationOptionsFromEnv(env = process.env) {
  const maxMb = Number.parseFloat(String(env.PI_COFFEE_LOG_MAX_MB ?? "").trim());
  const keep = Number.parseInt(String(env.PI_COFFEE_LOG_KEEP ?? "").trim(), 10);
  return {
    maxBytes: Number.isFinite(maxMb) ? Math.max(0, Math.round(maxMb * 1024 * 1024)) : DEFAULT_MAX_BYTES,
    keep: Number.isInteger(keep) && keep >= 1 ? keep : DEFAULT_KEEP,
  };
}

/** True when `fd` is the very file `path` names, so truncating it is safe. */
export function fdOwnsPath(fd, path) {
  try {
    const fdStat = fstatSync(fd);
    const fileStat = statSync(path);
    return fdStat.dev === fileStat.dev && fdStat.ino === fileStat.ino;
  } catch {
    return false;
  }
}

/**
 * copytruncate one log file when it is over the limit.
 *
 * Returns `{ path, rotated, reason, size? }`; `reason` is one of `missing`,
 * `disabled`, `under-limit`, or `rotated`.
 */
export function rotateLog(path, { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = {}) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return { path, rotated: false, reason: "missing" };
  }
  const limit = Number.isFinite(maxBytes) ? maxBytes : DEFAULT_MAX_BYTES;
  if (!(limit > 0)) return { path, rotated: false, reason: "disabled", size };
  if (size <= limit) return { path, rotated: false, reason: "under-limit", size };

  const archives = Number.isInteger(keep) && keep >= 1 ? keep : DEFAULT_KEEP;
  // Shift older archives up (archive 3 -> 4, ...), then archive the live file.
  for (let index = archives - 1; index >= 1; index -= 1) {
    const from = `${path}.${index}`;
    if (!existsSync(from)) continue;
    const to = `${path}.${index + 1}`;
    rmSync(to, { force: true });
    renameSync(from, to);
  }
  copyFileSync(path, `${path}.1`);
  // Same inode: the descriptor the supervisor opened keeps writing here.
  truncateSync(path, 0);
  return { path, rotated: true, reason: "rotated", size };
}

/**
 * Rotate every configured log file that this process writes to via `fds`.
 *
 * Files that are missing, empty, under the limit, or backed by a descriptor
 * this process does not hold are left untouched (a no-op in the container and
 * in foreground mode, where stderr is a pipe or a terminal).
 */
export function rotateOwnedLogs({
  logDir = defaultLogDir(),
  names = DAEMON_LOG_NAMES,
  fds = [1, 2],
  maxBytes = DEFAULT_MAX_BYTES,
  keep = DEFAULT_KEEP,
} = {}) {
  const results = [];
  for (const name of names) {
    const path = join(logDir, name);
    if (!existsSync(path)) continue;
    if (!fds.some((fd) => fdOwnsPath(fd, path))) continue;
    results.push({ name, ...rotateLog(path, { maxBytes, keep }) });
  }
  return results;
}
