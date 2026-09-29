#!/usr/bin/env node
/**
 * Preflight check for pi-coffee.
 *
 * Verifies everything the daemon needs before you start it: Node, git, the pi
 * binary, provider credentials, and a writable data directory. Nothing is
 * changed except creating the data directory if it is missing.
 *
 *   npm run doctor
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { apiKeyVarFor, envFilePath, loadEnvFile } from "./lib/env.mjs";
import { resolvePiBin, piVersion } from "./lib/pi.mjs";
import { resolveBashBin } from "./lib/bash.mjs";

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim();
  } catch {
    return undefined;
  }
}

const checks = [];
function check(name, ok, detail, hint) {
  checks.push({ name, ok, detail, hint });
}

// Load the generated env file first so its provider/model/pi settings are visible.
const envFile = envFilePath();
const { loaded } = loadEnvFile(envFile);

// --- Node ---
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
check(
  "Node.js >= 22.19",
  nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19),
  `v${process.versions.node}`,
  "install Node 22.19 or newer",
);

// --- git ---
const gitVersion = run("git", ["--version"]);
check("git", Boolean(gitVersion), gitVersion ?? "not found", "install git");
if (process.platform === "win32") {
  const bashBin = resolveBashBin();
  check("Git Bash", Boolean(bashBin), bashBin ?? "not found", "install Git for Windows with Git Bash");
}

// --- pi ---
const piBin = resolvePiBin();
const piVer = piBin ? piVersion(piBin) : undefined;
check(
  "pi binary",
  Boolean(piBin),
  piBin ? `${piBin}${piVer ? ` (v${piVer})` : ""}` : "not found",
  "run npm install to install the pinned local pi dependency",
);

// --- provider credentials ---
// pi accepts either an env var (which we pass through) or its own auth.json.
const provider = process.env.PI_COFFEE_PROVIDER || "deepseek";
const keyVar = apiKeyVarFor(provider);
const authPath = join(homedir(), ".pi", "agent", "auth.json");
const hasEnvKey = Boolean(process.env[keyVar]);
const hasAuth = existsSync(authPath);
check(
  `credentials for ${provider}`,
  hasEnvKey || hasAuth,
  hasEnvKey ? `${keyVar} is set` : hasAuth ? `pi auth.json found at ${authPath}` : `no ${keyVar} and no ${authPath}`,
  "run `npm run setup` to store an API key",
);

// --- data directory ---
const dataDir = process.env.PI_COFFEE_DATA_DIR || join(homedir(), ".pi-coffee");
let dataOk = true;
let dataDetail = dataDir;
try {
  mkdirSync(dataDir, { recursive: true });
  accessSync(dataDir, constants.W_OK);
} catch (error) {
  dataOk = false;
  dataDetail = `${dataDir}: ${error.message}`;
}
check("data directory writable", dataOk, dataDetail);

// --- report ---
const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) {
  console.log(`${c.ok ? "  ok " : "FAIL "} ${c.name.padEnd(width)}  ${c.detail}`);
  if (!c.ok && c.hint) console.log(`       ${" ".repeat(width)}  -> ${c.hint}`);
}
console.log(loaded ? `\n(settings loaded from ${envFile})` : `\n(no settings file at ${envFile}; using the process environment)`);

const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
