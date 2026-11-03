# Tool reference

Every `pi_*` tool the daemon registers over MCP, with the arguments that matter in practice. The
daemon also reports the same names and order through `GET /internal/capabilities`, and
`tests/docs-consistency.test.mjs` keeps this page in sync with `MCP_TOOL_ORDER` in
`src/mcp-server.ts`.

Reads (`pi_status`, `pi_list`, `pi_diff`, `pi_tail`, `pi_report`, `pi_metrics`, `pi_evidence`,
`pi_audit`, `pi_locks`, `pi_inbox`, `pi_board_read`) are safe at any time. Writes against an existing
worker need that worker's `control_key`, returned once by `pi_spawn`; a daemon token covers the
operator paths.

## Lifecycle

| Tool | What it does |
|---|---|
| `pi_spawn` | Creates a worktree and branch, then starts a worker. Returns a one-time `control_key` and a `scope_key`; pass the first scope key into later spawns that should coordinate. Takes a structured `spec` (`goal` and `scope` required; `purpose`, `non_goals`, `contracts`, `constraints`, `task_type` optional). Set `purpose=implementation\|review\|investigation`; omitting it is reported as `unspecified`. The scope is claimed immediately, so an overlapping workstream is rejected before any code is written. `task_type=design\|security` is blocked unless you pass `spec_override`. `acceptance_files` and `acceptance_command` write and lock coordinator-authored tests before the worker starts. `blocked_by` accepts already-integrated session ids and records the dependency edge after cycle and failure checks. |
| `pi_send` | Sends an instruction with `mode=prompt\|steer\|followup`. A third instruction to the same session is blocked by the two-strikes rule unless `override:true` with a reason. Retries keep the same model. |
| `pi_wait` | Blocks until sessions settle, a worker asks a question, or a new handoff notice arrives. Default window is 30 seconds; expiry does not stop workers. Re-poll across calls below the client/transport deadline; explicit windows up to 120 seconds need a compatible client. Returns concise snapshots; `detail=full` is available. Pass `after_notice_ids` to avoid replaying consumed notices. |
| `pi_answer` | Answers a pending worker question: `confirmed`, `value`, or `cancelled`. |
| `pi_stop` | Stops an unfinished worker early, optionally removing its worktree and branch (`remove_worktree`, `delete_branch`, `preserve_worktree`). |
| `pi_resume` | Restarts a stopped, unfinished worker on its own transcript instead of re-dispatching: keeps its worktree, branch, spec, acceptance record, control key and provider/model/thinking level, and clears the verification and review evidence of the interrupted run. Refuses sessions that already have an outcome, whose evidence was reclaimed, that have an unconfirmed shutdown, or that lost their transcript, worker agent directory, worktree or control credential. Pass `prompt` only for an explicit nudge; the contract is already in the transcript. |
| `pi_finish` | Records `success_first`, `success_second`, `taken_over`, or `abandoned`, then stops the worker. Implementation success and takeover require passing acceptance and, when code changed, an integration record. Read-only review or investigation success requires a delivered report, a clean unchanged worktree, and an orchestrator acceptance note. Archived unfinished sessions can only be marked `abandoned`. |

## Status, evidence and reporting

