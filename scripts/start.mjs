#!/usr/bin/env node
/** Load the same private setup file on macOS, Linux and Windows before the daemon imports. */
import { envFilePath, loadEnvFile } from "./lib/env.mjs";
import { resolvePiBin } from "./lib/pi.mjs";
import { resolveBashBin } from "./lib/bash.mjs";
import { rotateOwnedLogs, rotationOptionsFromEnv } from "./lib/logs.mjs";

loadEnvFile(envFilePath(), { override: true });
if (!process.env.PI_COFFEE_PI_BIN) process.env.PI_COFFEE_PI_BIN = resolvePiBin() || "pi";
if (!process.env.PI_COFFEE_BASH_BIN) process.env.PI_COFFEE_BASH_BIN = resolveBashBin() || "bash";

// Rotate a full daemon log before the first line of this run is written. The
// supervisor holds the log's file descriptor open across restarts, so this is a
// copytruncate that only touches logs this process itself writes to.
// Keep the format in step with src/log.ts (`[<iso>] [<tag>]`).
const logDaemon = (...args) => console.error(`[${new Date().toISOString()}] [pi-coffee]`, ...args);
try {
  const options = rotationOptionsFromEnv();
  for (const result of rotateOwnedLogs(options)) {
    if (result.rotated) logDaemon(`rotated ${result.path} (${result.size} bytes, keeping ${options.keep} archive(s))`);
  }
} catch (error) {
  logDaemon(`log rotation skipped: ${error instanceof Error ? error.message : String(error)}`);
}

await import("../dist/index.js");
