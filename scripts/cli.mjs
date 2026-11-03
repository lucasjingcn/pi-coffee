#!/usr/bin/env node
/**
 * `pi-coffee` command line: the entry point of the npm package.
 *
 *   pi-coffee install            one-command install for this checkout (build, skills, MCP
 *                                registration, provider setup, background daemon)
 *   pi-coffee setup              provider, API key, model, thinking level
 *   pi-coffee doctor             preflight: node, git, pi, credentials, data dir, clients
 *   pi-coffee register-clients   register the MCP server with every client it detects
 *   pi-coffee start              run the daemon in the foreground (Ctrl-C stops it)
 *   pi-coffee status             read the running daemon's scoreboard
 *   pi-coffee demo               credential-free end-to-end check
 *   pi-coffee version            print the package version
 *
 * Everything else is forwarded to the matching script, so `pi-coffee setup --provider
 * openai --api-key sk-...` behaves exactly like `npm run setup -- --provider openai ...`.
 * Run from an `npx` cache the package is temporary: `install` refuses and points at the
 * one-line installer instead, which keeps a stable copy under `~/.pi-coffee/app`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// npx installs into a cache directory that may be pruned: never point a daemon at it.
const ephemeral = root.split(/[\\/]/).includes("_npx");

const USAGE = `pi-coffee ${pkg.version} — MCP orchestration for isolated pi coding workers

  pi-coffee install [setup options]   build, register clients, configure a provider, start the daemon
  pi-coffee setup [options]           provider, API key, model, thinking level
  pi-coffee doctor [--background]     preflight report, including which MCP clients are registered
  pi-coffee register-clients          register the MCP server with every client it detects
  pi-coffee start                     run the daemon in the foreground
  pi-coffee status                    read the running daemon's scoreboard
  pi-coffee demo                      credential-free end-to-end check (no model calls)
  pi-coffee version                   print the version

Setup options (install and setup): --provider <name>, --api-key <key>, --model <id>,
--thinking <level>, --skip-setup, --non-interactive.

No git checkout? Run the one-line installer instead:
  curl -fsSL https://raw.githubusercontent.com/lucasjingcn/pi-coffee/main/scripts/bootstrap.sh | bash
`;

function run(argv, { env } = {}) {
  const [command, ...args] = argv;
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function script(name) {
  return [process.execPath, join(root, "scripts", name)];
}

const commands = {
  setup: () => script("setup.mjs"),
  doctor: () => script("doctor.mjs"),
  "register-clients": () => script("register-clients.mjs"),
  start: () => script("start.mjs"),
  status: () => script("status.mjs"),
  upgrade: () => script("upgrade.mjs"),
  inspect: () => script("inspect.mjs"),
  install: () =>
    process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "deploy", "windows", "install.ps1")]
      : ["bash", join(root, "install.sh")],
};

const [command, ...forwarded] = process.argv.slice(2);

if (!command || command === "--help" || command === "-h" || command === "help") {
  console.log(USAGE);
  process.exitCode = 0;
} else if (command === "version" || command === "--version" || command === "-v") {
  console.log(pkg.version);
  process.exitCode = 0;
} else if (command === "demo") {
  // The offline smoke needs a build; keep `pi-coffee demo` a single command.
  const build = run(["npm", "run", "build"]);
  process.exitCode = build === 0 ? run(script("smoke.mjs"), { env: { SMOKE_LIVE: "0" } }) : build;
} else if (commands[command]) {
  if (command === "install" && ephemeral) {
    console.error("pi-coffee: this package is running from a temporary npx cache.");
    console.error("Use the one-line installer so the daemon points at a stable directory:");
    console.error("  curl -fsSL https://raw.githubusercontent.com/lucasjingcn/pi-coffee/main/scripts/bootstrap.sh | bash");
    process.exitCode = 1;
  } else {
    if (command === "install" && !existsSync(join(root, "install.sh"))) {
      console.error("pi-coffee: install.sh is missing from this package; reinstall the package.");
      process.exitCode = 1;
    } else {
      process.exitCode = run([...commands[command](), ...forwarded]);
    }
  }
} else {
  console.error(`pi-coffee: unknown command "${command}"\n`);
  console.error(USAGE);
  process.exitCode = 2;
}
