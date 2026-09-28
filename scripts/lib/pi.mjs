/**
 * Locating the `pi` executable.
 *
 * pi-coffee never imports pi's internals; it only runs the `pi` binary. This helper
 * finds that binary the same way the daemon and the shell scripts do, so the whole
 * toolchain agrees on which pi is in use.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

function versionOf(bin) {
  try {
    return execFileSync(bin, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the pi binary, in priority order:
 *   1. PI_COFFEE_PI_BIN (explicit override)
 *   2. `pi` on PATH
 *   3. ~/.pi/agent/bin/pi (the official installer's location)
 *   4. ./node_modules/.bin/pi (if pi is ever added as a local dependency)
 */
export function resolvePiBin() {
  const candidates = [process.env.PI_COFFEE_PI_BIN, "pi", join(homedir(), ".pi", "agent", "bin", "pi"), join(process.cwd(), "node_modules", ".bin", "pi")];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isAbsolute(candidate) && !existsSync(candidate)) continue;
    if (versionOf(candidate) !== undefined) return candidate;
  }
  return undefined;
}

export { versionOf as piVersion };
