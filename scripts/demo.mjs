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
import { fileURLToPath } from "node:url";

process.env.SMOKE_LIVE = "0";
const smoke = fileURLToPath(new URL("./smoke.mjs", import.meta.url));
const result = spawnSync(process.execPath, [smoke, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
