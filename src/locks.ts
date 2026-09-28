import { isAbsolute, normalize, resolve } from "node:path";

export type LockMode = "rw" | "ro";

export interface Lock {
  path: string;
  mode: LockMode;
  sessionId: string;
  ts: number;
  /**
   * Repository identity (realpath of the absolute Git common dir) this lock belongs to.
   * Optional for backwards compatibility with standalone/legacy registries, which use "".
   */
  repo?: string;
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

/** Unambiguous composite key: JSON encodes the namespace, session and path boundaries. */
function lockKey(repo: string | undefined, sessionId: string, path: string): string {
  return JSON.stringify([repo ?? "", sessionId, path]);
}

/**
 * Advisory file-lock registry. Locks are namespaced by repository identity so identical paths in
 * separate repositories never conflict, and are scoped per session. Within one namespace, locks
 * conflict when paths overlap (same file or nested directories) and at least one is rw.
 *
 * Paths are normalized to absolute form relative to the owning session root so two sessions'
 * worktree paths (which differ!) still map to the same repo-relative identity. Callers pass
 * repo-relative paths; the manager rewrites absolute worktree paths before calling here.
 *
 * Namespace defaults to "" so a standalone LockManager keeps working without repository identity.
 */
export class LockManager {
  private locks = new Map<string, Lock>();

  claim(sessionId: string, paths: string[], mode: LockMode, repo = ""): ClaimResult {
    const namespace = repo;
    const normalized = paths.map((p) => normalizeAbs(p));
    const conflicts: Lock[] = [];
    for (const p of normalized) {
      for (const lock of this.locks.values()) {
        if (lock.sessionId === sessionId) continue;
        if ((lock.repo ?? "") !== namespace) continue; // namespace is compared before paths
        if (overlap(p, lock.path) && conflicts_(mode, lock.mode)) conflicts.push(lock);
      }
    }
    if (conflicts.length > 0) {
      return { ok: false, granted: [], conflicts: dedupe(conflicts) };
    }
    // Grant/refresh
    for (const p of normalized) {
      const key = lockKey(namespace, sessionId, p);
      const existing = this.locks.get(key);
      if (existing) {
        existing.mode = mode;
        existing.ts = Date.now();
      } else {
        this.locks.set(key, { path: p, mode, sessionId, ts: Date.now(), repo: namespace });
      }
    }
    return { ok: true, granted: normalized, conflicts: [] };
  }

  /**
   * Release a session's locks. `paths` omitted releases everything the session holds in the
   * namespace; passing `repo` restricts to that namespace. Omitting `repo` releases across all
   * namespaces (legacy standalone behavior).
   */
  release(sessionId: string, paths?: string[], repo?: string): number {
    let n = 0;
    if (!paths) {
      for (const [k, l] of [...this.locks]) {
        if (l.sessionId !== sessionId) continue;
        if (repo !== undefined && (l.repo ?? "") !== repo) continue;
        this.locks.delete(k);
        n++;
      }
      return n;
    }
    const targets = paths.map(normalizeAbs);
    for (const [k, l] of [...this.locks]) {
      if (l.sessionId !== sessionId) continue;
      if (repo !== undefined && (l.repo ?? "") !== repo) continue;
      if (targets.some((t) => overlap(t, l.path))) {
        this.locks.delete(k);
        n++;
      }
    }
    return n;
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
    for (const l of locks) this.locks.set(lockKey(l.repo, l.sessionId, l.path), l);
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
    const k = lockKey(l.repo, l.sessionId, l.path);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}
