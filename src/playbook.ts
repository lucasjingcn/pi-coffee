import { readFileSync } from "node:fs";

/** One authoritative policy: install.sh copies it; runtime loads it. Keep codex/ in deployments. */
export const SKILL_MD = readFileSync(new URL("../codex/pi-orchestrator/SKILL.md", import.meta.url), "utf8");

const frontMatter = /^---\r?\nname: pi-orchestrator\r?\ndescription: [^\r\n]+\r?\n---\r?\n/;
if (!frontMatter.test(SKILL_MD)) {
  throw new Error("Invalid pi-orchestrator skill front matter; cannot load orchestration policy");
}
export const PLAYBOOK = SKILL_MD.replace(frontMatter, "").trim();

export const MCP_INSTRUCTIONS = `Follow the user's instructions and the target repository's AGENTS.md. Read the orchestrate prompt for the authoritative pi-coffee policy before delegating. Complete small fixes directly; use workers only for independent, specified work with worthwhile expected benefit. Keep quality, judgment and final review with the orchestrator. pi_exec is diagnostic; pi_verify provides candidate acceptance evidence required by pi_merge and successful pi_finish. Missing credentials block dependent model calls, not independent local work. Tool availability does not authorize commits, pushes, paid calls or external writes. Usage ratios do not prove savings.`;
