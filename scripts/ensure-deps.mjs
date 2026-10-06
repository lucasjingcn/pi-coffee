#!/usr/bin/env node
/**
 * Make `npm run verify` self-bootstrapping.
 *
 * The verification candidate is a bare `git worktree` in a temp dir: git only
 * materializes tracked files, so `node_modules` (gitignored) is absent and any
 * `tsc`/test command dies with `command not found`. The acceptance command is
 * fixed at dispatch, so the project's own `verify` script has to be able to
 * install its dependencies itself.
 *
 * A normal checkout already has `node_modules`; this exits immediately there.
 * In a bare candidate it runs `npm ci` once (lockfile-pinned, lifecycle scripts
 * disabled) before the real checks start.
 *
 *   node scripts/ensure-deps.mjs
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modules = join(root, "node_modules");

if (existsSync(modules)) {
  process.exit(0);
}
if (!existsSync(join(root, "package.json"))) {
  console.error("[verify] no package.json next to scripts/; nothing to bootstrap");
  process.exitCode = 1;
} else if (!existsSync(join(root, "package-lock.json"))) {
  console.error("[verify] node_modules is missing and there is no package-lock.json; run npm install in the checkout");
  process.exitCode = 1;
} else {
  console.error("[verify] node_modules is missing (bare candidate tree) — running npm ci --ignore-scripts");
  try {
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
  } catch (error) {
    console.error(`[verify] dependency bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
