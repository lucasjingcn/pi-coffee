import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { existingValidationChanges } from "../dist/validation-changes.js";

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), "pi-validation-changes-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  const write = async (path, content) => {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  const commit = (message = "commit") => {
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD").trim();
  };
  try {
    git("init", "-q");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    await run({ dir, git, write, commit });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("reports modified and deleted pre-existing validation files and excludes new ones", async () => {
  await fixture(async ({ dir, write, commit }) => {
    await write("tests/existing.test.mjs", "old\n");
    await write("test/legacy.py", "legacy\n");
    await write("src/app.ts", "export const app = 1;\n");
    const base = commit("base");

    await write("tests/existing.test.mjs", "old\nappended\n");
    await rm(join(dir, "test/legacy.py"));
    await write("tests/new.test.mjs", "brand new\n");
    await write("src/app.ts", "export const app = 2;\n");
    const worker = commit("worker");

    assert.deepEqual(await existingValidationChanges(dir, base, worker), [
      "test/legacy.py",
      "tests/existing.test.mjs",
    ]);
    assert.deepEqual(await existingValidationChanges(dir, base, worker, []), [
      "test/legacy.py",
      "tests/existing.test.mjs",
    ]);
  });
});

test("append-only edits to an existing test are still reported", async () => {
  await fixture(async ({ dir, write, commit }) => {
    await write("tests/append.test.mjs", "before\n");
    const base = commit("base");

    await write("tests/append.test.mjs", "before\nafter\n");
    const worker = commit("worker");

    assert.deepEqual(await existingValidationChanges(dir, base, worker), ["tests/append.test.mjs"]);
  });
});

test("renames are deletion plus addition, so only the pre-existing side is reported", async () => {
  await fixture(async ({ dir, write, commit }) => {
    await write("tests/helper.ts", "helper\n");
    await write("src/util_test.go", "util\n");
    await write("src/plain.ts", "plain\n");
    const base = commit("base");

    await rm(join(dir, "tests/helper.ts"));
    await write("lib/helper.ts", "helper\n");
    await rm(join(dir, "src/util_test.go"));
    await write("src/util_renamed_test.go", "util\n");
    await rm(join(dir, "src/plain.ts"));
    await write("tests/plain.ts", "plain\n");
    const worker = commit("worker");

    assert.deepEqual(await existingValidationChanges(dir, base, worker), [
      "src/util_test.go",
      "tests/helper.ts",
    ]);
  });
});

test("recognizes validation directory components case-insensitively", async () => {
  await fixture(async ({ dir, write, commit }) => {
    const matched = [
      "Test/a.txt",
      "TESTS/b.txt",
      "__Tests__/c.txt",
      "SPEC/d.txt",
      "Specs/e.txt",
      "__SNAPSHOTS__/f.txt",
      "src/tests/deep/g.txt",
    ];
    const ignored = ["contest/h.txt", "src/attest/i.txt"];
    for (const path of [...matched, ...ignored]) await write(path, "base\n");
    const base = commit("base");
    for (const path of [...matched, ...ignored]) await write(path, "base\nchanged\n");
    const worker = commit("worker");

    assert.deepEqual(await existingValidationChanges(dir, base, worker), [...matched].sort());
  });
});

test("recognizes conventional validation file names case-insensitively", async () => {
  await fixture(async ({ dir, write, commit }) => {
    const matched = [
      "src/TEST_Helpers.py",
      "src/Foo_Test.GO",
      "src/Foo.TEST.TS",
      "src/Foo.SPEC.JS",
      "src/CONFTEST.PY",
      "src/Pytest.INI",
      "src/Tox.ini",
      "src/Jest.Config.JS",
      "src/Vitest.Config.MTS",
      "src/Playwright.Config.TS",
      "src/Cypress.Config.mjs",
      "tools/jest.config.cjs",
      "src/util_test.py",
    ];
    const ignored = [
      "src/latest.ts",
      "src/contest.ts",
      "src/testimony.ts",
      "src/pytest.ini.bak",
      "src/attest.ts",
    ];
    for (const path of [...matched, ...ignored]) await write(path, "base\n");
    const base = commit("base");
    for (const path of [...matched, ...ignored]) await write(path, "base\nchanged\n");
    const worker = commit("worker");

    assert.deepEqual(await existingValidationChanges(dir, base, worker), [...matched].sort());
  });
});

test("custom validation paths match exactly and as ancestors after normalization", async () => {
  await fixture(async ({ dir, write, commit }) => {
    const paths = [
      "checks/a.txt",
      "checks/deep/c/d.txt",
      "checks/nested/b.txt",
      "checks-other/e.txt",
      "checksum/f.txt",
    ];
    for (const path of paths) await write(path, "base\n");
    const base = commit("base");
    for (const path of paths) await write(path, "base\nchanged\n");
    const worker = commit("worker");

    assert.deepEqual(await existingValidationChanges(dir, base, worker, ["./checks"]), [
      "checks/a.txt",
      "checks/deep/c/d.txt",
      "checks/nested/b.txt",
    ]);
    assert.deepEqual(await existingValidationChanges(dir, base, worker, ["checks/./nested"]), [
      "checks/nested/b.txt",
    ]);
    assert.deepEqual(await existingValidationChanges(dir, base, worker, ["checks/a.txt"]), [
      "checks/a.txt",
    ]);
    assert.deepEqual(await existingValidationChanges(dir, base, worker, ["checks-other"]), [
      "checks-other/e.txt",
    ]);
    assert.deepEqual(await existingValidationChanges(dir, base, worker, ["checks/", "checks\\nested"]), [
      "checks/a.txt", "checks/deep/c/d.txt", "checks/nested/b.txt",
    ]);
  });
});

test("custom validation paths reject traversal, absolute and Git metadata", async () => {
  await fixture(async ({ dir, write, commit }) => {
    await write("tracked.txt", "x\n");
    const head = commit("base");

    const rejected = [
      "",
      ".",
      "../outside",
      "checks/../../outside",
      "/tmp/outside",
      ".git",
      ".git/config",
      "nested/.git/config",
      "checks/\0x",
      "..\\outside",
    ];
    for (const path of rejected) {
      await assert.rejects(existingValidationChanges(dir, head, head, [path]), undefined, JSON.stringify(path));
    }
  });
});

test("paths with spaces, tabs, newlines and unicode survive unchanged", async () => {
  await fixture(async ({ dir, write, commit }) => {
    const names = [
      "tests/space name.test.mjs",
      "tests/tab\tname.test.mjs",
      "tests/line\nbreak.test.mjs",
      "tests/uni空.test.mjs",
      "tests/emoji-🚀.test.mjs",
    ];
    for (const name of names) await write(name, "base\n");
    const base = commit("base");
    for (const name of names) await write(name, "base\nchanged\n");
    const worker = commit("worker");

    assert.deepEqual(await existingValidationChanges(dir, base, worker), [...names].sort());
  });
});

test("invalid refs fail explicitly and identical refs produce no evidence", async () => {
  await fixture(async ({ dir, git, write, commit }) => {
    await write("tests/x.test.mjs", "x\n");
    const head = commit("base");
    const blob = git("hash-object", "-w", "tests/x.test.mjs").trim();

    await assert.rejects(existingValidationChanges(dir, "missing-base", head), /Not a valid commit ref/);
    await assert.rejects(existingValidationChanges(dir, head, "missing-worker"), /Not a valid commit ref/);
    await assert.rejects(existingValidationChanges(dir, head, blob), /Not a valid commit ref/);
    assert.deepEqual(await existingValidationChanges(dir, head, head), []);
  });
});
