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
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { apiKeyVarFor, envFilePath, loadDaemonEnv } from "./lib/env.mjs";
import { resolvePiBin, piVersion } from "./lib/pi.mjs";
import { resolveBashBin } from "./lib/bash.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

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
const { loaded, values } = loadDaemonEnv(envFile);
const background = process.argv.includes("--background");

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

// --- process ownership probe ---
// The daemon proves worker process ownership with `ps` (group id + start time).
// Minimal images such as node:22-bookworm-slim do not ship it.
if (process.platform !== "win32") {
  const psProbe = run("ps", ["-p", String(process.pid), "-o", "lstart=", "-o", "pgid="]);
  check(
    "ps (worker ownership probe)",
    Boolean(psProbe),
    psProbe ? "available" : "not found",
    "install procps (Debian/Ubuntu) or make ps available on PATH",
  );
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
// pi resolves its agent directory from PI_CODING_AGENT_DIR first (getAgentDir());
// hardcoding ~/.pi/agent made an install that relocates the directory report a
// false FAIL and exit 1 even though pi itself could authenticate.
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const authPath = join(agentDir, "auth.json");
// Background installers cannot inherit transient API keys from this shell.
const hasEnvKey = Boolean(process.env[keyVar]) && (!background || Boolean(values[keyVar]));
const hasAuth = existsSync(authPath);
check(
  `credentials for ${provider}`,
  hasEnvKey || hasAuth,
  hasEnvKey ? `${keyVar} is set` : hasAuth ? `pi auth.json found at ${authPath}` : `no ${keyVar} and no ${authPath}`,
  background ? "store credentials in the private env file with `npm run setup`, or configure pi auth.json" : "run `npm run setup` to store an API key",
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

// --- MCP clients (informational) ---
// A missing registration does not break the daemon, so it never changes the exit code; it is
// the step people forget after installing the daemon or adding a new client.
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
function mcpClients() {
  const rows = [];
  const codexConfig = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  if (existsSync(codexConfig) || run("codex", ["--version"]) !== undefined) {
    rows.push({
      name: "codex",
      registered: existsSync(codexConfig) && /\[mcp_servers\.pi\]/.test(readFileSync(codexConfig, "utf8")),
      hint: "node scripts/register-clients.mjs",
    });
  }
  const piConfig = join(homedir(), ".pi", "agent", "mcp.json");
  if (existsSync(join(homedir(), ".pi")) || existsSync(join(homedir(), ".local", "bin", "pi"))) {
    rows.push({
      name: "pi",
      registered: Boolean(readJson(piConfig)?.mcpServers?.pi),
      hint: "node scripts/register-clients.mjs",
    });
  }
  // DSH never writes itself from the installer: `/internal/health` users run the explicit command.
  const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
  if (existsSync(dshHome)) {
    rows.push({
      name: "dsh",
      registered: false,
      hint: `node ${join(repoRoot, "scripts", "setup-dsh.mjs")} --write`,
      detected: dshHome,
    });
  }
  const claudeConfig = join(homedir(), ".claude.json");
  const claudeJson = readJson(claudeConfig);
  if (existsSync(claudeConfig)) {
    rows.push({ name: "claude", registered: Boolean(claudeJson?.mcpServers?.pi), hint: "node scripts/register-clients.mjs" });
  }
  const cursorConfig = join(homedir(), ".cursor", "mcp.json");
  if (existsSync(join(homedir(), ".cursor"))) {
    rows.push({ name: "cursor", registered: Boolean(readJson(cursorConfig)?.mcpServers?.pi), hint: "node scripts/register-clients.mjs" });
  }
  return rows;
}
const clientRows = mcpClients();
console.log("\nMCP clients");
if (clientRows.length === 0) {
  console.log("  none detected. Connect an MCP client (Codex, DSH, Claude, Cursor, ...), then run");
  console.log("  `node scripts/register-clients.mjs` and restart it.");
} else {
  for (const row of clientRows) {
    const state = row.registered ? "registered" : row.detected ? `detected, not registered -> ${row.hint}` : `not registered -> ${row.hint}`;
    console.log(`  ${row.name.padEnd(8)} ${state}`);
  }
}

const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
