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

test("implementation delegation is considered before edits and review is reported separately", () => {
  assert.match(PLAYBOOK, /Before substantial implementation[\s\S]*assess[\s\S]*implementation workstreams/);
  assert.match(PLAYBOOK, /final responsibility does not require personally writing every patch/);
  assert.match(PLAYBOOK, /only read-only review[\s\S]*explain why/);
  assert.match(PLAYBOOK, /take over[\s\S]*reason[\s\S]*remaining scope/);
  assert.match(PLAYBOOK, /purpose[\s\S]*implementation[\s\S]*review[\s\S]*investigation/);
  assert.match(PLAYBOOK, /read-only review must not be reported as delegated implementation/);
  assert.match(MCP_INSTRUCTIONS, /Assess implementation delegation before substantial edits/);
  assert.match(MCP_INSTRUCTIONS, /Report implementation, review and investigation separately/);
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


test("polling rules distinguish wait windows from worker failures and outer deadlines", () => {
  assert.match(PLAYBOOK, /pi_wait.*30000ms/);
  assert.match(PLAYBOOK, /120000ms[\s\S]*client/);
  assert.match(PLAYBOOK, /timedOut:true[\s\S]*does not stop workers or indicate task failure/);
  assert.match(PLAYBOOK, /one blocking wait per codemode script[\s\S]*new codemode call/);
  assert.match(PLAYBOOK, /@options[\s\S]*cannot override/);
  assert.match(PLAYBOOK, /transport timeout[\s\S]*pi_status[\s\S]*pi_list/);
  assert.match(MCP_INSTRUCTIONS, /30000ms/);
  assert.match(MCP_INSTRUCTIONS, /outer.*deadline/);
  assert.match(MCP_INSTRUCTIONS, /not worker failure/);
});

test("client-side tool timeouts are documented as outer limits, not worker failure", () => {
  assert.match(PLAYBOOK, /pi_verify` and `pi_exec`[\s\S]*tool_timeout_sec/);
  assert.match(PLAYBOOK, /client-side timeout cancels nothing/);
  for (const readme of ["../README.md", "../README.zh-CN.md"]) {
    const text = readFileSync(new URL(readme, import.meta.url), "utf8");
    assert.match(text, /tool_timeout_sec = 600/);
    assert.match(text, /"timeout": 600/);
  }
});

test("a mid-flight death is resumed on the same transcript instead of re-dispatched", () => {
  assert.match(PLAYBOOK, /resumed, not re-dispatched/);
  assert.match(PLAYBOOK, /pi_resume`\s+continues the same transcript/);
  assert.match(PLAYBOOK, /clears the interrupted run's\s+verification and review evidence/);
  assert.match(PLAYBOOK, /Re-dispatch\s+only when the session already has an outcome/);
  assert.match(PLAYBOOK, /contract is already in the transcript/);
  assert.match(MCP_INSTRUCTIONS, /pi_resume/);
  assert.match(MCP_INSTRUCTIONS, /instead of re-dispatching/);
});

test("runtime policy location does not depend on the daemon working directory", () => {
  const runtimeUrl = new URL("../dist/playbook.js", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `const { PLAYBOOK } = await import(${JSON.stringify(runtimeUrl)}); process.stdout.write(PLAYBOOK);`], { cwd: tmpdir(), encoding: "utf8" });
  assert.equal(output, PLAYBOOK);
});
