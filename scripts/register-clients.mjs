#!/usr/bin/env node
/**
 * Register the pi-coffee stdio proxy as the MCP server `pi` with every MCP client
 * installed on this machine, and print how to connect the clients that must be
 * configured by hand.
 *
 * A new user should not have to install a particular client (historically Codex)
 * before pi-coffee will install at all. This script is the single registration
 * path used by `npm run install:local`; it never fails because one client is
 * missing. Codex and the pi CLI are edited in place (idempotently). DSH, Claude
 * Code and Cursor keep user-owned configuration, so for those it only prints the
 * exact command or snippet instead of writing it.
 *
 * Usage:
 *   node scripts/register-clients.mjs            # detect, register, print a summary
 *   node scripts/register-clients.mjs --json     # machine-readable result
 *   node scripts/register-clients.mjs --help
 *
 * Exit codes: 0 = every client that was found is registered, 1 = a registration
 * failed (the original client config is restored), 2 = invalid command line.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const NODE = process.execPath;
const PROXY = fileURLToPath(new URL("./proxy.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SERVER = "pi";
const DESCRIPTION = "pi-coffee: spawn, review, verify, and merge isolated pi coding workers";

function usage() {
  console.log(`pi-coffee MCP client registration

Registers the stdio proxy (${PROXY})
as the MCP server "${SERVER}" with the clients found on PATH:

  codex    \`codex mcp add pi -- <node> <proxy>\`   (skipped when codex is absent)
  pi       \`pi mcp add pi --description ... -- <node> <proxy>\`

DSH, Claude Code and Cursor are only reported: they keep their own user
configuration and are configured explicitly (docs/integrations/dsh.md).

Options:
  --json    Machine-readable result on stdout.
  --help    Show this help.

Exit codes: 0 registered, 1 registration failed (config restored), 2 bad arguments.`);
}

function parseArgs(argv) {
  const options = { json: false, help: false };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

/** Quote one argv element only when it actually needs quoting. */
function displayArg(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

function commandLine(argv) {
  return argv.map(displayArg).join(" ");
}

/** Quote an argument for cmd.exe. */
function cmdQuote(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Run an argv vector, using cmd.exe for .cmd/.bat shims on Windows. */
function runArgv(argv) {
  const [bin, ...args] = argv;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const line = argv.map(cmdQuote).join(" ");
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], { encoding: "utf8" });
  }
  return spawnSync(bin, args, { encoding: "utf8" });
}

function findOnPath(name) {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ? process.env.PATHEXT.split(";") : [".COM", ".EXE", ".BAT", ".CMD"])
    : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The pi CLI this machine installed, falling back to the pinned checkout package. */
function resolvePiArgv() {
  const entry = join(homedir(), ".local", "bin", process.platform === "win32" ? "pi.cmd" : "pi");
  if (existsSync(entry)) return [entry];
  const onPath = findOnPath("pi");
  if (onPath) return [onPath];
  // install:cli normally ran first; this keeps standalone runs on an old PATH working.
  const bundled = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  if (existsSync(bundled)) return [NODE, bundled];
  return undefined;
}

function failureText(result) {
  return (result.stderr || result.stdout || "").trim();
}

/**
 * Put the Codex config back exactly as it was.
 *
 * With no previous file a failed `codex mcp add` can leave a half-written TOML
 * (observed: `mcp_servers={pi={`), so the file has to be removed rather than left
 * behind. Reports whether the restore actually happened — the summary must not
 * claim a restore that did not take place.
 */
