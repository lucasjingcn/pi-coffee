/**
 * Per-session execution sandboxes.
 *
 * Phase A (this milestone) runs verification/validator commands in a fresh
 * Docker container that only mounts the candidate worktree. The daemon itself
 * keeps running on the host. Phase B will run the worker process the same way.
 *
 * The docker CLI is invoked through an injected shell runner so tests can use a
 * deterministic fake binary and so the daemon keeps a single process-control
 * path (timeouts kill the process group, then remove the container).
 */

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export type SandboxKind = "worktree" | "docker";

export interface SandboxRecord {
  kind: SandboxKind;
  image?: string;
  imageDigest?: string;
  network?: "bridge" | "none";
}

export interface SandboxConfig {
  kind: SandboxKind;
  image: string;
  network: "bridge" | "none";
  envAllow: string[];
  dockerBin: string;
}

export interface SandboxExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ShellRunner = (command: string, cwd: string, timeoutMs: number) => Promise<SandboxExecResult>;

export interface SandboxProbe {
  ok: boolean;
  version?: string;
  imageDigest?: string;
  error?: string;
}

/** POSIX single-quote escaping for values embedded in a shell command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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
   * `/workspace`. Fail closed when docker/image probing fails; never fall back
   * to host execution when the spec asked for a sandbox.
   */
  async run(
    hostCwd: string,
    command: string,
    timeoutMs: number,
    extraEnv?: Record<string, string>,
  ): Promise<SandboxExecResult> {
    const probe = await this.probe();
    if (!probe.ok) throw new Error(`sandbox requested but docker is unavailable: ${probe.error ?? "unknown error"}`);
    const name = `pi-coffee-verify-${randomBytes(6).toString("hex")}`;
    const envArgs: string[] = [];
    const seen = new Set<string>();
    const forward = (key: string, value: string | undefined) => {
      if (!value || seen.has(key)) return;
      seen.add(key);
      envArgs.push("-e", `${key}=${value}`);
    };
    for (const key of this.config.envAllow) forward(key, process.env[key]);
    for (const [key, value] of Object.entries(extraEnv ?? {})) forward(key, value);
    const argv = [
      shellQuote(this.config.dockerBin), "run", "--rm", "--name", shellQuote(name),
      "--network", shellQuote(this.config.network),
      "-v", shellQuote(`${resolve(hostCwd)}:/workspace`),
      "-w", "/workspace",
      ...envArgs.map((part, index) => (index % 2 === 0 ? part : shellQuote(part))),
      shellQuote(this.config.image),
      "bash", "-lc", shellQuote(command),
    ];
    const result = await this.runner(argv.join(" "), process.cwd(), timeoutMs);
    if (result.timedOut) {
      await this.runner(`${shellQuote(this.config.dockerBin)} rm -f ${shellQuote(name)}`, process.cwd(), 15_000)
        .catch(() => undefined);
    }
    return result;
  }
}
