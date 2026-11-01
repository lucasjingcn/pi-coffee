import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardCandidate } from "../dist/integration.js";

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-candidate-cleanup-"));
  const repo = join(root, "repo");
  const temp = join(root, "verify");
  const candidate = join(temp, "candidate");
  await mkdir(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "src/item.txt"), "base");
  git(repo, "add", "src");
  git(repo, "commit", "-qm", "base");
  await mkdir(temp, { recursive: true });
  git(repo, "worktree", "add", "--detach", candidate, "HEAD");
  try {
    await fn({ root, repo, temp, candidate });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a normal candidate is unregistered and deleted", () =>
  fixture(async ({ repo, temp, candidate }) => {
    await discardCandidate(repo, candidate, temp);
    assert.equal(existsSync(candidate), false);
    assert.equal(existsSync(temp), false);
    assert.equal(git(repo, "worktree", "list").split("\n").length, 1, "only the main checkout stays registered");
  }));

test("a candidate whose git metadata was pruned is still cleaned up without throwing", () =>
  fixture(async ({ repo, temp, candidate }) => {
    // A sandboxed acceptance command can drop the worktree metadata: the container
    // sees /workspace, but `<common>/worktrees/<name>/gitdir` still names the host
    // path, so one `git worktree prune` inside it deletes the registration.
    const name = candidate.split("/").pop();
    await rm(join(repo, ".git", "worktrees", name), { recursive: true, force: true });
    assert.throws(() => git(repo, "worktree", "remove", "--force", candidate), /is not a working tree/);

    // The cleanup must not turn a recorded verification result into a bare error,
    // and it must not leak the temporary directory either.
    await discardCandidate(repo, candidate, temp);
    assert.equal(existsSync(candidate), false);
    assert.equal(existsSync(temp), false);
    assert.equal(git(repo, "worktree", "list").split("\n").length, 1, "only the main checkout stays registered");
  }));
