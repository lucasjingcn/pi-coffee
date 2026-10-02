import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, writeFile, chmod, symlink, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlVault } from "../dist/control-vault.js";
const key = "a".repeat(43);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "control-vault-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, vault: new ControlVault(root) };
}
test("credentials survive fresh instances and atomic replacement with private permissions", async t => {
  const { root, vault } = await fixture(t);
  assert.equal(await vault.read("s1"), undefined);
  await vault.save("s1", key, "scope");
  assert.equal((await stat(vault.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(vault.directory, "s1.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await new ControlVault(root).read("s1"), { controlKey: key, scopeKey: "scope" });
  await vault.save("s1", "b".repeat(43), "scope2");
  assert.equal((await vault.read("s1")).scopeKey, "scope2");
  assert.deepEqual(await readdir(vault.directory), ["s1.json"]);
});
test("unsafe IDs and malformed keys are rejected without echoing secrets", async t => {
  const { vault } = await fixture(t);
  for (const id of ["../s1", "s0", "s01", "s1/evil", "s1\n", "worker"]) await assert.rejects(vault.save(id, key, "scope"));
  await assert.rejects(vault.save("s1", "private-invalid-secret", "scope"), error => !error.message.includes("private-invalid-secret"));
  await assert.rejects(vault.save("s1", key, "bad\nvalue"));
});
test("symlink directory and symlink target cannot read or overwrite external files", async t => {
  const { root, vault } = await fixture(t);
  const external = join(root, "external");
  await mkdir(external);
  await symlink(external, vault.directory);
  await assert.rejects(vault.save("s1", key, "scope"));
  await assert.rejects(vault.read("s1"));
  await rm(vault.directory);
  await vault.save("s1", key, "scope");
  const file = join(external, "secret");
  await writeFile(file, "unchanged");
  await rm(join(vault.directory, "s1.json"));
  await symlink(file, join(vault.directory, "s1.json"));
  await assert.rejects(vault.read("s1"));
  await assert.rejects(vault.save("s1", key, "scope"));
  assert.equal(await readFile(file, "utf8"), "unchanged");
});
test("corrupt and non-private credentials fail closed", async t => {
  const { vault } = await fixture(t);
  await vault.save("s1", key, "scope");
  const file = join(vault.directory, "s1.json");
  await chmod(file, 0o644);
  await assert.rejects(vault.read("s1"));
  await chmod(file, 0o600);
  await writeFile(file, '{"controlKey":"secret-broken"');
  await assert.rejects(vault.read("s1"), error => !error.message.includes("secret-broken"));
  await assert.rejects(vault.save("s1", key, "scope"));
  assert.deepEqual(await readdir(vault.directory), ["s1.json"]);
});
test("recovery CLI defaults to metadata and exposes keys only with explicit flag", async t => {
  const { root, vault } = await fixture(t);
  await vault.save("s1", key, "scope");
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const run = promisify(execFile);
  const env = { ...process.env, PI_COFFEE_DATA_DIR: root, PI_COFFEE_ENV_FILE: join(root, "missing-env") };
  const safe = await run(process.execPath, ["scripts/worker-control.mjs", "s1"], { env });
  assert.equal(JSON.parse(safe.stdout).credentials_available, true);
  assert.ok(!safe.stdout.includes(key));
  assert.ok(!safe.stdout.includes('"scope_key"'));
  const explicit = await run(process.execPath, ["scripts/worker-control.mjs", "s1", "--show-key"], { env });
  assert.equal(JSON.parse(explicit.stdout).control_key, key);
  assert.match(explicit.stderr, /Sensitive output/);
});
test("concurrent atomic saves never expose truncated credentials", async t => {
  const { vault } = await fixture(t);
  await vault.save("s1", key, "scope");
  await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    await vault.save("s1", (i % 2 ? "b" : "c").repeat(43), `scope${i}`);
    const saved = await vault.read("s1");
    assert.match(saved.controlKey, /^[bc]{43}$/);
    assert.match(saved.scopeKey, /^scope\d+$/);
  }));
  assert.deepEqual(await readdir(vault.directory), ["s1.json"]);
});
