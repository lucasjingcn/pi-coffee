import { execFile } from 'node:child_process';

/** Persisted ownership proof; never sufficient without checking live identity. */
export interface WorkerProcessIdentity { pid: number; platform: string; started: string }

function validate(identity: WorkerProcessIdentity): void {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 1 ||
      typeof identity.platform !== 'string' || !identity.platform ||
      typeof identity.started !== 'string' || !identity.started.trim()) {
    throw new Error('invalid worker process identity; retain locks');
  }
}

async function probe(pid: number): Promise<{started: string; pgid: number} | null> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'pgid='], {timeout: 2000}, (err, stdout) => {
      if (err) {
        // ps exits 1 with empty output for an absent PID. Other failures are
        // not absence evidence and must not permit lock release.
        if ((err as unknown as {code?: string | number}).code === 1 && !stdout.trim()) resolve(null);
        else reject(new Error('cannot verify worker process ownership; retain locks'));
        return;
      }
      const match = stdout.trim().match(/^(.*?)\s+(\d+)$/);
      if (!match || !match[1]) { reject(new Error('invalid process ownership probe; retain locks')); return; }
      resolve({started: match[1].trim(), pgid: Number(match[2])});
    });
  });
}

export async function captureWorkerProcess(pid: number): Promise<WorkerProcessIdentity> {
  const identity = {pid, platform: process.platform, started: 'unsupported'};
  validate(identity);
  if (process.platform === 'win32') return identity;
  const live = await probe(pid);
  if (!live || live.pgid !== pid) throw new Error('worker is not a live owned process group leader');
  identity.started = live.started;
  return identity;
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw err;
  }
}

/** Recover only a provably owned POSIX group. Windows orphan recovery requires
 * a native persistent job object and is intentionally manual; no automatic
 * lock release based only on disappearance of its root PID. */
export async function stopOwnedWorker(identity: WorkerProcessIdentity): Promise<void> {
  validate(identity);
  if (identity.platform !== process.platform) throw new Error('worker platform differs; retain locks');
  if (identity.platform === 'win32') throw new Error('automatic Windows orphan recovery unsupported; retain locks');
  if (!groupExists(identity.pid)) return;
  const live = await probe(identity.pid);
  if (!live || live.pgid !== identity.pid || live.started !== identity.started) {
    throw new Error('cannot establish live worker group ownership; retain locks');
  }
  const signal = (value: NodeJS.Signals) => {
    try { process.kill(-identity.pid, value); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('worker group termination failed; retain locks'); }
  };
  const wait = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (groupExists(identity.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    return !groupExists(identity.pid);
  };
  signal('SIGTERM');
  if (await wait(1000)) return;
  signal('SIGKILL');
  if (!await wait(3000)) throw new Error('worker group exit not confirmed; retain locks');
}
