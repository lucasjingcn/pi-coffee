import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGitMounts, sandboxUserArgs } from "../dist/sandbox.js";

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function repoFixture(root) {
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "src/item.txt"), "base");
  git(repo, "add", "src");
  git(repo, "commit", "-qm", "base");
  return repo;
}

test("a linked worktree mounts the common git dir at the path git recorded", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gitmount-"));
  try {
    const repo = await repoFixture(root);
    const worktree = join(root, "candidate");
    git(repo, "worktree", "add", "-q", "-b", "pi/test", worktree);
    // The pointer git writes is absolute; mounting anything else (or nothing)
    // leaves every in-container git command at exit 128.
    const pointer = (await import("node:fs/promises")).readFile(join(worktree, ".git"), "utf8");
    assert.match(await pointer, /^gitdir: /);

    const common = await realpath(join(repo, ".git"));
    assert.deepEqual(resolveGitMounts(worktree, "/workspace"), [
      { host: common, container: common },
      // Hooks stay read-only: a hook written by a container would execute on the
      // host, because pi_commit/pi_merge do run repository hooks.
      { host: join(common, "hooks"), container: join(common, "hooks"), readOnly: true },
      // The config is what redirects those hooks (`core.hooksPath`) and defines
      // clean filters (`filter.*.clean` runs during `git add`), so it is read-only
      // too, layered after the writable metadata mount.
      { host: join(common, "config"), container: join(common, "config"), readOnly: true },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plain checkout needs no extra mount: .git is already inside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gitmount-plain-"));
  try {
    const repo = await repoFixture(root);
    assert.deepEqual(resolveGitMounts(repo, "/workspace"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a separate git dir outside the checkout is mounted at its recorded path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gitmount-separate-"));
  try {
    const gitDir = join(root, "meta");
    const worktree = join(root, "checkout");
    execFileSync("git", ["init", "-q", "--separate-git-dir", gitDir, worktree], { stdio: ["ignore", "pipe", "pipe"] });
    git(worktree, "config", "user.name", "test");
    git(worktree, "config", "user.email", "test@example.com");
    await writeFile(join(worktree, "file.txt"), "x");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-qm", "init");

    // `git init --separate-git-dir` records the realpath and writes no `commondir`,
    // so this checkout needs one metadata mount; the case where the recorded
    // spelling differs from the realpath is covered by the symlink fixtures below.
    const real = await realpath(gitDir);
    assert.deepEqual(resolveGitMounts(worktree, "/workspace"), [
      { host: real, container: real },
      { host: join(real, "hooks"), container: join(real, "hooks"), readOnly: true },
      { host: join(real, "config"), container: join(real, "config"), readOnly: true },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pointer spelled through a symlink keeps the recorded path inside the container", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gitmount-alias-"));
  try {
    // The mount source must be the real directory (docker needs a real path) while
    // the container target must stay the pointer's own spelling, because that is
    // what git resolves inside the container.
    const realGit = join(root, "real", "meta");
    await mkdir(join(realGit, "worktrees", "checkout"), { recursive: true });
    await symlink(join(root, "real"), join(root, "alias"));
    const worktree = join(root, "checkout");
    await mkdir(worktree, { recursive: true });
    const recorded = join(root, "alias", "meta", "worktrees", "checkout");
    await writeFile(join(worktree, ".git"), `gitdir: ${recorded}\n`);
    await writeFile(join(realGit, "worktrees", "checkout", "commondir"), "../..\n");
    await writeFile(join(realGit, "HEAD"), "ref: refs/heads/main\n");

    assert.deepEqual(resolveGitMounts(worktree, "/workspace"), [
      { host: await realpath(join(root, "alias", "meta")), container: join(root, "alias", "meta") },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked .git is followed instead of being silently skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gitmount-link-"));
  try {
    const realGit = join(root, "elsewhere", "git");
    await mkdir(join(realGit, "objects"), { recursive: true });
    await writeFile(join(realGit, "HEAD"), "ref: refs/heads/main\n");
    const worktree = join(root, "checkout");
    await mkdir(worktree, { recursive: true });
    // git accepts a symlinked `.git` (status/log work), so the sandbox must mount
    // whatever it points at instead of returning no mount and dying at 128.
    await symlink(realGit, join(worktree, ".git"));
    assert.deepEqual(resolveGitMounts(worktree, "/workspace"), [
      { host: await realpath(realGit), container: realGit },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked .git that stays inside the checkout adds no mount", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gitmount-link-in-"));
  try {
    const worktree = join(root, "checkout");
    await mkdir(join(worktree, "gitdir-store", "objects"), { recursive: true });
    await writeFile(join(worktree, "gitdir-store", "HEAD"), "ref: refs/heads/main\n");
    await symlink(join("gitdir-store"), join(worktree, ".git"));
    assert.deepEqual(resolveGitMounts(worktree, "/workspace"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a relative gitdir pointer resolves against the container workspace, not the host", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gitmount-relative-"));
  try {
    // Hand-built layout: git ≥2.48 can record relative pointers, older releases
    // only absolute ones, so the fixture writes the pointer itself.
    const worktree = join(root, "checkout");
    const gitDir = join(root, "meta", "worktrees", "checkout");
    await mkdir(worktree, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(worktree, ".git"), "gitdir: ../meta/worktrees/checkout\n");
    await writeFile(join(gitDir, "commondir"), "../..\n");

    const mounts = resolveGitMounts(worktree, "/workspace");
    const containers = mounts.map((mount) => mount.container);
    // git inside the container resolves `gitdir: ../meta/...` from /workspace, so
    // the metadata must be reachable at /meta — never at the host's tmp path.
    assert.deepEqual(containers, ["/meta"]);
    assert.deepEqual(mounts.map((mount) => mount.host), [await realpath(join(root, "meta"))]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a directory without git metadata adds no mount", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gitmount-none-"));
  try {
    assert.deepEqual(resolveGitMounts(root, "/workspace"), []);
    assert.deepEqual(resolveGitMounts(join(root, "missing"), "/workspace"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("containers run as the host user only where bind mounts keep real ownership", () => {
  const identity = { uid: 501, gid: 20 };
  // Linux: root writes become root-owned files on the host, so cleanup fails with
  // EACCES even though the command passed.
  assert.deepEqual(sandboxUserArgs("auto", "linux", identity), ["--user", "501:20"]);
  // Docker Desktop maps every write back to the host user; --user would instead
  // introduce a uid git reports as "dubious ownership".
  assert.deepEqual(sandboxUserArgs("auto", "darwin", identity), []);
  assert.deepEqual(sandboxUserArgs("auto", "win32", identity), []);
  // A root daemon writes root-owned files anyway, and uid 0 needs no override.
  assert.deepEqual(sandboxUserArgs("auto", "linux", { uid: 0, gid: 0 }), []);
  assert.deepEqual(sandboxUserArgs("auto", "linux", {}), []);
  // Explicit choices always win, on every platform.
  assert.deepEqual(sandboxUserArgs("root", "linux", identity), []);
  assert.deepEqual(sandboxUserArgs("1000:1000", "darwin", identity), ["--user", "1000:1000"]);
  // `--user uid:gid` alone drops supplementary groups, which would make a
  // group-writable checkout unwritable inside the container only.
  assert.deepEqual(sandboxUserArgs("auto", "linux", { uid: 501, gid: 20, groups: [20, 80, 100] }),
    ["--user", "501:20", "--group-add", "80", "--group-add", "100"]);
});
