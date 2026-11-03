#!/usr/bin/env node
/** Process and shell helpers the install/setup scripts share. */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Single-quote a value for a POSIX shell command line. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Quote a value for a cmd.exe command line: percent signs expand there. */
export function cmdQuote(value) {
  return `"${String(value).replace(/%/g, "%%").replace(/"/g, '""')}"`;
}

/** Run a command and return its trimmed stdout; undefined when it fails or is missing. */
export function tryCommand(command, args, { timeoutMs = 15_000 } = {}) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs }).trim();
  } catch {
    return undefined;
  }
}

/** Run an argv vector and capture output; .cmd/.bat shims need cmd.exe on Windows. */
export function runArgv(argv) {
  const [bin, ...args] = argv;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", argv.map(cmdQuote).join(" ")], { encoding: "utf8" });
  }
  return spawnSync(bin, args, { encoding: "utf8" });
}

/** Parse JSON from disk, or undefined when the file is missing or malformed. */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
