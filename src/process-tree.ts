/**
 * Parsers for the two `ps` tables the daemon uses to verify that a worker's
 * process tree is really gone. Kept pure so the filtering rules (zombies,
 * malformed lines, cycles) are testable without spawning anything.
 */

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
