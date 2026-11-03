#!/usr/bin/env node
/**
 * Register the pi-coffee daemon as an MCP server for DeepSeek Harness (DSH).
 *
 * DSH composes its plugin tree from patch layers. The user's own layer is
 * `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (default `~/.dsh`, profile
 * `desktop`), a top-level YAML array of loader patch entries; inserting a
 * `@deepseek-ai/dsh-mcp-client` row there publishes that server's tools as
 * `mcp__<serverName>__<tool>`. The same entry-list dialect is readable as JSON,
 * so `--config` also accepts a `.json` file: either a DSH patch list (array) or
 * a portable `{ "mcpServers": { ... } }` object.
 *
 *   node scripts/setup-dsh.mjs --print                      # JSON MCP config on stdout
 *   node scripts/setup-dsh.mjs --print --format yaml        # DSH patch row for cordis.patch.yml
 *   node scripts/setup-dsh.mjs --print --transport stdio    # stdio proxy command instead of HTTP
 *   node scripts/setup-dsh.mjs --write                      # merge into the profile patch layer
 *   node scripts/setup-dsh.mjs --write --config /tmp/mcp.json --profile work
 *   node scripts/setup-dsh.mjs --help
 *
 * Secrets: the daemon's shared secret (PI_COFFEE_TOKEN) is never printed or
 * written. An HTTP row that needs it carries an env reference instead —
 * `!!js process.env.PI_COFFEE_TOKEN` in YAML, `${PI_COFFEE_TOKEN}` in JSON.
 *
 * Exit codes: 0 success (including an already-correct config), 1 refused or
 * failed write, 2 invalid command line.
 *
 * Defaults mirror the daemon (src/config.ts, scripts/start.mjs): the env file is
 * loaded first like the daemon does, so the printed port/token state matches the
 * process that is actually serving /mcp.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDaemonEnv } from "./lib/env.mjs";

/** Server namespace; DSH names the tools `mcp__pi-coffee__<tool>`. */
const SERVER_NAME = "pi-coffee";
/** Loader entry id for the inserted row (id-targeted patches must reuse it). */
const ROW_ID = "mcp-pi-coffee";
/** Plugin that provides MCP client entries; shipped with the DSH installation. */
const MCP_CLIENT_PLUGIN = "@deepseek-ai/dsh-mcp-client";
/** Defaults from src/config.ts; the env file may override the port. */
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
/**
 * pi_verify and pi_exec run the acceptance command for up to 10 minutes and
 * pi_wait blocks for its whole window; DSH's default cap is 60,000 ms.
 */
const TOOL_CALL_TIMEOUT_MS = 900_000;
/** The user's own patch layer inside a DSH profile directory. */
const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
const DEFAULT_PROFILE = "desktop";
const TOKEN_PLACEHOLDER = "${PI_COFFEE_TOKEN}";
const BEGIN_MARK = "# >>> pi-coffee MCP (managed by scripts/setup-dsh.mjs) >>>";
const END_MARK = "# <<< pi-coffee MCP (managed by scripts/setup-dsh.mjs) <<<";
const PROXY_SCRIPT = fileURLToPath(new URL("./proxy.mjs", import.meta.url));

const USAGE = "Usage: node scripts/setup-dsh.mjs (--print | --write) [options] | --help";

