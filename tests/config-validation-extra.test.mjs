import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";

test("parallelWarnThreshold validates env and overrides, override wins over invalid env", () => {
  const key = "PI_COFFEE_PARALLEL_WARN";
  const saved = process.env[key];
  delete process.env[key];
  try {
    assert.equal(loadConfig().parallelWarnThreshold, 4);
    for (const v of ["0", "-1", "1.5", "bogus", " "]) {
      process.env[key] = v;
      assert.throws(() => loadConfig(), new RegExp(key + "|parallelWarnThreshold"));
      delete process.env[key];
    }
    for (const v of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(
        () => loadConfig({ parallelWarnThreshold: v }),
        new RegExp(key + "|parallelWarnThreshold"),
      );
    }
    process.env[key] = "7";
    assert.equal(loadConfig().parallelWarnThreshold, 7);
    delete process.env[key];
    process.env[key] = "broken";
    assert.equal(loadConfig({ parallelWarnThreshold: 6 }).parallelWarnThreshold, 6);
    delete process.env[key];
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

test("overriding dataDir derives default workspaceRoot under effective dataDir", () => {
  const keys = ["PI_COFFEE_DATA_DIR", "PI_COFFEE_WORKSPACE_ROOT"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  keys.forEach((k) => delete process.env[k]);
  try {
    assert.equal(
      loadConfig({ dataDir: "/tmp/override-data" }).workspaceRoot,
      join("/tmp/override-data", "worktrees"),
    );
    process.env.PI_COFFEE_DATA_DIR = "/tmp/env-data";
    assert.equal(
      loadConfig({ dataDir: "/tmp/override-data" }).workspaceRoot,
      join("/tmp/override-data", "worktrees"),
    );
    process.env.PI_COFFEE_WORKSPACE_ROOT = "/tmp/explicit";
    assert.equal(loadConfig({ dataDir: "/tmp/override-data" }).workspaceRoot, "/tmp/explicit");
    delete process.env.PI_COFFEE_WORKSPACE_ROOT;
    assert.equal(loadConfig().workspaceRoot, join("/tmp/env-data", "worktrees"));
    delete process.env.PI_COFFEE_DATA_DIR;
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("workerPlugins parses env and overrides; empty denies by default", () => {
  const key = "PI_COFFEE_WORKER_PLUGINS";
  const saved = process.env[key];
  delete process.env[key];
  try {
    assert.deepEqual(loadConfig().workerPlugins, []);
    process.env[key] = "npm:@scope/a, extensions/keep.js , npm:@scope/a";
    assert.deepEqual(loadConfig().workerPlugins, ["npm:@scope/a", "extensions/keep.js"]);
    process.env[key] = ",";
    assert.throws(() => loadConfig(), new RegExp(key + "|workerPlugins"));
    delete process.env[key];
    process.env[key] = "bogus";
    assert.deepEqual(loadConfig({ workerPlugins: ["*"] }).workerPlugins, ["*"]);
    assert.throws(() => loadConfig({ workerPlugins: [""] }), new RegExp(key + "|workerPlugins"));
    delete process.env[key];
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

test("worker sandbox refuses a network that cannot reach the daemon", () => {
  assert.throws(
    () => loadConfig({ sandbox: "docker", sandboxImage: "img:1", sandboxNetwork: "none" }),
    /sandboxNetwork|PI_COFFEE_SANDBOX_NETWORK/,
  );
  const ok = loadConfig({ sandbox: "docker", sandboxImage: "img:1", sandboxNetwork: "bridge" });
  assert.equal(ok.sandboxNetwork, "bridge");
});

test("the verification temp root is configurable and must be absolute", () => {
  const key = "PI_COFFEE_VERIFY_TMPDIR";
  const saved = process.env[key];
  try {
    delete process.env[key];
    assert.ok(loadConfig().verifyTmpDir.length > 0);
    process.env[key] = "/var/tmp/pi-coffee-verify";
    assert.equal(loadConfig().verifyTmpDir, "/var/tmp/pi-coffee-verify");
    // A relative path would land wherever the daemon happens to run; a blank value
    // that is not empty (spaces) is a typo, not "unset" (an empty env var falls back
    // to the default, like every other key here).
    for (const bad of ["tmp/verify", "   "]) {
      process.env[key] = bad;
      assert.throws(() => loadConfig(), /verifyTmpDir|PI_COFFEE_VERIFY_TMPDIR/, JSON.stringify(bad));
    }
    assert.equal(loadConfig({ verifyTmpDir: "/mnt/shared/verify" }).verifyTmpDir, "/mnt/shared/verify");
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

test("the container user accepts auto, root or an explicit uid:gid and nothing else", () => {
  const key = "PI_COFFEE_SANDBOX_USER";
  const saved = process.env[key];
  try {
    delete process.env[key];
    assert.equal(loadConfig().sandboxUser, "auto");
    process.env[key] = "root";
    assert.equal(loadConfig().sandboxUser, "root");
    process.env[key] = "1000:1000";
    assert.equal(loadConfig().sandboxUser, "1000:1000");
    // A malformed value must fail loudly: it would otherwise reach `docker run`
    // as an argument the daemon cannot reason about.
    for (const bad of ["nobody", "1000", "1000:", ":1000", "1000:1000:1", "root:x"]) {
      process.env[key] = bad;
      assert.throws(() => loadConfig(), /sandboxUser|PI_COFFEE_SANDBOX_USER/, bad);
    }
    assert.equal(loadConfig({ sandboxUser: "2000:2000" }).sandboxUser, "2000:2000");
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

test("the container's coord host is configurable and defaults to host.docker.internal", () => {
  const key = "PI_COFFEE_SANDBOX_COORD_HOST";
  const saved = process.env[key];
  try {
    delete process.env[key];
    assert.equal(loadConfig().sandboxCoordHost, "host.docker.internal");
    process.env[key] = "172.17.0.1";
    assert.equal(loadConfig().sandboxCoordHost, "172.17.0.1");
    assert.equal(loadConfig({ sandboxCoordHost: "10.0.0.5" }).sandboxCoordHost, "10.0.0.5");
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});
