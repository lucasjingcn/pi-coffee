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
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { apiKeyVarFor, envFilePath, loadDaemonEnv } from "./lib/env.mjs";
import { readJson, tryCommand } from "./lib/cli.mjs";
import { authJsonPath, resolveAgentDir } from "./lib/agent-dir.mjs";
import { resolvePiBin, piVersion } from "./lib/pi.mjs";
import { resolveBashBin } from "./lib/bash.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Run the first candidate that answers. On Windows the CLIs are `.cmd` shims,
 * which cannot be spawned without a shell, so `codex` alone probes nothing.
 */
function runAny(candidates, args) {
  for (const candidate of candidates) {
    const output = tryCommand(candidate, args);
    if (output !== undefined) return output;
  }
  return undefined;
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
const gitVersion = tryCommand("git", ["--version"]);
check("git", Boolean(gitVersion), gitVersion ?? "not found", "install git");
if (process.platform === "win32") {
  const bashBin = resolveBashBin();
  check("Git Bash", Boolean(bashBin), bashBin ?? "not found", "install Git for Windows with Git Bash");
}

// --- process ownership probe ---
// The daemon proves worker process ownership with `ps` (group id + start time).
// Minimal images such as node:22-bookworm-slim do not ship it.
if (process.platform !== "win32") {
  const psProbe = tryCommand("ps", ["-p", String(process.pid), "-o", "lstart=", "-o", "pgid="]);
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
// pi resolves its agent directory from PI_CODING_AGENT_DIR first (getAgentDir()).
// Under --background that variable must come from the env file: a launchd agent or
// systemd unit only forwards what the service definition sets, so validating the
// shell's value checks a path the daemon will never see.
const agentDir = background
  ? resolveAgentDir({ PI_CODING_AGENT_DIR: values.PI_CODING_AGENT_DIR })
  : resolveAgentDir();
const authPath = authJsonPath(agentDir);
// Background installers cannot inherit transient API keys from this shell.
const hasEnvKey = Boolean(process.env[keyVar]) && (!background || Boolean(values[keyVar]));
// auth.json is `{ providerId: credential }`: a file that exists but holds only
// another provider's login is not a credential for this one (that false PASS let
// the install finish and the first model call fail).
const hasAuth = hasProviderCredential(authPath, provider);
const hasModels = hasModelsProviderCredential(agentDir, provider);
check(
  `credentials for ${provider}`,
  hasEnvKey || hasAuth || hasModels,
  hasEnvKey ? `${keyVar} is set`
    : hasAuth ? `pi auth.json has a ${provider} entry at ${authPath}`
    : hasModels ? `${provider} is configured with a key in ${join(agentDir, "models.json")}`
    : `no ${keyVar}, no ${provider} entry in ${authPath}, and no ${provider} provider in models.json`,
  background
    ? "store credentials in the private env file with `npm run setup`, or configure pi auth.json / models.json"
    : "run `npm run setup` to store an API key",
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
/** True when pi's auth.json holds a credential for this provider. */
function hasProviderCredential(path, provider) {
  const parsed = readJson(path);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const entry = parsed[provider];
  return entry !== undefined && entry !== null && entry !== "";
}

/**
 * True when the provider is declared in pi's `models.json` with a usable key.
 *
 * A custom provider (a local gateway, a relay) lives there — `providers.<id>.apiKey`,
 * optionally an env-var reference — and never appears in auth.json. Checking only
 * auth.json reported a false FAIL for exactly that setup.
 */
function hasModelsProviderCredential(agentDir, provider) {
  const parsed = readJson(join(agentDir, "models.json"));
  const providers = parsed && typeof parsed === "object" ? parsed.providers ?? parsed : undefined;
  if (!providers || typeof providers !== "object") return false;
  const entry = providers[provider];
  if (!entry || typeof entry !== "object") return false;
  const inline = entry.apiKey ?? entry.api_key ?? entry.key;
  if (typeof inline === "string" && inline.trim() !== "") return true;
  const envName = entry.apiKeyEnv ?? entry.api_key_env;
  if (typeof envName === "string" && envName.trim() !== "") {
    const name = envName.trim();
    // A background service only sees what the env file (or unit) provides.
    return background ? Boolean(values[name]) : Boolean(process.env[name]);
  }
  return false;
}

/** Read a config file without ever throwing: an unreadable file is "not registered". */
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** True when a DSH profile patch registers this server (managed block or hand-written row). */
function dshRegistered(dshHome) {
  const profiles = join(dshHome, "profiles");
  let names;
  try {
    names = readdirSync(profiles);
  } catch {
    return false;
  }
  for (const name of names) {
    const text = readText(join(profiles, name, "cordis.patch.yml"));
    if (text && /(serverName|id):\s*['"]?(pi-coffee|mcp-pi-coffee)['"]?/.test(text)) return true;
  }
  return false;
}

function mcpClients() {
  const rows = [];
  const codexConfig = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  const codexBin = runAny(process.platform === "win32" ? ["codex", "codex.cmd"] : ["codex"], ["--version"]);
  if (existsSync(codexConfig) || codexBin !== undefined) {
    // A config we cannot read is reported as "not registered", never as a crash:
    // this section is informational and must not fail an installation.
    rows.push({
      name: "codex",
      registered: /\[mcp_servers\.pi\]/.test(readText(codexConfig) ?? ""),
      hint: "node scripts/register-clients.mjs",
    });
  }
  // pi keeps its MCP configuration in the agent directory (getAgentDir()).
  const piConfig = join(agentDir, "mcp.json");
  const piEntry = join(homedir(), ".local", "bin", process.platform === "win32" ? "pi.cmd" : "pi");
  if (existsSync(agentDir) || existsSync(piEntry) || existsSync(join(homedir(), ".pi"))) {
    rows.push({
      name: "pi",
      registered: Boolean(readJson(piConfig)?.mcpServers?.pi),
      hint: "node scripts/register-clients.mjs",
    });
  }
  // DSH keeps its own profile patch layer; the installer only prints the command.
  const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
  if (existsSync(dshHome)) {
    rows.push({
      name: "dsh",
      registered: dshRegistered(dshHome),
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