const HELP = `${USAGE}

Register the pi-coffee daemon as an MCP server for DeepSeek Harness (DSH).

Modes (exactly one):
  --print                 Print a JSON MCP config object with one mcpServers entry.
  --write                 Merge the entry into the DSH config, idempotently.
  --help, -h              Show this help.

Options:
  --transport <kind>      http (default) or stdio. http talks to the daemon's
                          /mcp endpoint; stdio runs scripts/proxy.mjs, which
                          forwards to the same daemon and reconnects on restart.
  --url <url>             Override the MCP endpoint (default
                          http://${DEFAULT_HOST}:${"<port>"}/mcp, port from
                          PI_COFFEE_PORT or the pi-coffee env file, default ${DEFAULT_PORT}).
  --format <json|yaml>    --print output format. json (default) is an MCP config
                          object; yaml is the DSH patch row for cordis.patch.yml.
  --config <path>         --write target. Default:
                          $DSH_HOME/profiles/<profile>/cordis.patch.yml.
                          A .json target is merged as JSON (DSH patch list or
                          {"mcpServers": {...}}); .yml/.yaml is merged as the
                          YAML patch layer.
  --profile <name>        DSH profile for the default target (default ${DEFAULT_PROFILE}).

The shared secret PI_COFFEE_TOKEN is read to decide whether a token header is
needed; its value is never printed or written.

Exit status: 0 ok, 1 refused/failed write, 2 bad usage.
`;

class UsageError extends Error {}
class Refusal extends Error {}

function parseArgs(argv) {
  const options = {
    print: false,
    write: false,
    help: false,
    transport: "http",
    url: undefined,
    format: "json",
    config: undefined,
    profile: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next === "") throw new UsageError(`${arg} requires a value`);
      return next;
    };
    if (arg === "--print") options.print = true;
    else if (arg === "--write") options.write = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--transport") options.transport = value();
    else if (arg.startsWith("--transport=")) options.transport = arg.slice("--transport=".length);
    else if (arg === "--url") options.url = value();
    else if (arg.startsWith("--url=")) options.url = arg.slice("--url=".length);
    else if (arg === "--format") options.format = value();
    else if (arg.startsWith("--format=")) options.format = arg.slice("--format=".length);
    else if (arg === "--config") options.config = value();
    else if (arg.startsWith("--config=")) options.config = arg.slice("--config=".length);
    else if (arg === "--profile") options.profile = value();
    else if (arg.startsWith("--profile=")) options.profile = arg.slice("--profile=".length);
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (options.help) return options;
  if (options.print === options.write) throw new UsageError("pass exactly one of --print or --write");
  if (!["http", "stdio"].includes(options.transport)) {
    throw new UsageError(`--transport must be http or stdio (got ${options.transport})`);
  }
  if (!["json", "yaml"].includes(options.format)) {
    throw new UsageError(`--format must be json or yaml (got ${options.format})`);
  }
  return options;
}

/** The daemon port as the daemon itself resolves it, after loading its env file. */
function resolvePort() {
  const raw = process.env.PI_COFFEE_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`invalid PI_COFFEE_PORT: ${raw} (expected an integer 1-65535)`);
  }
  return port;
}

function mcpUrl(options) {
  if (options.url) return options.url;
  return `http://${DEFAULT_HOST}:${resolvePort()}/mcp`;
}

/** Token visible to this process; `SHELL_TOKEN` is the part DSH will also see. */
const SHELL_TOKEN = process.env.PI_COFFEE_TOKEN;

function hasToken() {
  const token = process.env.PI_COFFEE_TOKEN;
  return typeof token === "string" && token.length > 0;
}

/**
 * The http row references `PI_COFFEE_TOKEN` so no secret is written to config,
 * but only scripts/proxy.mjs loads ~/.pi-coffee/env for the stdio transport: a
 * DSH process does not, so a token that lives only in that file resolves to an
 * empty header and every call gets 401.
 */
function warnIfTokenIsFileOnly(options) {
  if (options.transport === "stdio") return;
  if (!hasToken() || (typeof SHELL_TOKEN === "string" && SHELL_TOKEN.length > 0)) return;
  console.error(
    "setup-dsh: PI_COFFEE_TOKEN comes from the settings file, which DSH does not load; " +
      "export it in the environment DSH starts with, or use --transport stdio (scripts/proxy.mjs reads the file).",
  );
}

/** DSH home: `$DSH_HOME` or `~/.dsh` (convention used by @deepseek-ai/dsh-home-paths). */
function dshHome() {
  const home = process.env.DSH_HOME;
  return home && home.length > 0 ? resolve(home) : join(homedir(), ".dsh");
}

