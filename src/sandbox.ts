/**
 * Per-session execution sandboxes.
 *
 * Phase A (this milestone) runs verification/validator commands in a fresh
 * Docker container that mounts the candidate worktree plus the git metadata the
 * candidate points at. The daemon itself keeps running on the host. Phase B runs
 * the worker process the same way.
 *
 * Two properties are load-bearing and easy to lose:
 *
 * - A git worktree's `.git` is a *file* holding an absolute path to its metadata
 *   (`<common dir>/worktrees/<name>`), so mounting the worktree alone makes every
 *   git command inside the container exit 128 (`not a git repository`). The
 *   mounts below reproduce the host layout at the same absolute paths, which
 *   keeps `git rev-parse`, `git diff`, hooks and `git -C subdir` behaving exactly
 *   as they do on the host instead of relying on GIT_DIR overrides.
 * - Containers otherwise run as the image's default user (usually root). On a
 *   Linux host that writes root-owned files into the bind mount, so the daemon's
 *   own cleanup (`git worktree remove`, `rm -rf` of a candidate) fails with
 *   EACCES. POSIX hosts therefore run as the invoking uid/gid by default; see
 *   `sandboxUserArgs`.
 *
 * The docker CLI is invoked through an injected shell runner so tests can use a
 * deterministic fake binary and so the daemon keeps a single process-control
 * path (timeouts kill the process group, then remove the container).
 */

import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

type SandboxKind = "worktree" | "docker";

export interface SandboxRecord {
  kind: SandboxKind;
  image?: string;
  imageDigest?: string;
  network?: "bridge" | "none";
}

interface SandboxConfig {
  kind: SandboxKind;
  image: string;
  network: "bridge" | "none";
  envAllow: string[];
  dockerBin: string;
  /** `auto` (host user on Linux), `root`, or an explicit `uid:gid`. */
  user: string;
}

interface SandboxExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type ShellRunner = (command: string, cwd: string, timeoutMs: number) => Promise<SandboxExecResult>;

interface SandboxProbe {
  ok: boolean;
  version?: string;
  imageDigest?: string;
  error?: string;
}

