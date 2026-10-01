import { readFileSync } from "node:fs";

/** One authoritative policy: install.sh copies it; runtime loads it. Keep codex/ in deployments. */
export const SKILL_MD = readFileSync(new URL("../codex/pi-orchestrator/SKILL.md", import.meta.url), "utf8");

const frontMatter = /^---\r?\nname: pi-orchestrator\r?\ndescription: [^\r\n]+\r?\n---\r?\n/;
if (!frontMatter.test(SKILL_MD)) {
  throw new Error("Invalid pi-orchestrator skill front matter; cannot load orchestration policy");
}
export const PLAYBOOK = SKILL_MD.replace(frontMatter, "").trim();

export const MCP_INSTRUCTIONS = `Follow the user's instructions and the target repository's AGENTS.md. Read the orchestrate prompt for the authoritative pi-coffee policy before delegating. Complete small fixes directly. Assess implementation delegation before substantial edits; delegate independent, specified implementation with worthwhile expected benefit under the repository size gate. Explain direct-only implementation, review-only assistance and takeovers. Keep quality, decisions and final review with the orchestrator; ownership does not require writing every patch. Set spec.purpose. Retain each pi_spawn control_key in this chat for worker writes; pass the first scope_key to subsequent spawns in this chat. Never expose keys in prompts or reports. Scope list/report/gc to this chat's sessions. Report implementation, review and investigation separately; unspecified history stays unknown. pi_exec is diagnostic; pi_verify provides candidate acceptance evidence required by pi_merge and successful pi_finish. Failed startup is not delivered implementation; after runtime recovery reassess remaining independent implementation before further substantial edits. Missing credentials block dependent model calls, not independent local work. Tool availability does not authorize commits, pushes, paid calls or external writes. Usage ratios do not prove savings.`;