function defaultConfigPath(profile) {
  return join(dshHome(), "profiles", profile ?? DEFAULT_PROFILE, PROFILE_PATCH_FILENAME);
}

/** MCP client config as DSH validates it (transport, serverName, url/command...). */
function buildConfig(options) {
  if (options.transport === "stdio") {
    return {
      transport: "stdio",
      serverName: SERVER_NAME,
      command: process.execPath,
      args: [PROXY_SCRIPT],
      toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
    };
  }
  const config = {
    transport: "streamable-http",
    serverName: SERVER_NAME,
    url: mcpUrl(options),
    toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
  };
  if (hasToken()) config.headers = { "x-pi-coord-token": TOKEN_PLACEHOLDER };
  return config;
}

/** YAML single-quoted scalar (YAML escapes a quote by doubling it). */
function yamlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * One loader patch entry. `!!js` keeps the shared secret out of the file: DSH
 * evaluates the expression at activation, so the token stays in the environment
 * (or in ~/.pi-coffee/env, which scripts/proxy.mjs loads).
 */
function renderYamlBlock(options) {
  const lines = [
    BEGIN_MARK,
    "- insert:",
    `    - id: ${ROW_ID}`,
    `      name: ${yamlString(MCP_CLIENT_PLUGIN)}`,
    "      config:",
    `        serverName: ${SERVER_NAME}`,
  ];
  if (options.transport === "stdio") {
    lines.push(
      "        transport: stdio",
      `        command: ${yamlString(process.execPath)}`,
      "        args:",
      `          - ${yamlString(PROXY_SCRIPT)}`,
      `        toolCallTimeoutMs: ${TOOL_CALL_TIMEOUT_MS}`,
    );
  } else {
    lines.push(
      "        transport: streamable-http",
      `        url: ${mcpUrl(options)}`,
      `        toolCallTimeoutMs: ${TOOL_CALL_TIMEOUT_MS}`,
    );
    if (hasToken()) {
      lines.push("        headers:", "          x-pi-coord-token: !!js process.env.PI_COFFEE_TOKEN");
    }
  }
  lines.push(END_MARK);
  return lines.join("\n");
}

/** Write via a sibling temp file so a crash cannot truncate an existing config. */
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.${path.split("/").pop()}.tmp`);
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function isDshMcpRow(row) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
  if (row.id === ROW_ID) return true;
  if (row.name !== MCP_CLIENT_PLUGIN) return false;
  const config = row.config;
  return Boolean(config) && typeof config === "object" && config.serverName === SERVER_NAME;
}

/**
 * Merge the row into a JSON target without disturbing anything else.
 * Returns { data, mode } where mode is 'created' | 'updated' | 'unchanged'.
 */
function mergeJson(data, entry) {
  const row = { id: ROW_ID, name: MCP_CLIENT_PLUGIN, config: entry };

  if (Array.isArray(data)) {
    // DSH patch list: register through `insert`, replace our own row in place.
    for (const patch of data) {
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) continue;
      if (Array.isArray(patch.insert)) {
        const index = patch.insert.findIndex(isDshMcpRow);
        if (index >= 0) {
          patch.insert[index] = row;
          return { data, mode: "updated" };
        }
        continue;
      }
      if (isDshMcpRow(patch)) {
        patch.name = MCP_CLIENT_PLUGIN;
        patch.config = entry;
        return { data, mode: "updated" };
      }
    }
    data.push({ insert: [row] });
    return { data, mode: "created" };
  }

  if (data === null || typeof data !== "object") {
    throw new Refusal("expected a JSON object or a DSH patch list (array) at the top level");
  }

  const servers = data.mcpServers;
  if (servers === undefined) {
    data.mcpServers = { [SERVER_NAME]: entry };
    return { data, mode: "created" };
  }
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Refusal("mcpServers must be a JSON object");
  }
  const previous = servers[SERVER_NAME];
  servers[SERVER_NAME] = entry;
  return { data, mode: previous === undefined ? "created" : "updated" };
}

function readJsonConfig(path) {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Refusal(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); refusing to overwrite it`);
  }
}

