import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";

test("cleanSessionDir removes finished stopped transcripts and preserves the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-clean-"));
  const dataDir = join(root, "data");
  const c = new Coordinator(loadConfig({ dataDir, workspaceRoot: join(root, "w"), autoClean: true }));
  await c.init();
  const dirs = ["done", "not_stopped", "no_outcome", "abandoned"];
  for (const d of dirs) await mkdir(join(dataDir, "sessions", d), { recursive: true });
  try {
    assert.equal(await c["cleanSessionDir"]({ id: "done", status: "stopped", outcome: "success_first" }), true);
    assert.equal(await c["cleanSessionDir"]({ id: "not_stopped", status: "idle", outcome: "success_first" }), false);
    assert.equal(await c["cleanSessionDir"]({ id: "no_outcome", status: "stopped", outcome: undefined }), false);
    // abandoned is not in the finished auto-clean set
    assert.equal(await c["cleanSessionDir"]({ id: "abandoned", status: "stopped", outcome: "abandoned" }), false);
    assert.equal(existsSync(join(dataDir, "sessions", "done")), false);
    assert.equal(existsSync(join(dataDir, "sessions", "not_stopped")), true);
    assert.equal(existsSync(join(dataDir, "sessions", "no_outcome")), true);
    assert.equal(existsSync(join(dataDir, "sessions", "abandoned")), true);
  } finally {
    await c.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});