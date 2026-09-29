import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { writeEnvFile } from "../scripts/lib/env.mjs";
import { resolvePiBin } from "../scripts/lib/pi.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("pinned local pi CLI resolves on this platform", () => {
  const pi = resolvePiBin();
  assert.ok(pi && pi.endsWith("cli.js"), `unexpected pi binary: ${pi}`);
});

test("npm start loads the private env file before binding the daemon", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-coffee-start-"));
  const port = await freePort();
  const envFile = join(temp, "env");
  writeEnvFile({ PI_COFFEE_PORT: String(port), PI_COFFEE_DATA_DIR: join(temp, "state") }, envFile);
  const child = spawn(process.execPath, ["scripts/start.mjs"], {
    cwd: root,
    env: { ...process.env, PI_COFFEE_ENV_FILE: envFile, PI_COFFEE_PORT: "1" },
    stdio: "ignore",
  });
  let exited = false;
  child.on("exit", () => { exited = true; });
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (exited) throw new Error("daemon exited before becoming healthy");
      let response;
      try { response = await fetch(`http://127.0.0.1:${port}/internal/health`); }
      catch { /* still starting */ }
      if (response?.ok) {
        assert.equal((await response.json()).ok, true);
        const result = execFileSync(process.execPath, ["scripts/check-health.mjs"], {
          cwd: root,
          env: { ...process.env, PI_COFFEE_ENV_FILE: envFile },
          encoding: "utf8",
        });
        assert.match(result, /pi-coffee is healthy/);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("daemon did not become healthy");
  } finally {
    if (!exited) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