function writeJsonConfig(path, options) {
  const original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const data = readJsonConfig(path);
  const { data: merged, mode } = mergeJson(data === undefined ? {} : data, buildConfig(options));
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  if (original === text) return { mode: "unchanged", path };
  writeAtomic(path, text);
  return { mode, path };
}

function significantLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function writeYamlConfig(path, options) {
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = significantLines(original);
  if (lines.length > 0 && !lines[0].startsWith("-")) {
    throw new Refusal(`${path} is not a DSH entry-list patch (expected a top-level YAML array); refusing to overwrite it`);
  }

  const block = renderYamlBlock(options);
  let text;
  let mode;
  const begin = original.indexOf(BEGIN_MARK);
  const end = original.indexOf(END_MARK);
  if (begin >= 0 && end > begin) {
    // Our own managed block: rewrite it so changing settings stays idempotent.
    text = `${original.slice(0, begin)}${block}${original.slice(end + END_MARK.length)}`;
    mode = "updated";
  } else if (/^\s*id:\s*['"]?mcp-pi-coffee['"]?\s*$/m.test(original) || /^\s*serverName:\s*['"]?pi-coffee['"]?\s*$/m.test(original)) {
    // Someone registered pi-coffee by hand; never append a duplicate row.
    return { mode: "unmanaged", path };
  } else {
    const head = original.trimEnd();
    text = `${head === "" ? "" : `${head}\n\n`}${block}\n`;
    mode = "created";
  }

  if (text === original) return { mode: "unchanged", path };
  writeAtomic(path, text);
  return { mode, path };
}

function run(options) {
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (options.print) {
    if (options.format === "yaml") {
      process.stdout.write(`${renderYamlBlock(options)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ mcpServers: { [SERVER_NAME]: buildConfig(options) } }, null, 2)}\n`);
    }
    return 0;
  }

  const path = options.config ? resolve(options.config) : defaultConfigPath(options.profile);
  const extension = path.endsWith(".json") ? ".json" : path.endsWith(".yml") || path.endsWith(".yaml") ? path.slice(path.lastIndexOf(".")) : undefined;
  if (extension === undefined) {
    throw new UsageError(`${path} must end in .yml, .yaml or .json (the DSH config dialects)`);
  }

  const result = extension === ".json" ? writeJsonConfig(path, options) : writeYamlConfig(path, options);
  if (result.mode === "unmanaged") {
    // Exit 1: the file still registers pi-coffee by hand, so the settings this
    // run was asked to write are NOT in place (typically an old port or URL that
    // makes DSH fail to connect). Reporting success made every exit-code check
    // treat a stale registration as ready.
    console.error(
      `setup-dsh: ${path} already registers ${SERVER_NAME} outside this script's managed block; nothing was written.\n` +
        "Remove or edit that row by hand (it may point at an old port or URL), then rerun with --write.",
    );
    return 1;
  }
  const verb = result.mode === "created" ? "added" : result.mode === "updated" ? "updated" : "unchanged";
  console.log(`${verb} ${SERVER_NAME} MCP entry in ${path}`);
  console.error("Restart DeepSeek Harness so the plugin tree loads the new row.");
  return 0;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`setup-dsh: ${error.message}\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  try {
    // Match the daemon: the ambient environment wins and the private env file
    // only fills gaps, so the port/token state we report is the one /mcp serves.
    loadDaemonEnv();
    warnIfTokenIsFileOnly(options);
    return run(options);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`setup-dsh: ${error.message}\n${USAGE}`);
      return 2;
    }
    if (error instanceof Refusal) {
      console.error(`setup-dsh: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = main();
