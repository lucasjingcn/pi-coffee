#!/usr/bin/env node
/**
 * Configure pi-coffee's model provider.
 *
 * pi reads provider API keys from the environment, so there is no need to run
 * `pi`'s `/login` flow. This script asks for the provider, API key, and model,
 * then writes them to a private env file that the daemon loads on startup. The
 * keys never touch the repository and are not printed back.
 *
 * Interactive:
 *   npm run setup
 *
 * Non-interactive (CI / Docker / scripts):
 *   npm run setup -- --provider deepseek --model deepseek-flash --api-key sk-...
 *   DEEPSEEK_API_KEY=sk-... PI_COFFEE_MODEL=deepseek-flash npm run setup -- --non-interactive
 */
import { createInterface } from "node:readline";
import { apiKeyVarFor, envFilePath, loadEnvFile, writeEnvFile } from "./lib/env.mjs";
import { resolvePiBin } from "./lib/pi.mjs";

function parseArgs(argv) {
  const flags = {};
  const out = { flags, nonInteractive: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--non-interactive" || arg === "-y") out.nonInteractive = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    }
  }
  return out;
}

/** Ask a question with an optional default, echoing input. */
async function ask(label, fallback) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) =>
    rl.question(`${label}${fallback ? ` [${fallback}]` : ""}: `, resolve),
  );
  rl.close();
  return answer.trim() || fallback || "";
}

/** Ask for a secret without echoing it. Falls back to a normal prompt without a TTY. */
async function askSecret(label) {
  if (!process.stdin.isTTY) return ask(label, "");
  process.stdout.write(`${label}: `);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Show only enough of a secret to recognize it. */
function mask(secret) {
  if (!secret) return "(none)";
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function printHelp() {
  console.log(`pi-coffee setup

Configure the model provider used by pi workers.

Options:
  --provider <name>       Provider id understood by pi (default: deepseek)
  --api-key <key>         Provider API key
  --api-key-env <VAR>     Override the env var name for the key
  --model <id>            Model id (default: deepseek-flash)
  --thinking <level>      off|minimal|low|medium|high|xhigh|max (default: xhigh)
  --non-interactive, -y   Never prompt; require --api-key or the provider's env var
  --help, -h              Show this help

The settings are written to $PI_COFFEE_ENV_FILE (default ~/.pi-coffee/env, mode 600).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  // Load any previous settings first so their values become the defaults.
  const file = envFilePath();
  const existing = loadEnvFile(file).values;

  const interactive = !args.nonInteractive && process.stdin.isTTY;

  let provider = String(args.flags.provider || process.env.PI_COFFEE_PROVIDER || "deepseek").toLowerCase();
  let model = String(args.flags.model || process.env.PI_COFFEE_MODEL || "deepseek-flash");
  let thinking = String(args.flags.thinking || process.env.PI_COFFEE_THINKING || "xhigh");
  let keyVar = String(args.flags["api-key-env"] || apiKeyVarFor(provider));
  let apiKey = String(args.flags["api-key"] || process.env[keyVar] || "");

  if (interactive) {
    console.log("pi-coffee setup - configure a provider without running pi's /login.\n");
    provider = (await ask("Provider (deepseek, openai, anthropic, ...)", provider)).toLowerCase();
    keyVar = String(args.flags["api-key-env"] || apiKeyVarFor(provider));
    apiKey = String(process.env[keyVar] || apiKey);

    const keyLabel = apiKey
      ? `API key for ${provider} (${keyVar}) [keep ${mask(apiKey)}]`
      : `API key for ${provider} (${keyVar})`;
    const entered = await askSecret(keyLabel);
    if (entered) apiKey = entered;

    model = await ask("Model id", model);
    thinking = await ask("Thinking level (off|minimal|low|medium|high|xhigh|max)", thinking);
  }

  if (!apiKey) {
    console.error(`\nNo API key provided. Pass --api-key, set ${keyVar}, or run without --non-interactive.`);
    process.exit(2);
  }

  const entries = { ...existing };
  entries[keyVar] = apiKey;
  entries.PI_COFFEE_PROVIDER = provider;
  entries.PI_COFFEE_MODEL = model;
  entries.PI_COFFEE_THINKING = thinking;

  // Pin pi's location when it is not on PATH, so the daemon finds the same binary.
  const piBin = resolvePiBin();
  if (piBin && piBin !== "pi") entries.PI_COFFEE_PI_BIN = piBin;

  const written = writeEnvFile(entries, file);

  console.log(`\nSaved to ${written} (mode 600).`);
  console.log(`  provider:  ${provider}`);
  console.log(`  model:     ${model}`);
  console.log(`  thinking:  ${thinking}`);
  console.log(`  API key:   ${keyVar} = ${mask(apiKey)}`);
  if (entries.PI_COFFEE_PI_BIN) console.log(`  pi binary: ${entries.PI_COFFEE_PI_BIN}`);
  console.log("\nRestart the daemon (`./run.sh`) to pick it up.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
