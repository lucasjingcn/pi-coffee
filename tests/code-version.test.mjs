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
    assert.equal(typeof recorded.distMtimeMs, "number", "a present dist records a numeric mtime");
    assert.equal(typeof recorded.distSha256, "string", "and a content hash");
    const status = checkCodeVersion(root, recorded);
    assert.equal(status.stale, false);
    assert.equal(status.runningDistMtimeMs, recorded.distMtimeMs);
    assert.equal(status.diskDistMtimeMs, recorded.distMtimeMs);
    assert.equal(status.hint, undefined, "no restart hint while the daemon matches disk");
  });
});

test("a rebuilt dist/manager.js marks the running daemon stale and asks for a restart", async () => {
  await withDist(async (root, managerPath) => {
    const recorded = recordCodeVersion(root);
    // A real rebuild writes new bytes; mtime alone is not trusted.
    await writeFile(managerPath, "export const rebuilt = true;\n");
    await utimes(managerPath, REBUILT_MTIME_SECONDS, REBUILT_MTIME_SECONDS);
    const status = checkCodeVersion(root, recorded);
    assert.equal(status.stale, true);
    assert.equal(status.runningDistMtimeMs, recorded.distMtimeMs, "the startup value is preserved for comparison");
    assert.notEqual(status.diskDistMtimeMs, recorded.distMtimeMs);
    assert.equal(status.hint, CODE_STALE_HINT);
    assert.equal(status.hint, "restart daemon to load current code");
  });
});

test("a missing dist on either side is reported instead of guessed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-code-version-missing-"));
  try {
    assert.equal(recordCodeVersion(root).distMtimeMs, null, "no dist yet");
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

test("content changes with an unchanged mtime still mark the daemon stale", async () => {
  await withDist(async (root, managerPath) => {
    const recorded = recordCodeVersion(root);
    // Same mtime, different bytes (cp -p / rsync -t / image layer restore).
    await writeFile(managerPath, "export const v = 2;\n");
    await utimes(managerPath, FIRST_MTIME_SECONDS, FIRST_MTIME_SECONDS);
    const status = checkCodeVersion(root, recorded);
    assert.equal(status.stale, true, "content decides when both hashes are known");
    assert.equal(status.runningDistMtimeMs, recorded.distMtimeMs);
  });
});

test("a legacy numeric mtime record keeps working", async () => {
  await withDist(async (root) => {
    const recorded = recordCodeVersion(root);
    assert.equal(checkCodeVersion(root, recorded.distMtimeMs).stale, false);
  });
});
