import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_STALE_HINT, checkCodeVersion, recordCodeVersion } from "../dist/code-version.js";

const FIRST_MTIME_SECONDS = 1_700_000_000;
const REBUILT_MTIME_SECONDS = 1_700_000_500;

/** Temp package root with `<root>/dist/manager.js`; never touches the real repo dist. */
async function withDist(fn, mtimeSeconds = FIRST_MTIME_SECONDS) {
  const root = await mkdtemp(join(tmpdir(), "pi-code-version-"));
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    const managerPath = join(root, "dist", "manager.js");
    await writeFile(managerPath, "export {};\n");
    await utimes(managerPath, mtimeSeconds, mtimeSeconds);
    return await fn(root, managerPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("an unchanged dist/manager.js is not stale", async () => {
  await withDist(async (root) => {
    const recorded = recordCodeVersion(root);
    assert.equal(typeof recorded, "number", "a present dist records a numeric mtime");
    const status = checkCodeVersion(root, recorded);
    assert.equal(status.stale, false);
    assert.equal(status.runningDistMtimeMs, recorded);
    assert.equal(status.diskDistMtimeMs, recorded);
    assert.equal(status.hint, undefined, "no restart hint while the daemon matches disk");
  });
});

test("a rebuilt dist/manager.js marks the running daemon stale and asks for a restart", async () => {
  await withDist(async (root, managerPath) => {
    const recorded = recordCodeVersion(root);
    await utimes(managerPath, REBUILT_MTIME_SECONDS, REBUILT_MTIME_SECONDS);
    const status = checkCodeVersion(root, recorded);
    assert.equal(status.stale, true);
    assert.equal(status.runningDistMtimeMs, recorded, "the startup value is preserved for comparison");
    assert.notEqual(status.diskDistMtimeMs, recorded);
    assert.equal(status.hint, CODE_STALE_HINT);
    assert.equal(status.hint, "restart daemon to load current code");
  });
});

test("a missing dist on either side is reported instead of guessed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-code-version-missing-"));
  try {
    assert.equal(recordCodeVersion(root), null, "no dist yet");
    const absent = checkCodeVersion(root, null);
    assert.equal(absent.stale, false, "absent on both sides is consistent");
    assert.equal(absent.runningDistMtimeMs, null);
    assert.equal(absent.diskDistMtimeMs, null);
    assert.equal(absent.hint, undefined);

    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "manager.js"), "export {};\n");
    const appeared = checkCodeVersion(root, null);
    assert.equal(appeared.stale, true, "a dist that appeared after startup is not the running code");
    assert.equal(typeof appeared.diskDistMtimeMs, "number");

    const recorded = recordCodeVersion(root);
    assert.equal(checkCodeVersion(root, recorded).stale, false);
    await rm(join(root, "dist"), { recursive: true, force: true });
    assert.equal(checkCodeVersion(root, recorded).stale, true, "a deleted dist is a change too");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
