import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

/** Validate before creating a worktree or reserving locks. */
export function acceptancePath(path: string): string {
  if (!path || path.includes("\0") || isAbsolute(path)) throw new Error("acceptance path must be worktree-relative");
  const parts = path.split(/[\\/]/);
  if (parts.some((p) => p === ".." || p === ".git")) throw new Error("acceptance path cannot traverse parents or Git metadata");
  const normalized = normalize(path);
  if (normalized === "." || normalized.endsWith(sep)) throw new Error("acceptance path must name a file");
  return normalized;
}

/** Existing checkout symlinks must never redirect coordinator writes outside the worktree. */
export async function writeAcceptanceFile(root: string, path: string, content: string): Promise<void> {
  const target = resolve(root, acceptancePath(path));
  const rel = relative(resolve(root), target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("acceptance path escapes worktree");
  let parent = resolve(root);
  for (const part of relative(parent, dirname(target)).split(sep).filter(Boolean)) {
    parent = join(parent, part);
    try {
      await mkdir(parent);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("acceptance parent must be a real directory");
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("acceptance target must be a regular file");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(target, content, "utf8");
}
