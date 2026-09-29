import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** pi acceptance commands use Bash; Git for Windows supplies it on Windows 10+. */
export function resolveBashBin() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")].filter(Boolean);
  const knownGitBash = roots.map((root) => join(root, "Git", "bin", "bash.exe"));
  const candidates = [process.env.PI_COFFEE_BASH_BIN,
    ...(process.platform === "win32" ? [...knownGitBash, "bash"] : ["bash"])].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate !== "bash" && !existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 10_000 });
      return candidate;
    } catch { /* try next known location */ }
  }
  return undefined;
}
