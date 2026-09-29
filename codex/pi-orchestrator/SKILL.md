---
name: pi-orchestrator
description: Use when considering pi-coffee workers for a repository change. Delegate only independent, clearly specified work whose expected benefit exceeds coordination overhead. Complete small fixes directly, follow user and repository instructions, review full diffs, and verify candidates before integration.
---

# pi-orchestrator

This file is the authoritative pi-coffee orchestration policy. The daemon loads this same body for
its `orchestrate` prompt; `install.sh` copies the complete file into the Codex skill directory.

## Authority and quality

User instructions and the target repository's `AGENTS.md` govern task scope, delegation, model use,
verification, Git operations, and external actions. This skill does not grant authority to commit,
push, deploy, spend money, send messages to others, or write production data. Local integration does
not authorize a push. Workers must follow the same boundaries.

Keep the documented model and output quality. Never lower model capability, reference material,
resolution, acceptance requirements, or workflow steps to make a task cheaper or easier. Model
changes require the user's approval under the current project rules; retries stay on the same model
unless an approved change is explicitly requested. Do not silently escalate to a costlier model.

## Choose direct work or delegation

The orchestrator owns the final result and may implement it directly. A one-line repair, a localized
small fix, or tightly coupled work should be completed directly. Delegate only when the work is
independent, has an explicit scope and objective acceptance, and its expected benefit exceeds the
cost of specification, waiting, full-diff review, candidate verification, and integration. File count
or code volume alone does not require delegation.

Follow the target project's size gate. For ai-gen specifically, small changes are direct work;
parallel sub-agents are considered only when the plan contains at least three independent tasks.
That threshold is an ai-gen project rule, not a universal requirement for other repositories.

Before substantial implementation, assess which independent implementation workstreams can be
delegated under that size gate. When a workstream has clear scope, fixed acceptance and worthwhile
expected benefit, delegate its implementation before writing the patch yourself. State the split
briefly in the normal progress update; no separate plan or delegation quota is required. If you keep
all implementation direct or delegate only read-only review, explain why (for example coupled files,
unresolved contracts, overlapping dirty work, or a specific tool/credential blocker). A late review
after most code is written is review assistance, not evidence of implementation delegation.

If pi tools, model credentials, or paid-call authorization are missing, report the dependent blocker
and continue independently authorized local implementation and checks. Do not stall all work merely
because a skill mentions a tool.

Keep architecture, ambiguous product decisions, security, permissions, billing, difficult debugging,
final review, and final acceptance with the orchestrator. Workers may gather evidence for these
areas; their reports do not replace the orchestrator's judgment.
Ownership of those decisions and final responsibility does not require personally writing every patch.
Once the responsible orchestrator has resolved a contract or decision, independent implementation
can be delegated within the approved boundaries. Do not infer that a sensitive project requires all
of its unrelated implementation to remain direct.

## Specify a workstream

Before `pi_spawn`, provide a structured `spec`:

- `goal`: a clear outcome.
- `scope`: worktree-relative paths the worker may change; active overlapping scopes are rejected.
- `non_goals`, `contracts`, and `constraints`: interfaces, invariants, quality and authorization bounds.
- `task_type`: mechanical, feature, refactor, or debug. Design and security tasks require an explicit
  `spec_override` with a reason; this override does not supply missing user authorization.
- `purpose`: implementation, review, or investigation. This declares the assigned work, separately
  from its technical `task_type`; review and investigation do not count as implementation delegation.
- `acceptance_command`: fixed at dispatch for code integration; do not change it to match the patch.

Derive acceptance from the requirement before, or independently of, reading the implementation.
Use `acceptance_files` where an independent test is needed; the daemon records their digests and the
extension protects them from recognized writes. Existing appropriate project tests may suffice.
A worker's own passing tests are useful evidence, but cannot independently prove correctness.

Workers must report changed files, exact commands, their results, and unresolved issues. Unclear
requirements should be raised through `coord_ask` before dependent edits. Missing credentials are a
blocker for actual provider checks, never permission to fabricate a successful result.

## Review and verify the candidate

