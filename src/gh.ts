/**
 * Thin GitHub CLI wrapper for PR creation and merge-queue integration.
 *
 * The runner is injected so tests can use a fake `gh` and so the daemon keeps one
 * process-control/error path. Tokens are only ever passed through the child
 * environment, never through argv.
 */

import { execFile } from "node:child_process";

export interface GhRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type GhRunner = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<GhRunResult>;

export function createGhRunner(bin: string): GhRunner {
  return (args, { cwd, env }) =>
    new Promise((resolve) => {
      execFile(bin, args, { cwd, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? (error as unknown as { code: number }).code : null) : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      });
    });
}

export interface PullRequest {
  number: number;
  url: string;
  state?: string;
}

export interface CreatePrInput {
  base: string;
  head: string;
  title: string;
  body: string;
  label?: string;
}

export class GhClient {
  private readonly runner: GhRunner;
  private readonly env: () => NodeJS.ProcessEnv;

  constructor(runner: GhRunner, env: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv) = process.env) {
    this.runner = runner;
    this.env = typeof env === "function" ? env : () => env;
  }

  private async run(repo: string, args: string[]): Promise<GhRunResult> {
    const result = await this.runner(args, { cwd: repo, env: this.env() });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || "").trim().slice(0, 500) || `exit ${String(result.code)}`;
      throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${detail}`);
    }
    return result;
  }

  async findPr(repo: string, head: string): Promise<PullRequest | undefined> {
    const result = await this.run(repo, ["pr", "list", "--head", head, "--state", "all", "--json", "number,url,state", "--limit", "1"]);
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout || "[]"); } catch { throw new Error("gh pr list returned invalid JSON"); }
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const first = parsed[0] as Partial<PullRequest>;
    if (typeof first.number !== "number" || typeof first.url !== "string") throw new Error("gh pr list returned an invalid PR record");
    return { number: first.number, url: first.url, ...(typeof first.state === "string" ? { state: first.state } : {}) };
  }

  async createPr(repo: string, input: CreatePrInput): Promise<PullRequest> {
    const args = ["pr", "create", "--base", input.base, "--head", input.head, "--title", input.title, "--body", input.body];
    if (input.label) args.push("--label", input.label);
    args.push("--json", "number,url");
    const result = await this.run(repo, args);
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error("gh pr create returned invalid JSON"); }
    const record = parsed as Partial<PullRequest>;
    if (typeof record.number !== "number" || typeof record.url !== "string") throw new Error("gh pr create returned an invalid PR record");
    return { number: record.number, url: record.url };
  }

  async queueMerge(repo: string, number: number, method: "squash" | "merge" = "squash"): Promise<GhRunResult> {
    return this.run(repo, ["pr", "merge", String(number), `--${method}`, "--auto"]);
  }
}
