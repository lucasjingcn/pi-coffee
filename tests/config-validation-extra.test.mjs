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
