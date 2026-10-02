import { chmod, copyFile, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"];
const REMOTE_SOURCE = /^(?:npm:|git:|github:|https?:|ssh:|builtin:)/;
export const WORKER_STARTUP_POLICY = "private-agent-config-v1";

/**
 * Glob allowlist of global plugins a worker may inherit: package sources,
 * external extension entries, and MCP server names. Empty denies all;
 * `["*"]` enables the legacy behavior of inheriting everything.
 */
export type WorkerPluginAllowlist = readonly string[];

/** Shell-style glob match: `*` spans anything, `?` matches one character. */
function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\*/g, ".*").replace(/\\\?/g, ".")}$`).test(value);
}

function pluginAllowed(plugins: WorkerPluginAllowlist, value: string): boolean {
  return plugins.some(pattern => pattern === "*" || globMatch(pattern, value));
}

function allowsAllPlugins(plugins: WorkerPluginAllowlist): boolean {
  return plugins.includes("*");
}

/**
 * Drop package and external-extension entries the policy does not allow. Core
 * `builtin:` entries always survive because they ship with pi rather than with
 * the global plugin set.
 */
function applyWorkerPluginPolicy(settings: Record<string, unknown>, plugins: WorkerPluginAllowlist): void {
  if (allowsAllPlugins(plugins)) return;
  if (Array.isArray(settings.packages)) {
    settings.packages = settings.packages.filter(value => {
      const source = typeof value === "string"
        ? value
        : value && typeof value === "object" && typeof (value as { source?: unknown }).source === "string"
          ? (value as { source: string }).source
          : "";
      return source !== "" && pluginAllowed(plugins, source);
    });
  }
  if (Array.isArray(settings.extensions)) {
    settings.extensions = settings.extensions.filter(value => {
      if (typeof value !== "string") return false;
      const marker = /^[!+-]/.test(value) ? value[0] : "";
      const target = value.slice(marker.length).trim();
      if (target.startsWith("builtin:")) return true;
      return target !== "" && pluginAllowed(plugins, target);
    });
  }
}

/**
 * Copy `mcp.json` with only allowlisted servers. Anything unreadable or
 * unmatched is omitted rather than inherited: an MCP server can spawn or
 * control other sessions, including this daemon's own endpoint.
 */
async function writeFilteredMcpJson(from: string, to: string, plugins: WorkerPluginAllowlist): Promise<void> {
  if (allowsAllPlugins(plugins)) { await copyFile(from, to); return; }
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readFile(from, "utf8")).replace(/^\uFEFF/, ""));
  } catch { return; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const record = parsed as Record<string, unknown>;
  const servers = record.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
  const kept = Object.fromEntries(
    Object.entries(servers as Record<string, unknown>).filter(([name]) => pluginAllowed(plugins, name)),
  );
  if (Object.keys(kept).length === 0) return;
  await writeFile(to, JSON.stringify({ ...record, mcpServers: kept }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

/**
 * Mirror the extensions directory with only allowlisted entries. Allowing the
 * directory name itself mirrors everything; entry patterns match both the bare
 * name and the `extensions/<name>` path.
 */
async function linkFilteredExtensions(from: string, to: string, plugins: WorkerPluginAllowlist): Promise<void> {
  if (allowsAllPlugins(plugins) || pluginAllowed(plugins, "extensions")) {
    await symlink(from, to, process.platform === "win32" ? "junction" : "dir");
    return;
  }
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (!pluginAllowed(plugins, entry.name) && !pluginAllowed(plugins, `extensions/${entry.name}`)) continue;
    const type = entry.isDirectory() && process.platform === "win32" ? "junction" : undefined;
    await symlink(join(from, entry.name), join(to, entry.name), type);
  }
}

function expand(value: string): string {
  if (value.startsWith("file://")) return fileURLToPath(value);
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

/** Rebase external resources while keeping paths inside the mirrored tree equivalent. */
function resourcePath(value: string, source: string, target: string, pattern = false): string {
  const marker = pattern && /^[!+-]/.test(value) ? value[0] : "";
  const path = value.slice(marker.length).trim();
  if (REMOTE_SOURCE.test(path)) return value;
  // Basename globs/overrides must continue matching any resource with that name.
  if (pattern && !path.includes("/") && !path.includes("\\") && (marker || /[*?]/.test(path))) return value;
  const absolute = resolve(source, expand(path));
  const rel = relative(source, absolute);
  const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  return marker + (inside ? resolve(target, rel) : absolute);
}

/**
 * Settings/auth/model files are private snapshots, so independent workers never
 * contend on the user's settings lock or overwrite their interactive defaults.
 * Resource directories remain linked to the same installed content. Global
 * plugins (packages, external extensions, MCP servers) are inherited only when
 * the configured allowlist matches, so an interactive-only extension cannot
 * change worker behavior or let a worker spawn nested sessions. Credentials,
 * skills, prompts, themes, and core builtins stay intact; no capability is
 * dropped to make startup cheaper.
 */
export async function prepareWorkerAgentDir(
  target: string,
  sourceInput = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  plugins: WorkerPluginAllowlist = [],
): Promise<string> {
  const source = resolve(expand(sourceInput));
  const destination = resolve(target);
  if (source === destination) throw new Error("worker agent directory must differ from the global agent directory");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700);
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return destination;
    throw new Error("cannot read the global pi agent directory");
  }
  for (const entry of entries) {
    // A lock is process state, never configuration. Sessions already have their own directory.
    if (entry.name.endsWith(".lock") || entry.name === "sessions") continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.name === "settings.json") {
      let settings: Record<string, unknown>;
      let release: (() => Promise<void>) | undefined;
      try {
        // Use pi's lock protocol while taking the snapshot. Retry asynchronously
        // instead of its short synchronous spin; never remove another process's lock.
        release = await lockfile.lock(from, { realpath: false, retries: { retries: 8, minTimeout: 50, maxTimeout: 250, randomize: true } });
        settings = JSON.parse((await readFile(from, "utf8")).replace(/^\uFEFF/, ""));
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new Error("cannot snapshot global pi settings: settings_lock_contention after bounded retries");
        throw new Error("cannot snapshot global pi settings: invalid or unreadable JSON");
      } finally { await release?.(); }
      applyWorkerPluginPolicy(settings, plugins);
      for (const field of RESOURCE_FIELDS) {
        if (Array.isArray(settings[field])) {
          settings[field] = (settings[field] as unknown[]).map(value => typeof value === "string" ? resourcePath(value, source, destination, true) : value);
        }
      }
      if (Array.isArray(settings.packages)) {
        settings.packages = settings.packages.map(value => {
          if (typeof value === "string") return resourcePath(value, source, destination);
          if (value && typeof value === "object" && typeof value.source === "string") {
            return { ...value, source: resourcePath(value.source, source, destination) };
          }
          return value;
        });
      }
      await writeFile(to, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    } else if (entry.name === "mcp.json") {
      await writeFilteredMcpJson(from, to, plugins);
    } else {
      if ((await stat(from)).isDirectory()) {
        if (entry.name === "extensions") {
          await linkFilteredExtensions(from, to, plugins);
        } else {
          await symlink(from, to, process.platform === "win32" ? "junction" : "dir");
        }
      } else {
        if (entry.name === "auth.json") {
          let release: (() => Promise<void>) | undefined;
          try {
            release = await lockfile.lock(from, { realpath: false, retries: { retries: 8, minTimeout: 50, maxTimeout: 250, randomize: true } });
            await copyFile(from, to);
          } catch { throw new Error("cannot snapshot pi credentials after bounded lock retries"); }
          finally { await release?.(); }
        } else await copyFile(from, to);
        await chmod(to, 0o600);
      }
    }
  }
  return destination;
}
