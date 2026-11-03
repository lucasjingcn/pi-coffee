import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const script = join(repoRoot, "scripts", "bootstrap.sh");
const skipOnWindows = process.platform === "win32" ? "POSIX shell fixtures" : false;

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pi-bootstrap "));
  const home = join(dir, "home");
  const app = join(dir, "app");
  mkdirSync(home, { recursive: true });
  // A fake release: only an install.sh is needed to prove the fetch/unpack/forward contract.
  const source = join(dir, "src", "pi-coffee-9.9.9");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "pi-coffee", version: "9.9.9" }));
  writeFileSync(join(source, "install.sh"), '#!/usr/bin/env bash\necho "installer ran with: $*"\n', { mode: 0o755 });
  const archive = join(dir, "pi-coffee-9.9.9.tgz");
  execFileSync("tar", ["-czf", archive, "-C", join(dir, "src"), "pi-coffee-9.9.9"]);
  const env = {
    ...process.env,
    HOME: home,
    PI_COFFEE_APP_DIR: app,
    PI_COFFEE_BOOTSTRAP_ARCHIVE: archive,
  };
  try {
    fn({ dir, home, app, archive, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(args, env) {
  return spawnSync("bash", [script, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("unpacks the archive into a stable directory and forwards installer options", { skip: skipOnWindows }, (t) => {
  fixture(({ app, env }) => {
    const result = run(["--provider", "deepseek", "--model", "deepseek-flash"], env);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /installer ran with: --provider deepseek --model deepseek-flash/);
    assert.ok(existsSync(join(app, "pi-coffee-9.9.9", "install.sh")), "the versioned copy must exist");
  });
});

test("--dry-run resolves the archive without writing anything", { skip: skipOnWindows }, (t) => {
  fixture(({ app, archive, env }) => {
    const result = run(["--dry-run"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry run: would install .*pi-coffee-9\.9\.9\.tgz/);
    assert.ok(result.stdout.includes(join(app, "pi-coffee-9.9.9")), result.stdout);
    assert.ok(!existsSync(app), "a dry run must not create the destination");
    assert.ok(existsSync(archive));
  });
});

test("--help documents the forwarded options", { skip: skipOnWindows }, (t) => {
  fixture(({ env }) => {
    const result = run(["--help"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--provider/);
    assert.match(result.stdout, /--skip-setup/);
  });
});

test("a missing archive fails with the path it tried", { skip: skipOnWindows }, (t) => {
  fixture(({ dir, env }) => {
    const missing = join(dir, "nope.tgz");
    const result = run([], { ...env, PI_COFFEE_BOOTSTRAP_ARCHIVE: missing });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nope\.tgz/);
  });
});

test("a second run reuses the versioned copy instead of unpacking again", { skip: skipOnWindows }, (t) => {
  fixture(({ app, env }) => {
    const first = run(["--provider", "deepseek"], env);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const second = run(["--provider", "deepseek"], env);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /reusing .*pi-coffee-9\.9\.9/);
  });
});

test("an unversioned snapshot is refreshed instead of being reused forever", { skip: skipOnWindows }, (t) => {
  fixture(({ dir, app, env }) => {
    // No package.json version -> the fallback "main" snapshot directory. Re-running
    // used to reuse it silently, so a curl|bash install never picked up new code.
    const source = join(dir, "src2", "pi-coffee-main");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "install.sh"), '#!/usr/bin/env bash\necho "old installer"\n', { mode: 0o755 });
    const archive = join(dir, "main-v1.tgz");
    execFileSync("tar", ["-czf", archive, "-C", join(dir, "src2"), "pi-coffee-main"]);

    const first = run([], { ...env, PI_COFFEE_BOOTSTRAP_ARCHIVE: archive });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /old installer/);

    writeFileSync(join(source, "install.sh"), '#!/usr/bin/env bash\necho "new installer"\n', { mode: 0o755 });
    const archive2 = join(dir, "main-v2.tgz");
    execFileSync("tar", ["-czf", archive2, "-C", join(dir, "src2"), "pi-coffee-main"]);
    const second = run([], { ...env, PI_COFFEE_BOOTSTRAP_ARCHIVE: archive2 });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /refreshing .*pi-coffee-main/);
    assert.match(second.stdout, /new installer/, "the re-run must run the new copy");
    assert.ok(existsSync(join(app, "pi-coffee-main", "install.sh")));
  });
});

test("a pinned checksum is verified before anything is unpacked", { skip: skipOnWindows }, (t) => {
  fixture(({ app, env }) => {
    const bad = run([], { ...env, PI_COFFEE_BOOTSTRAP_SHA256: "0".repeat(64) });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /checksum mismatch/);
    assert.ok(!existsSync(app), "nothing is written when the download does not verify");
  });
});
