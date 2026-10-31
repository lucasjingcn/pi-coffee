#!/usr/bin/env node
/**
 * Create the annotated release tag for the version in package.json.
 *
 * Publishing itself is done by .github/workflows/release.yml when the tag is
 * pushed: it runs the full verify suite, packs the npm tarball, creates the
 * GitHub release and pushes the GHCR image. This script never pushes, publishes,
 * or changes the version; bumping the version stays a reviewed commit.
 *
 *   node scripts/release.mjs --check     # print the tag that would be created
 *   node scripts/release.mjs             # verify, then create v<version>
 *   node scripts/release.mjs --no-verify # skip npm run verify (emergency only)
 *   node scripts/release.mjs --dry-run   # print the plan, change nothing
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/release.mjs [--check] [--dry-run] [--no-verify]

Creates the annotated tag v<package.json version>. It does not push; push the tag
to trigger .github/workflows/release.yml.`);
  process.exit(0);
}

const known = new Set(["--check", "--dry-run", "--no-verify"]);
for (const argument of args) {
  if (!known.has(argument)) fail(`unknown option ${argument}; see --help`);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  fail("package.json version is not semver");
}
const tag = `v${pkg.version}`;

function git(...gitArgs) {
  return execFileSync("git", ["-C", root, ...gitArgs], { encoding: "utf8" }).trim();
}

let existing = "";
try {
  existing = git("tag", "--list", tag);
} catch (error) {
  fail(`cannot inspect git tags: ${error.message}`);
}
if (existing) fail(`tag ${tag} already exists`);

if (args.has("--check")) {
  console.log(`package.json ${pkg.version} -> tag ${tag}`);
  process.exit(0);
}

const dirty = git("status", "--porcelain");
if (dirty) fail("working tree is not clean; commit or stash changes before tagging");

const dryRun = args.has("--dry-run");
if (!dryRun && !args.has("--no-verify")) {
  console.log("release: running npm run verify");
  execFileSync("npm", ["run", "verify"], { cwd: root, stdio: "inherit" });
}

const message = `pi-coffee ${tag}`;
if (dryRun) {
  console.log(`would create annotated tag ${tag} (${message})`);
  console.log(`push it with: git push origin ${tag}`);
  process.exit(0);
}

git("tag", "-a", tag, "-m", message);
console.log(`created ${tag}`);
console.log(`push it with: git push origin ${tag}`);
console.log("the release workflow then verifies, packs, publishes the GitHub release and pushes the GHCR image");
