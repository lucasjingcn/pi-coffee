#!/usr/bin/env node
// The runtime and installer load the canonical file directly; no generated copy to rewrite.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PLAYBOOK, SKILL_MD } from "../dist/playbook.js";

if (process.argv.slice(2).some((arg) => arg !== "--check")) {
  throw new Error("Usage: node scripts/sync-playbook.mjs [--check] (run npm run build first)");
}
const source = await readFile(new URL("../codex/pi-orchestrator/SKILL.md", import.meta.url), "utf8");
const body = source.slice(source.indexOf("\n---\n") + "\n---\n".length).trim();
assert.equal(SKILL_MD, source, "Runtime skill must be the authoritative installation source");
assert.equal(PLAYBOOK, body, "Runtime prompt must contain the exact authoritative skill body");
const installer = await readFile(new URL("../install.sh", import.meta.url), "utf8");
assert.ok(installer.includes('cp "$DIR/codex/pi-orchestrator/SKILL.md"'), "Unix installer must copy canonical skill");
assert.ok(installer.includes('$AGENTS_SKILLS_DIR/pi-orchestrator/SKILL.md'), "Unix installer must install the shared Agent Skills copy");
const windowsInstaller = await readFile(new URL("../deploy/windows/install.ps1", import.meta.url), "utf8");
assert.ok(windowsInstaller.includes("codex/pi-orchestrator/SKILL.md"), "Windows installer must copy canonical skill");
assert.ok(windowsInstaller.includes(".agents\\skills\\pi-orchestrator"), "Windows installer must install the shared Agent Skills copy");
const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
assert.ok(dockerfile.includes("COPY codex ./codex"), "Runtime container must contain the authoritative policy");
console.log("Orchestration policy consistent: skill, runtime prompt, and installer share one source.");
