#!/usr/bin/env node
/** One customer-facing installation command on macOS, Linux and Windows 10+. */
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = platform() === "win32"
  ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("../deploy/windows/install.ps1", import.meta.url))]]
  : ["bash", [fileURLToPath(new URL("../install.sh", import.meta.url))]];
const result = spawnSync(target[0], target[1], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
