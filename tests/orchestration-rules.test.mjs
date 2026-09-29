import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { PLAYBOOK, SKILL_MD, MCP_INSTRUCTIONS } from "../dist/playbook.js";

const source = readFileSync(new URL("../codex/pi-orchestrator/SKILL.md", import.meta.url), "utf8");

test("runtime and installation use one authoritative policy", () => {
  assert.equal(SKILL_MD, source);
  const bodyStart = source.indexOf("\n---\n") + "\n---\n".length;
  assert.equal(PLAYBOOK, source.slice(bodyStart).trim());
  assert.match(execFileSync(process.execPath, [new URL("../scripts/sync-playbook.mjs", import.meta.url).pathname, "--check"], { encoding: "utf8" }), /policy consistent/);
});

test("small fixes stay direct and three-task size gate stays project-specific", () => {
  assert.match(PLAYBOOK, /one-line repair[\s\S]*completed directly/);
  assert.match(PLAYBOOK, /ai-gen specifically[\s\S]*at least three independent tasks/);
  assert.match(PLAYBOOK, /not a universal requirement/);
  assert.doesNotMatch(source + MCP_INSTRUCTIONS, /DEFAULT TO DELEGATING|Do NOT write application code|worker_output_tokens should dominate/);
});

test("judgment, credentials and authorization boundaries are explicit", () => {
  assert.match(PLAYBOOK, /permissions, billing, difficult debugging,[\s\S]*with the orchestrator/);
  assert.match(PLAYBOOK, /credentials[\s\S]*continue independently authorized local implementation/);
  assert.match(PLAYBOOK, /Local integration does\s+not authorize a push/);
  assert.match(PLAYBOOK, /Model\s+changes require the user's approval/);
  assert.match(MCP_INSTRUCTIONS, /Tool availability does not authorize/);
});

test("verification covers candidate and metrics do not claim financial proof", () => {
  assert.match(PLAYBOOK, /pi_verify[\s\S]*worker commit and target commit/);
  assert.match(PLAYBOOK, /changed worker or target commit blocks integration/);
  assert.match(PLAYBOOK, /Missing costs are unknown, not zero/);
  assert.match(PLAYBOOK, /not a savings rate or quality score/);
  assert.match(PLAYBOOK, /not a security sandbox/);
});


test("runtime policy location does not depend on the daemon working directory", () => {
  const runtimeUrl = new URL("../dist/playbook.js", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `const { PLAYBOOK } = await import(${JSON.stringify(runtimeUrl)}); process.stdout.write(PLAYBOOK);`], { cwd: tmpdir(), encoding: "utf8" });
  assert.equal(output, PLAYBOOK);
});
