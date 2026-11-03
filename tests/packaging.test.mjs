/**
 * Packaging contract: the published tarball is what the one-line installer and
 * `npx pi-coffee` run, and it deliberately ships a prebuilt `dist/` instead of
 * sources. Every consumer therefore has to cope with "no tsconfig.json, no src/".
 *
 * These assertions exist because a hard `npm run build` in install.sh made every
 * release-asset install abort with `error TS5058: The specified path does not
 * exist: 'tsconfig.json'`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("the published tarball ships a runnable package without sources", () => {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const files = JSON.parse(raw)[0].files.map((entry) => entry.path);
  const has = (path) => files.some((name) => name === path || name.startsWith(`${path}/`));

  for (const required of ["dist/index.js", "scripts/cli.mjs", "scripts/install-local.mjs",
    "install.sh", "codex/pi-orchestrator/SKILL.md", "deploy/windows/install.ps1", "package.json"]) {
    assert.ok(has(required), `${required} must be published`);
  }
  // Sources stay out of the package on purpose: the compiled output is the payload.
  assert.ok(!has("tsconfig.json"), "the tarball has no tsconfig.json");
  assert.ok(!has("src"), "the tarball has no src/");
});

test("every consumer copes with a source-less copy", () => {
  const install = readFileSync(join(root, "install.sh"), "utf8");
  // Build only when the sources are there; otherwise install runtime deps and use dist/.
  assert.match(install, /if \[ -f "\$DIR\/tsconfig\.json" \] && \[ -d "\$DIR\/src" \]/,
    "install.sh branches on whether this copy has sources");
  assert.match(install, /has no sources to build and no prebuilt dist/,
    "install.sh fails loudly when there is neither a dist nor sources");
  assert.equal(pkg.scripts.demo, "node scripts/demo.mjs",
    "npm run demo must not force a build (demo.mjs decides)");
  const cli = readFileSync(join(root, "scripts", "cli.mjs"), "utf8");
  assert.match(cli, /run\(script\("demo\.mjs"\)\)/, "the CLI delegates demo to demo.mjs");
  const demo = readFileSync(join(root, "scripts", "demo.mjs"), "utf8");
  assert.match(demo, /tsconfig\.json/, "demo.mjs builds only when sources exist");
});

test("the package declares an installable CLI entry point", () => {
  assert.equal(pkg.bin["pi-coffee"], "scripts/cli.mjs");
  assert.ok(existsSync(join(root, "scripts", "cli.mjs")), "the bin target exists");
  assert.equal(readFileSync(join(root, "scripts", "cli.mjs"), "utf8").split("\n")[0], "#!/usr/bin/env node");
  assert.equal(pkg.publishConfig?.access, "public");
  assert.notEqual(pkg.private, true, "a package that publishes must not be private");
});
