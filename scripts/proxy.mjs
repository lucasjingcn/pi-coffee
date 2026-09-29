#!/usr/bin/env node
/** Codex's stdio proxy must read the same port/token settings as the daemon. */
import { envFilePath, loadEnvFile } from "./lib/env.mjs";

loadEnvFile(envFilePath(), { override: true });
await import("../dist/stdio-proxy.js");
