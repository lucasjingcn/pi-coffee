/**
 * Parsers for the two `ps` tables the daemon uses to verify that a worker's
 * process tree is really gone. Kept pure so the filtering rules (zombies,
 * malformed lines, cycles) are testable without spawning anything.
 */

import { execFile } from "node:child_process";

/** Parse `ps -Ao pid=,ppid=` output into the descendant PIDs of `rootPid`. */
export function parseDescendantPids(table: string, rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const child = Number(match[1]);
    const parent = Number(match[2]);
    const bucket = children.get(parent);
    if (bucket) bucket.push(child);
    else children.set(parent, [child]);
  }
  const out: number[] = [];
  const seen = new Set<number>();
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    if (seen.has(current)) continue; // defensive: never loop on a malformed table
    seen.add(current);
    out.push(current);
    stack.push(...(children.get(current) ?? []));
  }
  return out;
}

/**
 * PIDs from `tracked` that still run, from `ps -Ao pid=,stat=` output. Zombies
 * are already dead for our purposes, so they do not count as survivors.
 */
export function parseSurvivingPids(table: string, tracked: number[]): number[] {
  const alive = new Set<number>();
  for (const line of table.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (!match || match[2].startsWith("Z")) continue;
    alive.add(Number(match[1]));
  }
  return tracked.filter((pid) => alive.has(pid));
}

/**
 * Descendant PIDs of `rootPid` from the process table; null when it is unreadable.
 *
 * Sampling must happen while the root is still alive: once it exits, its
 * children are reparented and no longer appear under it, so a later sample
 * silently reads "no descendants".
 */
export function descendantPids(rootPid: number): Promise<number[] | null> {
  return new Promise((resolve) => {
    try {
      execFile("ps", ["-Ao", "pid=,ppid="], { timeout: 3000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(parseDescendantPids(stdout, rootPid));
      });
    } catch {
      // A denied or missing `ps` throws synchronously; no claim is possible.
      resolve(null);
    }
  });
}

/**
 * Tracked PIDs that still run (zombies are already dead) within `waitMs`.
 * Null means the process table could not be read, so no claim is possible.
 */
export function survivingDescendants(tracked: number[], waitMs: number): Promise<number[] | null> {
  const deadline = Date.now() + waitMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      try {
        execFile("ps", ["-Ao", "pid=,stat="], { timeout: 3000, windowsHide: true }, (err, stdout) => {
          if (err) return resolve(null);
          const survivors = parseSurvivingPids(stdout, tracked);
          if (survivors.length === 0) return resolve([]);
          if (Date.now() >= deadline) return resolve(survivors);
          setTimeout(tick, 50);
        });
      } catch {
        resolve(null);
      }
    };
    tick();
  });
}

/** SIGTERM then SIGKILL any tracked descendant that survived, and report the rest. */
export async function terminateSurvivingDescendants(tracked: number[]): Promise<number[]> {
  let survivors = await survivingDescendants(tracked, 1500);
  if (survivors !== null && survivors.length > 0) {
    for (const child of survivors) { try { process.kill(child, "SIGTERM"); } catch { /* already gone */ } }
    survivors = await survivingDescendants(survivors, 1500);
    if (survivors !== null && survivors.length > 0) {
      for (const child of survivors) { try { process.kill(child, "SIGKILL"); } catch { /* already gone */ } }
      survivors = await survivingDescendants(survivors, 1000);
    }
  }
  return survivors ?? [];
}
