#!/usr/bin/env node
/**
 * Credential-free demo: prove this installation works on this machine without spending tokens.
 *
 * Runs the deterministic offline smoke test (`SMOKE_LIVE=0`): a disposable git repository, a fake
 * pi worker, and the full control surface (spec linting, scope claims, acceptance files, verify,
 * merge, two-strikes, persistence). No model calls and no provider key are involved.
 *
 * Usage: npm run demo
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.SMOKE_LIVE = "0";
const root = fileURLToPath(new URL("../", import.meta.url));
const smoke = fileURLToPath(new URL("./smoke.mjs", import.meta.url));

// A checkout has to be compiled first; a published package ships `dist/` and no
// sources, where `tsc` has nothing to read (a hard build step here made
// `npm run demo` fail on every npm/pack install).
if (!existsSync(new URL("../dist/index.js", import.meta.url)) && existsSync(new URL("../tsconfig.json", import.meta.url))) {
  const build = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (build.error) throw build.error;
  if ((build.status ?? 1) !== 0) {
    console.error("error: the project could not be built; run npm install && npm run build");
    process.exit(build.status ?? 1);
  }
}

const result = spawnSync(process.execPath, [smoke, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
