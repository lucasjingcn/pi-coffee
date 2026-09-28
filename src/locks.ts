import { isAbsolute, normalize, resolve } from "node:path";

export type LockMode = "rw" | "ro";

export interface Lock {
  path: string;
  mode: LockMode;
  sessionId: string;
  ts: number;
}

export interface ClaimResult {
  ok: boolean;
  granted: string[];
  conflicts: Lock[];
}

function overlap(a: string, b: string): boolean {
  if (a === b) return true;
  const da = a.endsWith("/") ? a : a + "/";
  const db = b.endsWith("/") ? b : b + "/";
  return da.startsWith(db) || db.startsWith(da);
}

function conflicts(a: LockMode, b: LockMode): boolean {
  return a === "rw" || b === "rw";
}

/**
 * Advisory file-lock registry. Locks are scoped per session and conflict when
 * paths overlap (same file or nested directories) and at least one is rw.
 *
 * Paths are normalized to absolute form relative to the owning session root so
 * two sessions' worktree paths (which differ!) still map to the same repo-relative
 * identity. Callers pass repo-relative paths; the manager rewrites them.
 */
export class LockManager {
  private locks = new Map<string, Lock>();

  claim(sessionId: string, paths: string[], mode: LockMode): ClaimResult {
    const normalized = paths.map((p) => normalizeAbs(p));
    const conflicts: Lock[] = [];
    for (const p of normalized) {
      for (const lock of this.locks.values()) {
        if (lock.sessionId === sessionId) continue;
        if (overlap(p, lock.path) && conflicts_(mode, lock.mode)) conflicts.push(lock);
      }
    }
    if (conflicts.length > 0) {
      return { ok: false, granted: [], conflicts: dedupe(conflicts) };
    }
    // Grant/refresh
    for (const p of normalized) {
      const existing = [...this.locks.values()].find((l) => l.path === p && l.sessionId === sessionId);
      if (existing) {
        existing.mode = mode;
        existing.ts = Date.now();
      } else {
        this.locks.set(`${sessionId}:${p}`, { path: p, mode, sessionId, ts: Date.now() });
      }
    }
    return { ok: true, granted: normalized, conflicts: [] };
  }

  release(sessionId: string, paths?: string[]): number {
    let n = 0;
    if (!paths) {
      for (const [k, l] of [...this.locks]) {
        if (l.sessionId === sessionId) {
          this.locks.delete(k);
          n++;
        }
      }
      return n;
    }
    const targets = paths.map(normalizeAbs);
    for (const [k, l] of [...this.locks]) {
      if (l.sessionId !== sessionId) continue;
      if (targets.some((t) => overlap(t, l.path))) {
        this.locks.delete(k);
        n++;
      }
    }
    return n;
  }

  releaseAll(sessionId: string): number {
    return this.release(sessionId);
  }

  list(): Lock[] {
    return [...this.locks.values()].sort((a, b) => a.ts - b.ts);
  }

  export(): Lock[] {
    return this.list();
  }

  import(locks: Lock[]): void {
    this.locks.clear();
    for (const l of locks) this.locks.set(`${l.sessionId}:${l.path}`, l);
  }
}

function normalizeAbs(p: string): string {
  const abs = isAbsolute(p) ? p : resolve("/", p);
  return normalize(abs).replace(/\/+$/, "") || "/";
}

function conflicts_(a: LockMode, b: LockMode): boolean {
  return conflicts(a, b);
}

function dedupe(locks: Lock[]): Lock[] {
  const seen = new Set<string>();
  const out: Lock[] = [];
  for (const l of locks) {
    const k = `${l.sessionId}:${l.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}
