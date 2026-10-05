import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface ControlCredentials { controlKey: string; scopeKey: string }
const fail = (): never => { throw new Error("Worker control credentials are unavailable or unsafe"); };
function validateId(id: string): void {
  if (!/^s[1-9]\d*$/.test(id)) fail();
}
function validKeys(value: unknown): value is ControlCredentials {
  if (!value || typeof value !== "object") return false;
  const keys = value as ControlCredentials;
  return typeof keys.controlKey === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(keys.controlKey)
    && typeof keys.scopeKey === "string" && keys.scopeKey.length >= 1 && keys.scopeKey.length <= 4096
    && !/[\x00-\x1f\x7f]/.test(keys.scopeKey);
}

/** Local-only credential storage. Never include its contents in worker status. */
export class ControlVault {
  readonly directory: string;
  constructor(dataDir: string) { this.directory = join(dataDir, "control-credentials"); }

  private async directoryReady(create: boolean): Promise<boolean> {
    try {
      if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) fail();
      if (create) await chmod(this.directory, 0o700);
      else if ((stat.mode & 0o077) !== 0) fail();
      return true;
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return fail();
    }
  }

  async read(sessionId: string): Promise<ControlCredentials | undefined> {
    validateId(sessionId);
    if (!await this.directoryReady(false)) return undefined;
    let handle;
    try {
      handle = await open(join(this.directory, `${sessionId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1 || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid()) || stat.size > 16384) fail();
      const data: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!validKeys(data)) return fail();
      return { controlKey: data.controlKey, scopeKey: data.scopeKey };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return fail();
    } finally { await handle?.close(); }
  }

  async save(sessionId: string, controlKey: string, scopeKey: string): Promise<void> {
    validateId(sessionId);
    if (!validKeys({ controlKey, scopeKey })) fail();
    await this.directoryReady(true);
    const destination = join(this.directory, `${sessionId}.json`);
    const temp = join(this.directory, `.${sessionId}-${randomUUID()}.tmp`);
    let handle;
    try {
      // Refuse an existing unsafe target before atomically replacing a valid record.
      await this.read(sessionId);
      handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify({ controlKey, scopeKey }) + "\n");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, destination);
    } catch { fail(); }
    finally { await handle?.close(); await unlink(temp).catch(() => undefined); }
  }

  /**
   * Delete one stored credential and report whether a record was actually removed.
   *
   * Callers must first prove the session can no longer be resumed (no worktree and
   * no transcript): for a recoverable session the record must stay, because pi_resume
   * fails closed on a missing credential rather than minting a replacement.
   */
  async remove(sessionId: string): Promise<boolean> {
    validateId(sessionId);
    // Never create the directory for a removal: an absent vault has nothing to delete.
    if (!await this.directoryReady(false)) return false;
    try {
      await unlink(join(this.directory, `${sessionId}.json`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return fail();
    }
  }
}