| Tool | What it does |
|---|---|
| `pi_status` / `pi_list` | Concise state and pending questions, including `control_required`. Pass `session_ids` to `pi_list` to see only your workstreams, including stopped history; `detail=full` adds the contract, transcript excerpt, verification and integration records. |
| `pi_tail` | Reads a worker transcript incrementally by passing the previous `lastEntryId` as `since`. |
| `pi_diff` | Committed, uncommitted and untracked changes for a worker branch. |
| `pi_verify` | Runs the fixed acceptance command or the `spec.validators` chain (ordered, per-validator timeout, required/optional, artifact globs) against the exact worker + target candidate. Records per-step exit codes, timeouts, output and commit/tree evidence, and writes a durable bundle (manifest, hashes, per-validator logs, artifacts, diff) under `<PI_COFFEE_DATA_DIR>/evidence/<session>/<verification>/`. The result carries the `evidence` reference. Failed, stale or restarted evidence cannot authorize integration. |
| `pi_evidence` | `action: list\|get\|verify` (default `list`): inspects the durable bundle written by `pi_verify`; `verify` recomputes every file sha256 and reports mismatches. Read-only. |
| `pi_review` | Records one evidence verdict per hard requirement and one approval reason per modified existing validation file, bound to the exact verification id. Incomplete or stale reviews cannot authorize integration. |
| `pi_report` | Concise outcome counts grouped by purpose, per-task notes, cost coverage, and `inconsistent_outcomes` for recorded successes without current proof. Pass your `session_ids` to avoid mixing chats; omit them only for a global audit. `detail=full` returns the complete report. Rates describe workstream outcomes, not implementation contribution. |
| `pi_metrics` | Usage and cost evidence for active and historical sessions, optionally filtered by `session_ids`. Missing costs stay unknown; partial ratios do not prove savings. |
| `pi_record_cost` | Registers orchestrator cost evidence with `id`, `amount`, `currency`, `source` (`manual\|estimate\|provider`), `reference` and covered `session_ids`; reported, manual and estimated evidence stay distinguishable. |
| `pi_audit` | `action: verify\|tail` (default `verify`): recomputes the hash-chained audit log of every coordinator action and returns `{ok, entries, files, firstBrokenSeq?, reason?}`, or returns the newest entries. The daemon also verifies the chain at startup and `GET /internal/audit/verify` answers the same question. Read-only. |

## Integration

| Tool | What it does |
|---|---|
| `pi_commit` | Stages and commits everything in a worker's worktree. |
| `pi_merge` | Merges only with current passing candidate evidence, valid scope and digests, and clean, settled worker and target checkouts. `mode=merge-queue` instead queues the PR through the GitHub merge queue (requires `pi_pr` and `PI_COFFEE_ALLOW_PUSH=1`). A changed source or target requires reverification. |
| `pi_pr` | Pushes the verified worker branch and creates or reuses a GitHub PR whose body carries the verification id, candidate SHAs and evidence manifest hash. Requires `PI_COFFEE_ALLOW_PUSH=1` and current successful `pi_verify` evidence. Idempotent per branch. |
| `pi_push` | Pushes the current branch or an explicit one to a remote. |

## Coordination

| Tool | What it does |
|---|---|
| `pi_claim` / `pi_release` / `pi_locks` | Claims paths by hand, releases them, or lists what is held. `pi_claim` and `pi_release` accept a `repo` to select another checkout's namespace; workers always use their own repository. |
| `pi_message` / `pi_inbox` | Sends durable mail to a worker (optionally injecting it into the conversation) and reads it back. Each send returns a read-back receipt (`sha256`, `readBack`) recomputed from persisted state; a mismatch fails the call instead of claiming delivery. |
| `pi_board_post` / `pi_board_read` | Posts a fact, decision or interface to a shared board and reads it back. Pass `scope_key` to use the board shared by one chat's workers; `latest=true` keeps only the newest entry per key. An unscoped global post requires every protected worker key. Posts return the same persisted-hash read-back receipt. |
| `pi_recover_control` | Recovers a lost worker control or scope key from this chat's `scope_key`; keys are never echoed back. Requires the matching scope key and does not expose other scopes or legacy credentials. |

## Operations

| Tool | What it does |
|---|---|
| `pi_drain` | `action=start\|status\|cancel`: drains the daemon before a restart. While draining, new spawns and resumes are rejected and existing workers finish. `status` reports `active` so an operator can wait for zero. Draining never stops a worker and is reversible. |
| `pi_exec` | Runs a non-login shell command in a worker worktree for diagnostics. This is not verification and does not create merge evidence. |
| `pi_gc` | Reclaims selected stopped work with `session_ids` and matching `control_keys`, including persisted history. Removes clean accepted worktrees and abandoned worktrees with no new commit; dirty, unrecorded or abandoned work with commits remains. Deletes only branches proven merged; an unscoped call requires every protected worker key. Also reclaims what a session beyond recovery still holds (`transcripts_reclaimed`, `credentials_reclaimed`, `history_compacted`). |

## Worker-side tools

Each daemon-spawned pi session also gets these tools from the worker extension:

`coord_ask`, `coord_send`, `coord_inbox`, `coord_claim`, `coord_release`, `coord_board_post`,
`coord_board_read`, `coord_status`.