function restoreCodexConfig(configPath, existedBefore, backup) {
  try {
    if (existedBefore && backup !== null) {
      writeFileSync(configPath, backup);
      return true;
    }
    if (!existedBefore && existsSync(configPath)) rmSync(configPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Register with Codex, restoring its config file if the add fails. */
function registerCodex(codexBin) {
  const configPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  const existedBefore = existsSync(configPath);
  const backup = existedBefore ? readFileSync(configPath, "utf8") : null;
  // `codex mcp add` refuses a duplicate name, so the old entry is removed first.
  runArgv([codexBin, "mcp", "remove", SERVER]);
  const added = runArgv([codexBin, "mcp", "add", SERVER, "--", NODE, PROXY]);
  if (added.status !== 0) {
    const detail = failureText(added) || `codex mcp add ${SERVER} exited ${added.status}`;
    const restored = restoreCodexConfig(configPath, existedBefore, backup);
    const error = new Error(detail);
    error.restored = restored;
    error.configPath = configPath;
    throw error;
  }
  return ["codex", `codex mcp add ${SERVER}`];
}

/** Register with the installed pi CLI (`pi mcp add` replaces an existing entry). */
function registerPi(piArgv) {
  const argv = [...piArgv, "mcp", "add", SERVER, "--description", DESCRIPTION, "--", NODE, PROXY];
  const added = runArgv(argv);
  if (added.status !== 0) {
    // `pi mcp add` is add-or-replace and keeps the previous entry on failure, so
    // there is nothing to restore — and claiming a restore would be wrong.
    const error = new Error(failureText(added) || `pi mcp add ${SERVER} exited ${added.status}`);
    error.restored = "unchanged";
    throw error;
  }
  return ["pi", `${commandLine(piArgv)} mcp add ${SERVER}`];
}

function manualDetections() {
  const manual = [];
  const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
  if (existsSync(dshHome)) {
    manual.push({
      client: "dsh",
      detail: `detected ${dshHome} (not written)`,
      command: `node ${displayArg(join(ROOT, "scripts", "setup-dsh.mjs"))} --write`,
      reference: "docs/integrations/dsh.md",
    });
  }
  if (findOnPath("claude") || existsSync(join(homedir(), ".claude.json"))) {
    manual.push({
      client: "claude",
      detail: "detected Claude Code (not written)",
      command: `${displayArg("claude")} mcp add ${SERVER} -- ${displayArg(NODE)} ${displayArg(PROXY)}`,
    });
  }
  if (existsSync(join(homedir(), ".cursor"))) {
    manual.push({
      client: "cursor",
      detail: `detected ~/.cursor (add to ~/.cursor/mcp.json)`,
      command: "@see-snippet",
    });
  }
  return manual;
}

function main() {
  const options = parseArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
  if (options.help) {
    usage();
    return 0;
  }

  const result = {
    server: SERVER,
    node: NODE,
    proxy: PROXY,
    registered: [],
    manual: manualDetections(),
    failures: [],
    snippet: { mcpServers: { [SERVER]: { command: NODE, args: [PROXY] } } },
  };

  const codexBin = findOnPath("codex");
  if (codexBin) {
    try {
      const [client, command] = registerCodex(codexBin);
      result.registered.push({ client, command });
    } catch (error) {
      const restored = error instanceof Error && "restored" in error ? error.restored : false;
      result.failures.push({
        client: "codex",
        error: error instanceof Error ? error.message : String(error),
        restored: restored === true ? "restored" : "not-restored",
      });
    }
  }

  const piArgv = resolvePiArgv();
  if (piArgv) {
    try {
      const [client, command] = registerPi(piArgv);
      result.registered.push({ client, command });
    } catch (error) {
      const state = error instanceof Error && "restored" in error && error.restored === "unchanged"
        ? "unchanged"
        : "not-restored";
      result.failures.push({ client: "pi", error: error instanceof Error ? error.message : String(error), restored: state });
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.failures.length === 0 ? 0 : 1;
  }

  console.log("MCP client registration");
  for (const entry of result.registered) console.log(`  ${entry.client.padEnd(8)} registered`);
  for (const entry of result.manual) {
    console.log(`  ${entry.client.padEnd(8)} ${entry.detail}`);
    if (entry.command !== "@see-snippet") console.log(`           run: ${entry.command}`);
    if (entry.reference) console.log(`           docs: ${entry.reference}`);
  }
  for (const entry of result.failures) console.log(`  ${entry.client.padEnd(8)} FAILED: ${entry.error}`);

  const codexSkipped = !codexBin;
  if (codexSkipped && result.registered.every((entry) => entry.client !== "codex")) {
    console.log("  codex    not found on PATH; skipped (install Codex and rerun this script to add it)");
  }
  if (result.registered.length === 0) {
    console.log("  no MCP client was registered. Add this to your client's MCP configuration:");
    console.log(`    ${JSON.stringify(result.snippet)}`);
  } else if (result.manual.some((entry) => entry.command === "@see-snippet")) {
    console.log("  cursor   configuration snippet:");
    console.log(`    ${JSON.stringify(result.snippet)}`);
  }

  if (result.failures.length > 0) {
    // Say exactly what state each client is in; the old text promised a restore even
    // when the client had no backup (pi) or when the restore could not be written.
    for (const failure of result.failures) {
      if (failure.restored === "restored") {
        console.error(`\n${failure.client}: registration failed; its previous configuration was restored.`);
      } else if (failure.restored === "unchanged") {
        console.error(`\n${failure.client}: registration failed; its configuration was left unchanged.`);
      } else {
        console.error(`\n${failure.client}: registration failed AND its previous configuration could not be restored — inspect it before using this client.`);
      }
    }
    return 1;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