/** POSIX single-quote escaping for values embedded in a shell command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface GitMount {
  /** Absolute host directory to bind-mount. */
  host: string;
  /** Absolute path the container must see it at: the one git itself recorded. */
  container: string;
  /**
   * Mounted `:ro`. Used for the repository's hook directory and its config file:
   * a container needs to read git's metadata, but writing either lets it run code
   * on the host (`core.hooksPath`, `filter.*.clean` + `.gitattributes`) because
   * `pi_commit`, `pi_merge` and friends execute git on the host.
   */
  readOnly?: boolean;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function firstLine(path: string): string | undefined {
  try {
    const line = readFileSync(path, "utf8").split("\n")[0]?.trim();
    return line ? line : undefined;
  } catch {
    return undefined;
  }
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Git metadata a container needs so `git` works on a bind-mounted checkout.
 *
 * A directory that is itself a git worktree keeps `.git` as a *file* holding an
 * absolute path to `<common dir>/worktrees/<name>`; mounting only the worktree
 * leaves every git command dead (`fatal: not a git repository`, exit 128), which
 * silently kills any acceptance command that shells out to git. Mounting alone is
 * not enough: the paths must match what git recorded inside `.git` and
 * `commondir`, so the host directory is bind-mounted at its own recorded absolute
 * path rather than at a tidy container-local name.
 *
 * A plain checkout (`.git` is a directory inside the mounted tree) needs nothing
 * extra and returns no mounts.
 *
 * `allowedRepoRoot` is the repository the caller knows it is sandboxing. The
 * `.git` pointer and `commondir` are read from the mounted tree, which a
 * sandboxed process can rewrite, so without this check a worker could point the
 * next container at an arbitrary host path (for example the daemon user's HOME).
 * When it is set, metadata outside that root yields no mounts (git then fails
 * loudly inside the container instead of exposing the host).
 */
export function resolveGitMounts(
  hostCwd: string,
  containerCwd: string,
  opts: { allowedRepoRoot?: string } = {},
): GitMount[] {
  const dotGit = join(hostCwd, ".git");
  let linkTarget: string | undefined;
  let stat: Stats;
  try {
    const entry = lstatSync(dotGit);
    if (entry.isSymbolicLink()) {
      // git follows a symlinked `.git`; mount where the link points, mirroring the
      // link's own spelling so the container resolves it the way the host does.
      linkTarget = readlinkSync(dotGit);
      stat = statSync(dotGit);
    } else {
      stat = entry;
    }
  } catch {
    return [];
  }
  let gitDirHost: string | undefined;
  let gitDirContainer: string;
  const pointer = linkTarget ?? (stat.isFile()
    ? /^gitdir:\s*(.+)$/i.exec(firstLine(dotGit) ?? "")?.[1]?.trim()
    : undefined);
  if (pointer !== undefined) {
    // Absolute pointers are mirrored verbatim; a relative pointer resolves
    // against the container's own working directory, exactly as git will.
    gitDirHost = realpathOrUndefined(isAbsolute(pointer) ? pointer : resolve(hostCwd, pointer));
    gitDirContainer = isAbsolute(pointer) ? pointer : resolve(containerCwd, pointer);
  } else if (stat.isDirectory()) {
    gitDirHost = realpathOrUndefined(dotGit);
    gitDirContainer = join(containerCwd, ".git");
  } else {
    return [];
  }
  if (!gitDirHost) return [];

  // Linked worktrees keep objects and refs in the shared common dir two levels up.
  const commonPointer = firstLine(join(gitDirHost, "commondir"));
  const commonHost = realpathOrUndefined(
    commonPointer ? (isAbsolute(commonPointer) ? commonPointer : resolve(gitDirHost, commonPointer)) : gitDirHost,
  );
  if (!commonHost) return [];
  const commonContainer = commonPointer
    ? (isAbsolute(commonPointer) ? commonPointer : resolve(gitDirContainer, commonPointer))
    : gitDirContainer;
  // Never mount git metadata that a sandboxed process redirected outside the
  // repository the caller believes it is sandboxing.
  if (opts.allowedRepoRoot !== undefined) {
    const allowed = realpathOrUndefined(opts.allowedRepoRoot);
    if (!allowed || !isInside(allowed, gitDirHost) || !isInside(allowed, commonHost)) return [];
  }

  const wanted: GitMount[] = commonHost === gitDirHost
    ? [{ host: commonHost, container: commonContainer }]
    : (isInside(commonContainer, gitDirContainer) && isInside(commonHost, gitDirHost)
        // The common dir already contains this worktree's metadata (HEAD, index,
        // logs); one mount covers both and avoids a nested duplicate.
        ? [{ host: commonHost, container: commonContainer }]
        : [{ host: commonHost, container: commonContainer }, { host: gitDirHost, container: gitDirContainer }]);

  const seen = new Set<string>();
  const mounts = wanted.filter((mount) => {
    // Nothing to add when the mount target already lives inside the workspace mount.
    if (mount.container !== containerCwd && isInside(containerCwd, mount.container)) return false;
    if (seen.has(mount.container)) return false;
    seen.add(mount.container);
    return true;
  });
  // Hooks stay read-only inside the metadata mount, and last so it nests over it.
  const commonMount = mounts.find((mount) => mount.host === commonHost);
  const hooksHost = join(commonHost, "hooks");
  if (commonMount && isDirectory(hooksHost)) {
    mounts.push({ host: hooksHost, container: join(commonMount.container, "hooks"), readOnly: true });
  }
  // The repository config is the other way to make host git run container code
  // (`core.hooksPath` points anywhere; `filter.<name>.clean` runs during
  // `git add`). Mount it back read-only over the writable metadata mount, after
  // the hooks entry so both nest correctly. Git only reads it for a commit, so
  // `git add`/`git commit` inside the container keep working.
  if (commonMount) {
    for (const name of ["config", "config.worktree"]) {
      const host = join(commonHost, name);
      try {
        if (!statSync(host).isFile()) continue;
      } catch {
        continue;
      }
      mounts.push({ host, container: join(commonMount.container, name), readOnly: true });
    }
  }
  return mounts;
}

/**
 * `docker run --user` arguments for sandbox containers.
 *
 * On a POSIX host the container's default user is usually root, and root writes
 * into a bind mount land as root-owned files on the host: cleanup then fails with
 * EACCES (`git worktree remove`, `rm -rf` of a candidate) even though the command
 * itself succeeded. Linux keeps real uids in bind mounts, so there the container
 * runs as the invoking user. Docker Desktop (macOS/Windows) maps every write back
 * to the host user, where running as the image's default user is already correct
 * and an explicit `--user` would only add a uid that git rejects as a foreign
 * owner (`detected dubious ownership`).
 */
export function sandboxUserArgs(
  spec: string,
  platform: NodeJS.Platform = process.platform,
  identity: { uid?: number; gid?: number; groups?: number[] } = {
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    gid: typeof process.getgid === "function" ? process.getgid() : undefined,
    groups: typeof process.getgroups === "function" ? process.getgroups() : undefined,
  },
): string[] {
  if (spec === "root") return [];
  if (spec !== "auto") return ["--user", spec];
  if (platform !== "linux") return [];
  const { uid, gid } = identity;
  if (uid === undefined || gid === undefined || uid === 0) return [];
  // `--user uid:gid` drops the host's supplementary groups, which would turn a
  // group-writable checkout into an in-container EACCES the host user never has.
  return ["--user", `${uid}:${gid}`,
    ...(identity.groups ?? []).filter((group) => group !== gid).flatMap((group) => ["--group-add", String(group)])];
}

/** HOME an overridden container user can actually write (`/root` belongs to root). */
const SANDBOX_HOME = "/tmp";

export class DockerSandbox {
  readonly config: SandboxConfig;
  private readonly runner: ShellRunner;
  private probeResult?: SandboxProbe;

  constructor(config: SandboxConfig, runner: ShellRunner) {
    this.config = config;
    this.runner = runner;
  }

  /** Docker + image availability, cached per daemon process. */
  async probe(): Promise<SandboxProbe> {
    if (this.probeResult?.ok) return this.probeResult;
    const bin = shellQuote(this.config.dockerBin);
    const version = await this.runner(`${bin} version --format '{{.Server.Version}}'`, process.cwd(), 15_000);
    if (version.timedOut || version.code !== 0) {
      this.probeResult = {
        ok: false,
        error: `docker is not available (${(version.stderr || version.stdout || "no response").trim().slice(0, 300) || "exit " + String(version.code)})`,
      };
      return this.probeResult;
    }
    const inspect = await this.runner(
      `${bin} image inspect --format '{{.Id}}' ${shellQuote(this.config.image)}`,
      process.cwd(),
      15_000,
    );
    if (inspect.timedOut || inspect.code !== 0) {
      this.probeResult = {
        ok: false,
        error: `sandbox image ${this.config.image} is not available (${(inspect.stderr || inspect.stdout || "").trim().slice(0, 300) || "exit " + String(inspect.code)})`,
      };
      return this.probeResult;
    }
    this.probeResult = {
      ok: true,
      version: version.stdout.trim(),
      imageDigest: inspect.stdout.trim(),
    };
    return this.probeResult;
  }

  /** Record stored in session metadata and the evidence manifest. */
  record(): SandboxRecord {
    return {
      kind: "docker",
      image: this.config.image,
      ...(this.probeResult?.imageDigest ? { imageDigest: this.probeResult.imageDigest } : {}),
      network: this.config.network,
    };
  }

  /**
   * Run one command in a fresh container with the candidate mounted at
   * `/workspace` plus the git metadata the candidate points at, so git commands
   * behave exactly as they do on the host. Fail closed when docker/image probing
   * fails; never fall back to host execution when the spec asked for a sandbox.
   */
  async run(
    hostCwd: string,
    command: string,
    timeoutMs: number,
    extraEnv?: Record<string, string>,
    /** Repository this checkout belongs to; bounds the git metadata mounts. */
    allowedRepoRoot?: string,
  ): Promise<SandboxExecResult> {
    const probe = await this.probe();
    if (!probe.ok) throw new Error(`sandbox requested but docker is unavailable: ${probe.error ?? "unknown error"}`);
    const name = `pi-coffee-verify-${randomBytes(6).toString("hex")}`;
    const userArgs = sandboxUserArgs(this.config.user ?? "auto");
    const environment = new Map<string, string | undefined>();
    // Lowest precedence: the sandbox's own defaults. An overridden user cannot
    // write to the image's `/root`, so it gets a HOME that exists and is writable;
    // an allowlisted or validator-provided HOME still overrides it.
    if (userArgs.length > 0) environment.set("HOME", SANDBOX_HOME);
    // Allowlisted host names are forwarded by reference (`-e NAME`) so their
    // values never appear in argv. Listing a name the sandbox defaults already set
    // is an explicit opt-in, so it replaces that default.
    for (const key of this.config.envAllow) environment.set(key, undefined);
    // Validator-provided values win, exactly like the worktree backend
    // (`{...process.env, ...extraEnv}`): an explicit `env.NODE_ENV=test` must not
    // be silently replaced by the daemon's value — and a later `-e NAME` would not
    // even reach the container, because docker resolves it from the CLI
    // environment, so the explicit value alone must be emitted.
    for (const [key, value] of Object.entries(extraEnv ?? {})) environment.set(key, value);
    const envArgs: string[] = [];
    for (const [key, value] of environment) envArgs.push("-e", value === undefined ? key : `${key}=${value}`);

    const argv = [
      shellQuote(this.config.dockerBin), "run", "--rm", "--name", shellQuote(name),
      "--network", shellQuote(this.config.network),
      ...userArgs.map((part, index) => (index % 2 === 0 ? part : shellQuote(part))),
      "-v", shellQuote(`${resolve(hostCwd)}:${WORKER_WORKSPACE}`),
      ...resolveGitMounts(hostCwd, WORKER_WORKSPACE, allowedRepoRoot !== undefined ? { allowedRepoRoot } : {})
        .flatMap((mount) => ["-v", shellQuote(`${mount.host}:${mount.container}${mount.readOnly ? ":ro" : ""}`)]),
      "-w", WORKER_WORKSPACE,
      ...envArgs.map((part, index) => (index % 2 === 0 ? part : shellQuote(part))),
      shellQuote(this.config.image),
      "bash", "-lc", shellQuote(command),
    ];
    const result = await this.runner(argv.join(" "), process.cwd(), timeoutMs);
    if (result.timedOut) {
      // `docker run` keeps running after its CLI is killed; only `rm -f` stops
      // it. A timeout whose container cannot be removed is not a clean failure:
      // it can keep writing the candidate and `<repo>/.git`, so surface it.
      const removal = await this.runner(`${shellQuote(this.config.dockerBin)} rm -f ${shellQuote(name)}`,
        process.cwd(), 15_000).catch((error: unknown) => ({ code: null, stdout: "", stderr: String(error), timedOut: false }));
      if (removal.timedOut || removal.code !== 0) {
        throw new Error(`sandbox command timed out and its container could not be removed: ${(removal.stderr || removal.stdout).trim().slice(0, 200)}`);
      }
    }
    return result;
  }

  /**
   * Remove the per-worker container. A container that is already gone is fine;
   * anything else is reported, because `docker run` keeps running after its CLI
   * is killed — only `rm -f` stops it, and the caller must not release locks for
   * a container that may still be writing to the worktree.
   */
  async removeWorker(sessionId: string): Promise<void> {
    const name = workerContainerName(sessionId);
    const result = await this.runner(`${shellQuote(this.config.dockerBin)} rm -f ${shellQuote(name)}`, process.cwd(), 15_000)
      .catch((error: unknown) => ({ code: null, stdout: "", stderr: String(error), timedOut: false }));
    if (result.timedOut || result.code !== 0) {
      if (/no such container/i.test(`${result.stdout}${result.stderr}`)) return;
      const detail = (result.stderr || result.stdout || "").trim().slice(0, 200) || "no output";
      throw new Error(`docker rm -f ${name} failed (code ${String(result.code)}): ${detail}`);
    }
  }
}


export const WORKER_WORKSPACE = "/workspace";
export const WORKER_SESSION_DIR = "/session";
export const WORKER_EXTENSION = "/opt/pi-coffee-extension.ts";

/** Deterministic container name for one worker session. */
export function workerContainerName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40) || "session";
  return `pi-coffee-worker-${safe}`;
}

