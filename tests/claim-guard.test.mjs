import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";

test("claims are closed for ending sessions and absolute manual paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claim-guard-"));
  const c = new Coordinator(loadConfig({ dataDir: dir, workspaceRoot: join(dir, "w"), autoClean: false }));
  try {
    for (const status of ["stopping", "stopped", "error"]) {
      c.runtimes.set("s1", { meta: { id: "s1", status, pendingQuestions: [], lastActivity: Date.now() }, client: {} });
      assert.throws(() => c.claim("s1", ["a.txt"], "rw"), new RegExp(`is ${status}; its locks are closed`));
    }
    c.runtimes.delete("s1");
    assert.throws(() => c.claim("codex", [join(dir, "x.txt")], "rw"), /repo-relative; absolute path rejected/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