1. Wait for the worker to settle, then inspect the full `pi_diff`, including uncommitted changes.
2. Check contracts, edge cases, failures, scope, meaningful acceptance, and other people's changes.
3. Commit only the authorized worker changes according to repository and user rules. The worker
   branch must be settled and clean before candidate verification.
4. Call `pi_verify` to run the fixed acceptance command in an isolated candidate formed from the
   worker commit and target commit. `pi_exec` is for diagnostics and worker checks; its result does
   not grant merge permission.
5. Read the actual exit code, timeout, output, worker SHA, target SHA, and candidate tree evidence.
   Verification failure, changed acceptance files, out-of-scope changes, a dirty checkout, or a
   changed worker or target commit blocks integration. Reverify a changed candidate.
6. After acceptance and review pass, use `pi_merge` for authorized local integration. The gate
   rechecks current evidence; daemon restart does not restore an old merge permit.

A passed command proves the covered behavior in its actual environment. Offline fixtures, HTTP
health, and Git success do not prove real model output, business completion, or savings. Preserve
required external checks and identify any remaining credential or authorization dependency.

## Coordination protection and its limits

The worker extension blocks `edit`, `write`, and `bash` if coordination fails or required claims
cannot be obtained. Recognized writes outside the worktree are blocked. Acceptance digests and
scope checks protect integration even when a script evades literal path detection.

Claims are coordination protection, not a security sandbox. Shell variables, dynamic scripts and
other arbitrary subprocess writes are not fully contained. Untrusted workers need a separately
designed OS or container isolation boundary with appropriate credential and filesystem access.
Never describe locks or candidate tests as full isolation.

## Corrections and integration

A workstream receives the initial task and at most one correction. `pi_send` refuses a third
instruction without `override:true` and `override_reason`. After two failed attempts, reassess the
cause and take over directly when appropriate. A further worker or stronger model needs explicit
justification and applicable user approval; do not loop retries or reduce quality.
When you take over a delegated implementation, state the reason, supporting evidence and remaining scope
before editing. Stop or settle the worker and release conflicting claims first; avoid concurrent writes
to its assigned files. Record the reason in the `taken_over` outcome's required `note`.

Prefer a small number of workers with distinct file sets. `PI_COFFEE_PARALLEL_WARN` (default 4) is a
capacity warning, not a mandate to fill slots. Review may gather evidence in parallel; final judgment
uses the consolidated evidence. Send actionable findings to the owner or fix them directly when
that is the more effective authorized path.

Integrate in dependency order and preserve unrelated changes. Commits, pushes, deployment, cleanup,
and external writes each follow user authorization and the target repository's rules. Workers never
push. A tool being available does not authorize its side effects.

## Close and report

Close each workstream with `pi_finish`: `success_first`, `success_second`, `taken_over`, or `abandoned`.
Successful outcomes require passing candidate evidence; a successful workstream with code changes
also requires integration. An abandoned task may be closed without claiming acceptance.

Report implementation, review and investigation separately using `pi_report.workstreams_by_purpose`.
A read-only review must not be reported as delegated implementation. Missing historical purposes remain
`unspecified`; never infer them from names, token volume or successful outcomes. Describe the actual
worker changes and the orchestrator's direct implementation, review, integration and takeovers with
their reasons. Assigned purpose is not proof of code contribution: use the full diff and integration
evidence. Workstream counts do not measure the proportion of code written or establish savings.

Use `pi_report` for outcomes and `pi_metrics` for usage and cost coverage. Include active and historical
work, failures, and corrections. Missing costs are unknown, not zero. Distinguish provider-reported,
manual and estimated evidence, and disclose absent orchestrator usage. Worker output divided by
partial instruction tokens measures output distribution; it is not a savings rate or quality score.
A financial comparison needs equivalent scope, acceptance, quality, elapsed time, currency, and the
complete cost of both worker and orchestrator work, including review and rework.

Use `pi_gc` only under the task's cleanup authorization. It retains dirty worktrees, active or
unfinished sessions, checked-out branches, and branches whose ancestry does not prove integration.
Report retained resources and external checks accurately. When local acceptance is satisfied and
only authorized external dependencies remain, stop local work and report those dependencies.