interface WorkerContainerOptions {
  sessionId: string;
  worktree: string;
  sessionDir: string;
  extensionPath: string;
  image: string;
  network: "bridge" | "none";
  envAllow: string[];
  port: number;
  dockerBin: string;
  /** Host name the container uses to reach this daemon (`host.docker.internal` by default). */
  coordHost: string;
  /** `auto` (host user on Linux), `root`, or an explicit `uid:gid`. */
  user?: string;
  /** Repository the worktree belongs to; bounds the git metadata mounts. */
  repo?: string;
}

/**
 * Prefix that runs the pi CLI inside a per-worker container:
 * worktree -> /workspace, session dir -> /session, worker extension mounted read-only,
 * plus the git metadata the worktree points at so `git` works inside the container.
 * Only PI_COORD_* values and allowlisted host names are forwarded; `-e NAME` reads
 * the value from the docker CLI environment, so secrets never appear in argv.
 */
export function buildWorkerDockerPrefix(opts: WorkerContainerOptions): { bin: string; args: string[] } {
  const userArgs = sandboxUserArgs(opts.user ?? "auto");
  const gitMounts = resolveGitMounts(opts.worktree, WORKER_WORKSPACE,
    opts.repo !== undefined ? { allowedRepoRoot: opts.repo } : {});
  return {
    bin: opts.dockerBin,
    args: [
      "run", "--rm", "-i", "--name", workerContainerName(opts.sessionId),
      "--network", opts.network,
      // Only meaningful for the gateway alias; harmless for any other coord host.
      "--add-host", "host.docker.internal:host-gateway",
      ...userArgs,
      "-v", `${resolve(opts.worktree)}:${WORKER_WORKSPACE}`,
      ...gitMounts.flatMap((mount) => ["-v", `${mount.host}:${mount.container}${mount.readOnly ? ":ro" : ""}`]),
      "-w", WORKER_WORKSPACE,
      "-v", `${resolve(opts.sessionDir)}:${WORKER_SESSION_DIR}`,
      "-v", `${resolve(opts.extensionPath)}:${WORKER_EXTENSION}:ro`,
      // An overridden user cannot write the image's `/root`, and pi keeps caches
      // under HOME in addition to its agent dir. An explicitly allowlisted HOME
      // wins: it is forwarded by name after this default.
      ...(userArgs.length > 0 && !opts.envAllow.includes("HOME") ? ["-e", `HOME=${SANDBOX_HOME}`] : []),
      "-e", "PI_CODING_AGENT_DIR=/session/agent",
      "-e", `PI_COORD_URL=http://${opts.coordHost}:${opts.port}`,
      "-e", `PI_COORD_SESSION_ID=${opts.sessionId}`,
      "-e", "PI_COORD_TOKEN",
      ...opts.envAllow.flatMap((key) => ["-e", key]),
      opts.image,
      "pi",
    ],
  };
}
