import { isAbsolute, normalize, resolve } from "node:path";

export type LockMode = "rw" | "ro";

export interface Lock {
  path: string;
  mode: LockMode;
  sessionId: string;
  ts: number;
  /**
   * Repository identity (realpath of the absolute Git common dir) this lock
   * belongs to. Optional so legacy/standalone registries can omit it; those use "".
   */
  repo?: string;
}

export interface ClaimResult {
  ok: boolean;
  granted: string[];
  conflicts: Lock[];
}

/**
 * Advisory file-lock registry.
 *
 * Locks are namespaced by repository identity, so the same path in two different
 * repos never conflicts; within a namespace they are scoped per session. Two
 * paths collide when one contains the other (or they are equal) and at least one
 * holder wants write access.
 */
export class LockManager {
  private locks = new Map<string, Lock>();

  claim(sessionId: string, paths: string[], mode: LockMode, repo = ""): ClaimResult {
    const namespace = repo;
    const normalized = paths.map(normalizeAbs);
    const conflicting: Lock[] = [];

    for (const path of normalized) {
      for (const lock of this.locks.values()) {
        if (lock.sessionId === sessionId) continue;
        if ((lock.repo ?? "") !== namespace) continue;
        if (overlap(path, lock.path) && modesConflict(mode, lock.mode)) conflicting.push(lock);
      }
    }

    if (conflicting.length > 0) {
      return { ok: false, granted: [], conflicts: dedupe(conflicting) };
    }

    // No conflicts: grant the claim, refreshing the timestamp of any lock the
    // same session already holds on the same path.
    for (const path of normalized) {
      const key = lockKey(namespace, sessionId, path);
      const existing = this.locks.get(key);
      if (existing) {
        existing.mode = mode;
        existing.ts = Date.now();
      } else {
        this.locks.set(key, { path, mode, sessionId, ts: Date.now(), repo: namespace });
      }
    }
    return { ok: true, granted: normalized, conflicts: [] };
  }

  /**
   * Release a session's locks. With no `paths`, release everything it holds;
   * pass `repo` to limit the release to one namespace. Omitting `repo` releases
   * across all namespaces, which is the behavior standalone callers expect.
   */
  release(sessionId: string, paths?: string[], repo?: string): number {
    let released = 0;

    if (!paths) {
      for (const [key, lock] of [...this.locks]) {
        if (lock.sessionId !== sessionId) continue;
        if (repo !== undefined && (lock.repo ?? "") !== repo) continue;
        this.locks.delete(key);
        released++;
      }
      return released;
    }

    const targets = paths.map(normalizeAbs);
    for (const [key, lock] of [...this.locks]) {
      if (lock.sessionId !== sessionId) continue;
      if (repo !== undefined && (lock.repo ?? "") !== repo) continue;
      if (targets.some((target) => overlap(target, lock.path))) {
        this.locks.delete(key);
        released++;
      }
    }
    return released;
  }

  releaseAll(sessionId: string, repo?: string): number {
    return this.release(sessionId, undefined, repo);
  }

  list(): Lock[] {
    return [...this.locks.values()].sort((a, b) => a.ts - b.ts);
  }

  export(): Lock[] {
    return this.list();
  }

  import(locks: Lock[]): void {
    this.locks.clear();
    for (const lock of locks) this.locks.set(lockKey(lock.repo, lock.sessionId, lock.path), lock);
  }
}

/** Normalize a path to an absolute, slash-terminated-free form. */
function normalizeAbs(path: string): string {
  const absolute = isAbsolute(path) ? path : resolve("/", path);
  return normalize(absolute).replace(/\/+$/, "") || "/";
}

/** True when `a` and `b` are the same path or one is a parent directory of the other. */
function overlap(a: string, b: string): boolean {
  if (a === b) return true;
  const dirA = a.endsWith("/") ? a : `${a}/`;
  const dirB = b.endsWith("/") ? b : `${b}/`;
  return dirA.startsWith(dirB) || dirB.startsWith(dirA);
}

/** Only write access conflicts; two read locks can coexist. */
function modesConflict(a: LockMode, b: LockMode): boolean {
  return a === "rw" || b === "rw";
}

/** A JSON tuple keeps namespace/session/path boundaries unambiguous. */
function lockKey(repo: string | undefined, sessionId: string, path: string): string {
  return JSON.stringify([repo ?? "", sessionId, path]);
}

function dedupe(locks: Lock[]): Lock[] {
  const seen = new Set<string>();
  const out: Lock[] = [];
  for (const lock of locks) {
    const key = lockKey(lock.repo, lock.sessionId, lock.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lock);
  }
  return out;
}
