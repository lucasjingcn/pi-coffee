import test from "node:test";
import assert from "node:assert/strict";
import { openSync, closeSync, mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_LOG_NAMES,
  DEFAULT_KEEP,
  DEFAULT_MAX_BYTES,
  defaultLogDir,
  fdOwnsPath,
  rotateLog,
  rotateOwnedLogs,
  rotationOptionsFromEnv,
} from "../scripts/lib/logs.mjs";

function tempDir(prefix = "pi-coffee-logs-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("fdOwnsPath matches the file a descriptor was opened on, and nothing else", () => {
  const dir = tempDir();
  try {
    const owned = join(dir, "owned.log");
    const other = join(dir, "other.log");
    writeFileSync(owned, "a");
    writeFileSync(other, "b");
    const fd = openSync(owned, "a");
    try {
      assert.equal(fdOwnsPath(fd, owned), true);
      assert.equal(fdOwnsPath(fd, other), false);
      assert.equal(fdOwnsPath(fd, join(dir, "missing.log")), false);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateLog archives and truncates only when the file exceeds the limit", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "daemon.err.log");
    writeFileSync(path, "small\n");
    assert.deepEqual(rotateLog(path, { maxBytes: 1024 }), { path, rotated: false, reason: "under-limit", size: 6 });
    assert.equal(readFileSync(path, "utf8"), "small\n");

    writeFileSync(path, "x".repeat(2048));
    const rotated = rotateLog(path, { maxBytes: 1024 });
    assert.equal(rotated.rotated, true);
    assert.equal(rotated.size, 2048);
    assert.equal(readFileSync(path, "utf8"), "");
    assert.equal(readFileSync(`${path}.1`, "utf8"), "x".repeat(2048));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateLog reports missing files and disabled rotation without creating anything", () => {
  const dir = tempDir();
  try {
    const missing = join(dir, "daemon.err.log");
    assert.equal(rotateLog(missing).reason, "missing");
    const path = join(dir, "big.log");
    writeFileSync(path, "x".repeat(2048));
    const result = rotateLog(path, { maxBytes: 0 });
    assert.equal(result.rotated, false);
    assert.equal(result.reason, "disabled");
    assert.equal(statSync(path).size, 2048);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateLog keeps the requested number of archives, oldest last", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "daemon.err.log");
    writeFileSync(path, "third");
    writeFileSync(`${path}.1`, "second");
    const result = rotateLog(path, { maxBytes: 1, keep: 2 });
    assert.equal(result.rotated, true);
    assert.equal(readFileSync(`${path}.1`, "utf8"), "third");
    assert.equal(readFileSync(`${path}.2`, "utf8"), "second");
    assert.equal(readFileSync(path, "utf8"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotation keeps writing through the descriptor the supervisor opened", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "daemon.err.log");
    writeFileSync(path, "old\n");
    // launchd/systemd hand the daemon an already-open descriptor (append mode).
    const fd = openSync(path, "a");
    try {
      assert.equal(rotateOwnedLogs({ logDir: dir, names: ["daemon.err.log"], fds: [fd], maxBytes: 1 })[0].rotated, true);
      appendFileSync(fd, "new\n");
      assert.equal(readFileSync(path, "utf8"), "new\n");
      assert.equal(readFileSync(`${path}.1`, "utf8"), "old\n");
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateOwnedLogs leaves logs it does not own untouched", () => {
  const dir = tempDir();
  try {
    const owned = join(dir, "daemon.err.log");
    const foreign = join(dir, "daemon.out.log");
    writeFileSync(owned, "x".repeat(4096));
    writeFileSync(foreign, "y".repeat(4096));
    const fd = openSync(owned, "a");
    try {
      const results = rotateOwnedLogs({ logDir: dir, fds: [fd], maxBytes: 1 });
      assert.deepEqual(results.map((r) => r.name), ["daemon.err.log"]);
      assert.equal(results[0].rotated, true);
      assert.equal(readFileSync(foreign, "utf8"), "y".repeat(4096));
      assert.equal(existsSync(`${foreign}.1`), false, "a foreign log must not be archived");
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateOwnedLogs is a no-op in the container and in foreground mode", () => {
  const dir = tempDir();
  try {
    // stderr/stdout are pipes or a terminal there: nothing matches, nothing moves.
    writeFileSync(join(dir, "daemon.err.log"), "x".repeat(4096));
    assert.deepEqual(rotateOwnedLogs({ logDir: dir, fds: [], maxBytes: 1 }), []);
    assert.equal(statSync(join(dir, "daemon.err.log")).size, 4096);
    assert.deepEqual(rotateOwnedLogs({ logDir: join(dir, "absent"), maxBytes: 1 }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotationOptionsFromEnv reads the knobs and falls back on garbage", () => {
  assert.deepEqual(rotationOptionsFromEnv({}), { maxBytes: DEFAULT_MAX_BYTES, keep: DEFAULT_KEEP });
  assert.deepEqual(rotationOptionsFromEnv({ PI_COFFEE_LOG_MAX_MB: "1", PI_COFFEE_LOG_KEEP: "3" }), { maxBytes: 1024 * 1024, keep: 3 });
  assert.deepEqual(rotationOptionsFromEnv({ PI_COFFEE_LOG_MAX_MB: "0" }), { maxBytes: 0, keep: DEFAULT_KEEP });
  assert.deepEqual(rotationOptionsFromEnv({ PI_COFFEE_LOG_MAX_MB: "half", PI_COFFEE_LOG_KEEP: "0" }), { maxBytes: DEFAULT_MAX_BYTES, keep: DEFAULT_KEEP });
});

test("platform log names and directory match what the installers configure", () => {
  assert.deepEqual(DAEMON_LOG_NAMES, ["daemon.err.log", "daemon.out.log", "daemon.log"]);
  assert.equal(defaultLogDir("/home/example"), join("/home/example", ".pi-coffee", "logs"));
  const installer = readFileSync(new URL("../deploy/macos/install-daemon.sh", import.meta.url), "utf8");
  assert.match(installer, /LOG_DIR="\$HOME\/\.pi-coffee\/logs"/);
  for (const name of DAEMON_LOG_NAMES.slice(0, 2)) assert.match(installer, new RegExp(name.replace(".", "\\.")));
});
