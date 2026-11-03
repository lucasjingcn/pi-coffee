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
  /**
   * Spawn/execution failure text when `code` is null (ENOENT, timeout, signal).
   * Without it, "gh is not installed" and "gh timed out after the merge was
   * accepted" both rendered as `exit null`, which an operator cannot act on.
   */
  error?: string;
}

export type GhRunner = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<GhRunResult>;

export function createGhRunner(bin: string): GhRunner {
  return (args, { cwd, env }) =>
    new Promise((resolve) => {
      execFile(bin, args, { cwd, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? (error as unknown as { code: number }).code : null) : 0;
        const failure = error instanceof Error ? error.message : undefined;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", ...(failure ? { error: failure.slice(0, 300) } : {}) });
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
      const detail = (result.stderr || result.stdout || result.error || "").trim().slice(0, 500)
        || `exit ${String(result.code)}`;
      // A null code means the process never produced an exit status (spawn
      // failure or timeout): the effect may or may not have been applied.
      const hint = result.code === null && !result.stderr.trim()
        ? " (the command did not report a status; its effect may already be applied — verify before retrying)"
        : "";
      throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${detail}${hint}`);
    }
    return result;
  }

  async findPr(repo: string, head: string): Promise<PullRequest | undefined> {
    const result = await this.run(repo, ["pr", "list", "--head", head, "--state", "open", "--json", "number,url,state", "--limit", "1"]);
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout || "[]"); } catch { throw new Error("gh pr list returned invalid JSON"); }
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const first = parsed[0] as Partial<PullRequest>;
    if (typeof first.number !== "number" || typeof first.url !== "string") throw new Error("gh pr list returned an invalid PR record");
    return { number: first.number, url: first.url, ...(typeof first.state === "string" ? { state: first.state } : {}) };
  }

  async createPr(repo: string, input: CreatePrInput): Promise<PullRequest> {
    const baseArgs = ["pr", "create", "--base", input.base, "--head", input.head, "--title", input.title, "--body", input.body];
    const parse = (result: GhRunResult): PullRequest => {
      const match = /(https?:\/\/\S+?\/pull\/(\d+))/.exec(result.stdout);
      if (!match) throw new Error("gh pr create did not print a pull request URL");
      return { number: Number(match[2]), url: match[1] };
    };
    if (!input.label) return parse(await this.run(repo, baseArgs));
    let labelledError: unknown;
    try {
      return parse(await this.run(repo, [...baseArgs, "--label", input.label]));
    } catch (error) {
      labelledError = error;
    }
    // A missing label is cosmetic, but the failure can arrive after the pull
    // request exists (a label is applied once the PR is created), so adopting
    // the existing PR beats retrying into "already exists" and reporting a
    // failure for work that actually happened.
    const existing = await this.findPr(repo, input.head).catch(() => undefined);
    if (existing) {
      await this.addLabel(repo, existing.number, input.label);
      return existing;
    }
    try {
      return parse(await this.run(repo, baseArgs));
    } catch (error) {
      const first = labelledError instanceof Error ? labelledError.message : String(labelledError);
      const second = error instanceof Error ? error.message : String(error);
      throw new Error(`${first}; retrying without --label failed too: ${second}`);
    }
  }

  /** Read the PR head/state/merge commit so merge-queue cannot queue an older commit. */
  async viewPr(repo: string, number: number): Promise<PullRequest & { headRefOid?: string; mergeCommit?: string }> {
    const result = await this.run(repo, ["pr", "view", String(number), "--json", "number,url,state,headRefOid,mergeCommit"]);
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error("gh pr view returned invalid JSON"); }
    const record = parsed as Partial<PullRequest> & { headRefOid?: unknown; mergeCommit?: unknown };
    if (typeof record.number !== "number" || typeof record.url !== "string") throw new Error("gh pr view returned an invalid PR record");
    const mergeCommit = typeof record.mergeCommit === "object" && record.mergeCommit !== null
      ? (record.mergeCommit as { oid?: unknown }).oid
      : record.mergeCommit;
    return {
      number: record.number,
      url: record.url,
      ...(typeof record.state === "string" ? { state: record.state } : {}),
      ...(typeof record.headRefOid === "string" ? { headRefOid: record.headRefOid } : {}),
      ...(typeof mergeCommit === "string" && mergeCommit ? { mergeCommit } : {}),
    };
  }

  /** Best-effort label add after creation (a missing label never invalidates the PR). */
  async addLabel(repo: string, number: number, label: string): Promise<void> {
    await this.run(repo, ["pr", "edit", String(number), "--add-label", label]).catch(() => undefined);
  }

  /** Queue a PR for the repository's merge queue with the configured method. */
  async queueMerge(repo: string, number: number, method: "squash" | "merge" | "rebase" = "squash"): Promise<GhRunResult> {
    return this.run(repo, ["pr", "merge", String(number), `--${method}`, "--auto"]);
  }
}
