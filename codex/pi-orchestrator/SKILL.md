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

The daemon is shared by all Codex chats, and session IDs are global. It cannot trust a Codex chat ID.
Check the daemon's live `/mcp` `tools/list` before assuming this boundary is active: `pi_spawn`
must accept `scope_key` and `pi_send` must accept `control_key`. A running Codex chat may still
display cached, older tool declarations after a daemon restart; that alone does not prove the daemon
is old. A scoped, read-only `pi_list(session_ids=...)` call can also confirm that new arguments reach
the daemon. If the live daemon lacks the new fields, defer protected writes until it is safely
upgraded. If the daemon has them but the client cannot forward them, refresh the MCP connection.
For each new `pi_spawn`, retain its one-time `control_key` in this chat and pass it to every worker
write (`pi_send`, `pi_answer`, `pi_commit`, `pi_verify`, `pi_merge`, `pi_exec`, `pi_finish`, `pi_stop`,
etc.). Pass the first spawn's `scope_key` to later `pi_spawn` calls in this chat so those workers can
coordinate; use it for their shared board. Never put either key in a worker prompt, report, commit,
or user-facing output. Keep your own IDs and use scoped `pi_wait`, `pi_list`, `pi_report`, and
`pi_metrics`. `pi_gc` should receive only your `session_ids` and matching `control_keys`; global
writes require all affected keys. Legacy workers are marked `control_required:false` and remain
unprotected by this new boundary. Daemon restart still affects all chats; a single idle snapshot
is not a safe restart lease because another chat can spawn.

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

For a startup or configuration failure, report the worker ID, failure category and whether the
initial task reached the worker. A failed launch is not delivered implementation. Diagnose transient
runtime failures separately from missing authorization; never treat an old startup failure as a
permanent exemption from delegation. After runtime recovery, reassess the remaining independent
implementation slices before further substantial edits and dispatch worthwhile ones under the
existing quality, size and authorization gates. Close or preserve failed workstreams explicitly;
do not replace this step with an unrelated read-only investigation or claim successful delivery.

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
- `requirements`: preserve the user's hard requirements as coordinator-authored `{id, text}` items
  with unique IDs. Include every hard requirement for implementation tasks; this daemon cannot
  independently establish that the text is a verbatim user quote.
- `validation_paths`: additional project validation definitions (for example `package.json`, CI
  scripts or nonstandard test directories) whose existing changes need explicit review. Conventional
  test directories, test/spec files and common test-runner configurations are detected automatically.
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
6. If requirements are declared or `pi_verify.existingValidationChanges` is nonempty, call `pi_review`
   with that exact verification `id`. Supply one `{id, met:true, evidence}` per requirement and one
   `{path, approved:true, reason}` per changed existing validation file. Read the original and changed
   tests; approve only when their coverage remains valid or the user explicitly changed the behavior.
   Missing, duplicate, unknown or negative verdicts block review. Even append-only existing test edits
   require review; newly added tests alone do not. Protected coordinator acceptance files remain
   immutable. Review completeness is a structural gate, not automatic proof of semantic correctness.
   Reverification, source/target/contract changes, new instructions and daemon restart invalidate
   the usable review. Read-only workstream acceptance still uses its unchanged-report path below.
7. After acceptance and review pass, use `pi_merge` for authorized local integration. The gate
   rechecks current evidence; daemon restart does not restore an old merge permit.

For a read-only `review` or `investigation`, inspect the worker report and unchanged worktree,
then close with `pi_finish(success_first|success_second, note=...)` when you accept the findings.
The daemon records separate read-only acceptance evidence and rejects changes in that worktree.
Do not mark delivered read-only work `abandoned` merely because it has no code candidate. An
implementation or takeover still requires the normal `pi_verify` and integration gates.

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

Protected workers do not receive global `*` broadcasts, including persisted legacy broadcasts.
Coordinate by explicitly addressing workers in the same scope; retain legacy broadcast behavior
only for legacy unprotected sessions.

## Worker failure and handoff

While workers run, keep scoped `pi_wait` polling active with repeated short waits. The daemon
watchdog does not depend on model output: a new `handoff` notice wakes the wait even before the
worker settles. Consume notices from `pi_wait`, `pi_status` and `pi_list`; pass consumed notice IDs
as `after_notice_ids` on later waits to avoid replaying a warning. The current stateless MCP transport
cannot push into a chat that has stopped executing; these notices persist for the owner's return.

`pi_wait` defaults to 30000ms (30 seconds). Keep the window below the outer script, client and
transport deadlines with headroom for other calls and response delivery. Explicit windows up to
120000ms remain available when the client and every outer layer support them with headroom.
For a 60-second outer deadline, use 30000ms and one blocking wait per codemode script, then
re-poll in a new codemode call. Do not loop sequential waits inside one script: the deadline covers
the entire script. `@options timeout_ms` cannot override an external harness or transport deadline;
do not assume every codemode environment has a fixed 60-second cap.

