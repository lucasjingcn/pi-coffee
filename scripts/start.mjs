#!/usr/bin/env node
/** Load the same private setup file on macOS, Linux and Windows before the daemon imports. */
import { envFilePath, loadEnvFile } from "./lib/env.mjs";
import { resolvePiBin } from "./lib/pi.mjs";
import { resolveBashBin } from "./lib/bash.mjs";

loadEnvFile(envFilePath(), { override: true });
if (!process.env.PI_COFFEE_PI_BIN) process.env.PI_COFFEE_PI_BIN = resolvePiBin() || "pi";
if (!process.env.PI_COFFEE_BASH_BIN) process.env.PI_COFFEE_BASH_BIN = resolveBashBin() || "bash";
await import("../dist/index.js");
