#!/usr/bin/env node
/** Codex's stdio proxy must read the same port/token settings as the daemon. */
import { loadDaemonEnv } from "./lib/env.mjs";

loadDaemonEnv();
await import("../dist/stdio-proxy.js");