`timedOut:true` means the wait window expired; it does not stop workers or indicate task failure.
Read the returned statuses and handoff notices, then continue scoped waiting for active workers.
Do not stop, re-spawn or take over solely because a wait window expired. After a transport timeout,
use scoped `pi_status` or `pi_list` snapshots to check actual state before taking further action;
reconnect if needed. A transport error is not evidence that a worker stopped or a write failed.

A `provider_wait` notice means no observable generation progress, not a proven provider-wide outage.
The default warning is 60 seconds; the default terminal silence deadline is 10 minutes. Model
text/thinking/tool-call deltas count as progress. Local tool execution and pending user questions
are excluded. A settled provider error, exhausted retries, unexpected worker exit, or silence
deadline triggers safe shutdown and a takeover notice. Never treat HTTP success or SSE keep-alive
as generated output, lower the configured quality, switch models, or launch extra paid retries.

Take over only after `handoff.safeToTakeOver` and `handoff.locksReleased` are both true. Review the
preserved worktree, report (`pi_status(detail=full).lastText`) and task contract before continuing
within existing user authorization. On restart the daemon stops only provably owned survivor process groups; missing or mismatched identity
retains scope/acceptance reservations. Windows crash-orphan recovery requires local administration.
A `shutdown_failed` notice retains locks and blocks worker
writes; resolve actual process termination first. Notifications alone do not establish acceptance.

An `awaiting_acceptance` notice requires owner review: inspect an unchanged investigation/review
and finish it with the normal accepted-report path; verify/review/integrate implementation before
finishing successfully. Do not leave a delivered worker idle indefinitely. After 30 minutes idle
without a pending question the daemon stops it, releases locks only after confirmed exit, preserves
files/branch/report, and reports `owner_timeout`; it does not invent a success or takeover outcome.
The timer settings are configurable; changing a deadline never changes the documented output
quality floor or supplies permission for retries, cleanup or integration.

New spawns persist control credentials in a local directory with owner-only permissions, separate
from status/history. If the worker key was lost but this chat's `scope_key` remains, explicitly use
`pi_recover_control(session_id, scope_key)`; another scope cannot recover it. If both were lost,
use the authorized local `scripts/worker-control.mjs` CLI. Its default output is metadata only;
`--stop` safely closes that worker with files and branch preserved. Do not print credentials into
user-facing output. Existing pre-upgrade sessions without a credential record are not recoverable
through this mechanism, and there is no keyless MCP control bypass.

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
Check a long-running worker's reviewable diff and acceptance progress, not just its turn count.
If it keeps consuming turns without concrete progress, reassess the scope or contract and stop the
workstream when appropriate; do not let a stalled worker run indefinitely.

Integrate in dependency order and preserve unrelated changes. Commits, pushes, deployment, cleanup,
and external writes each follow user authorization and the target repository's rules. Workers never
push. A tool being available does not authorize its side effects.

## Close and report

Use `pi_wait` for a group of workers and `pi_list` for a concise snapshot; reserve
`pi_status(detail=full)` for a specific session whose contract or proof needs inspection.
Avoid repeated per-worker status calls and repeated full reports while workers are running.

Close each workstream with `pi_finish`: `success_first`, `success_second`, `taken_over`, or `abandoned`.
It stops the worker and preserves its result and evidence; a finished session cannot receive more
instructions or writes. A stopped historical session without live acceptance evidence can only be
closed as `abandoned`, not retroactively called successful or taken over.
Successful outcomes require passing candidate evidence; a successful workstream with code changes
also requires integration. An abandoned task may be closed without claiming acceptance.

Report implementation, review and investigation separately using `pi_report(session_ids=...)` and
its `workstreams_by_purpose` field. Omit `session_ids` only for an intentional global audit.
A read-only review must not be reported as delegated implementation. Missing historical purposes remain
`unspecified`; never infer them from names, token volume or successful outcomes. Describe the actual
worker changes and the orchestrator's direct implementation, review, integration and takeovers with
their reasons. Assigned purpose is not proof of code contribution: use the full diff and integration
evidence. Workstream counts do not measure the proportion of code written or establish savings.

Use the concise `pi_report` for outcomes and `pi_metrics` for detailed usage and cost coverage.
Inspect `inconsistent_outcomes` before citing success counts: a recorded outcome without current proof
is not current acceptance evidence. Include active and historical work, failures, and corrections.
Missing costs are unknown, not zero. Distinguish provider-reported,
manual and estimated evidence, and disclose absent orchestrator usage. Worker output divided by
partial instruction tokens measures output distribution; it is not a savings rate or quality score.
A financial comparison needs equivalent scope, acceptance, quality, elapsed time, currency, and the
complete cost of both worker and orchestrator work, including review and rework.

Use scoped `pi_gc(session_ids=..., control_keys=...)` only under the task's cleanup authorization.
It reclaims clean accepted work and empty abandoned work from both live and historical sessions.
It retains dirty worktrees, active or unfinished sessions, abandoned work with new commits,
checked-out branches, and branches whose ancestry does not prove integration.
Report retained resources and external checks accurately. When local acceptance is satisfied and
only authorized external dependencies remain, stop local work and report those dependencies.
