import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile } from "../scripts/lib/env.mjs";

test("parseEnvFile drops inline comments without harming quoted or comment-bearing values", () => {
  const env = parseEnvFile(
    [
      "PI_COFFEE_THINKING=max", // no comment
      "PI_COFFEE_MODEL='glm-5.3'  # note with spaces",
      "PI_COFFEE_WORKER=deepseek-flash # ok",
      'FLAG="a b" # keep the inner space',
      "HASH=abc#def", // no whitespace before # -> # is literal
      "QUOTED='a#b'", // # inside single quotes -> preserved
      'DQ="# inside double quotes"',
      "# a full-line comment",
      "EMPTY=",
    ].join("\n"),
  );
  assert.equal(env.PI_COFFEE_THINKING, "max");
  assert.equal(env.PI_COFFEE_MODEL, "glm-5.3");
  assert.equal(env.PI_COFFEE_WORKER, "deepseek-flash");
  assert.equal(env.FLAG, "a b");
  assert.equal(env.HASH, "abc#def");
  assert.equal(env.QUOTED, "a#b");
  assert.equal(env.DQ, "# inside double quotes");
  assert.equal(env.EMPTY, "");
  assert.equal(Object.keys(env).length, 8);
});
test("the process environment overrides the settings file, which only fills gaps", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadEnvFile } = await import("../scripts/lib/env.mjs");
  const dir = mkdtempSync(join(tmpdir(), "pi-env-precedence-"));
  const file = join(dir, "env");
  writeFileSync(file, "PI_COFFEE_PORT=8787\nPI_COFFEE_MODEL=from-file\n");
  try {
    process.env.PI_COFFEE_PORT = "9100";
    delete process.env.PI_COFFEE_MODEL;
    loadEnvFile(file, { override: false });
    assert.equal(process.env.PI_COFFEE_PORT, "9100", "an exported value wins");
    assert.equal(process.env.PI_COFFEE_MODEL, "from-file", "the file fills a gap");
  } finally {
    delete process.env.PI_COFFEE_PORT;
    delete process.env.PI_COFFEE_MODEL;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an `export KEY=VALUE` line sets the real variable and junk keys are ignored", async () => {
  const { parseEnvFile } = await import("../scripts/lib/env.mjs");
  // The file is documented as shell-sourced, so what people paste from a .env or
  // their shell history must work; before this the key became
  // "export PI_COFFEE_PORT" and the daemon/client silently used the default.
  const parsed = parseEnvFile([
    "export PI_COFFEE_PORT=9000",
    "export  PI_COFFEE_TOKEN='secret value'",
    "PI_COFFEE_MODEL=deepseek-flash",
    "not a key=1",
    "# comment",
  ].join("\n"));
  assert.deepEqual(parsed, {
    PI_COFFEE_PORT: "9000",
    PI_COFFEE_TOKEN: "secret value",
    PI_COFFEE_MODEL: "deepseek-flash",
  });
});
