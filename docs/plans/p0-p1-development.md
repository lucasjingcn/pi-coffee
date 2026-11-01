# P0/P1 Development Plan — evidence, isolation, interop

Status: active · Started 2026-11-01 · Branch `p0-p1-hardening` (worktree, base `7f70ece`)
Companion document: [p0-p1-implementation.md](p0-p1-implementation.md) (milestones, acceptance, merge procedure)

This document is the design source of truth for the P0/P1 hardening work. It describes *what* is
built, the interfaces it introduces, and the invariants each change must preserve. The companion
implementation document is the source of truth for *order*, acceptance commands, and the merge gate.
When the two disagree, this document wins for semantics and the implementation document wins for
sequencing.

## 1. Context

pi-coffee is an MCP server that hands independent implementation work to pi workers in isolated git
worktrees, gates integration on reviewable acceptance evidence, and keeps a local-first operator
surface (`/dashboard`, `/metrics`, drain, crash recovery). Its current differentiators are:
MCP-native control, an acceptance → review → merge evidence chain, scope + file claims, control
keys/scopes, durable handoff notices, and cost accounting.

Known gaps (from the 2026-11-01 landscape review, `docs/plans/` discussion):

1. Verification candidates are temporary. `IntegrationGate.verify()` removes the candidate worktree
   in `finally`; only a stdout/stderr tail survives in `SessionMeta.verification` (`src/integration.ts`).
   There is no durable, inspectable evidence bundle to archive, attach to a PR, or audit later.
2. Verification is one `acceptance_command`. There is no first-class validator chain (lint,
   typecheck, unit, integration, security scan) with per-validator timeouts, artifacts, and
   required/optional semantics.
3. Workers run on the host. Docker is available only as a daemon packaging option; there is no
   per-worker sandbox and no credential scoping for worker execution.
4. Coordination writes (mailbox, board) are plain state mutations. There is no read-back receipt, no
   secret filter, and no tamper-evident audit log.
5. Only pi can be a worker. There is no runner abstraction and no ACP support, so Claude Code,
   Codex, Gemini, OpenCode and other ACP agents cannot be driven.
6. Integration is local-only. There is no PR creation and no merge-queue mode.
7. The dashboard is read-only. There is no approve/request-changes/merge action.
8. Spawns are flat. There is no task DAG (`blocked_by`), so dependent slices must be dispatched by
   hand after an earlier slice integrates.
9. The MCP surface predates the 2026-07-28 revision (no stateless transport, `server/discover`,
   `subscriptions/listen`, tasks extension, MRTR). The pinned SDK 1.32.2 (npm latest as of
   2026-11-01) does not implement that revision yet, so this item is scoped to surface hardening and
   a documented upgrade path.

### Current module map

| Module | Responsibility | Changes in this plan |
| --- | --- | --- |
| `src/index.ts` | HTTP routes, `/internal/*`, MCP mount | evidence/audit/capability routes |
| `src/mcp-server.ts` | MCP tool registration (30 tools) | new tools, annotations, schemas |
| `src/manager.ts` | Coordinator: spawn/stop/verify/merge/finish/wait/GC | evidence + validators + sandbox + DAG |
| `src/integration.ts` | `IntegrationGate.verify/assertCurrent`, verification records | evidence capture, validator chain |
| `src/acceptance.ts` | acceptance file paths and writes | validator artifact paths |
| `src/state-store.ts` | persisted snapshot validation/migration | schema v2 fields |
| `src/config.ts` | env parsing and defaults | new config keys |
| `src/rpc-client.ts` | pi RPC over stdio | runner abstraction, sandboxed spawn |
| `src/worker-agent-dir.ts` | worker agent dir snapshot | sandbox env/mount policy |
| `src/mailbox.ts` | mailbox + board | receipts, secret filter, audit hooks |
| `src/dashboard.ts` | read-only console | opt-in write actions |
| `src/worktree.ts` | git plumbing | evidence diff capture helpers |
| `src/worker-process.ts` | process ownership/stop | container identity support |
| `extensions/pi-coordinator.ts` | worker-side guard | unchanged (contract stable) |

### Hard constraints

- Default behavior must not change for existing users: every new feature is opt-in (config or spec),
  and old `state.json` / old clients keep working after a one-way, additive migration.
- All offline tests must keep passing with fake binaries only; no network or model calls in
  `npm test`. Docker/gh/ACP integration is exercised through deterministic fake executables and
  optional live tests that skip when the tool is absent.
- The worker extension contract (`coord_*` tools, `PI_COORD_SESSION_ID`, guards) must not change
  incompatibly; new fields are additive.
- Evidence must never contain unredacted credentials. Secret detection runs before persistence.

## 2. P0 — trust foundation

### 2.1 P0-1 Durable evidence bundles

**Problem.** The candidate worktree is deleted after `pi_verify`. The orchestrator cannot inspect
what actually ran, attach proof to a PR, or re-audit a merge.

**Design.**

```
${PI_COFFEE_DATA_DIR}/evidence/<sessionId>/<verificationId>/
  manifest.json          # schema below; written last, atomically
  command.txt            # exact acceptance/validator commands, one per line
  stdout.log             # combined stdout (+ per-validator segments)
  stderr.log
  diff.patch             # `git diff <baseRef>..<workerSha>` from the worker branch
  changed-files.json     # [{path, status, additions, deletions, scopeOk}]
  validators/<validatorId>/stdout.log
  validators/<validatorId>/stderr.log
  validators/<validatorId>/exit.json
  artifacts/<validatorId>/...   # copied from `ValidatorSpec.artifacts` globs
  sandbox.json           # only when the run was sandboxed
```

`manifest.json` (schema version `1`):

```ts
interface EvidenceManifest {
  version: 1;
  sessionId: string;
  verificationId: string;
  createdAt: number;
  closedAt: number;
  repo: string;                 // absolute path, not portable by design; hashes are authoritative
  workerSha: string;
  targetSha: string;
  targetBranch: string;
  candidateTree: string;
  baseRef: string;
  command: string;              // aggregate command line for backward compatibility
  validators: { id: string; required: boolean; command: string; code: number | null; timedOut: boolean; passed: boolean }[];
  passed: boolean;
  failure?: string;
  sandbox?: SandboxRecord;      // see P0-3
  files: { path: string; bytes: number; sha256: string }[]; // every file except manifest.json
  truncated: string[];          // files hit a size cap; content is a tail
  redactions: number;           // number of secret-like spans removed before persistence
}
```

**Write protocol.** Build in `evidence/<id>/.tmp-<rand>/`, `fsync` each file, write the manifest last,
`fsync` the directory, then `rename` to the final name. A crash before `rename` leaves only `.tmp-*`
directories; the sweeper removes them after one hour. A crash after `rename` yields a complete bundle.

**Size caps.** Per-file 8 MiB (`PI_COFFEE_EVIDENCE_MAX_FILE_MB`), total bundle 64 MiB
(`PI_COFFEE_EVIDENCE_MAX_MB`); exceeding a cap keeps the tail and records the path in
`truncated`. Truncation is visible in the tool result, never silent.

**Redaction.** Before a log is written, run the secret filter (P0-4). Redactions are counted in the
manifest. If `PI_COFFEE_SECRET_POLICY=reject`, verification fails instead of persisting a secret.

**Retention.** `PI_COFFEE_EVIDENCE_TTL_DAYS` (default 30) and `PI_COFFEE_EVIDENCE_KEEP_PER_SESSION`
(default 10, newest kept). The existing sweeper and `pi_gc` delete expired bundles; `pi_gc` reports
`evidence_removed`. Bundles referenced by an elected integration record are retained until the
session is GC-eligible, then follow the TTL.

**Integration record.** `SessionMeta.verification` gains
`evidence: { dir: string; manifestSha256: string; files: number; bytes: number } | null`.
`pi_merge` re-reads `manifest.json`, verifies its sha256 against the record and verifies that
`candidateTree`, `workerSha`, `targetSha` match the current proof. Merge fails closed if the bundle is
missing or mutated.

**MCP surface.**
- `pi_verify` result gains `evidence` (path, manifestSha256, file count, bytes, truncated files).
- New tool `pi_evidence` with `action: list|get|verify`, `session_id`, optional `verification_id`:
  - `list` returns bundles for a session;
  - `get` returns the manifest and a bounded file listing;
  - `verify` recomputes sha256 for every file and reports mismatches.
- Read-only annotations (`readOnlyHint: true`) for `pi_evidence`.

**Files.** `src/evidence.ts` (new), `src/integration.ts`, `src/manager.ts` (`gc`/sweeper),
`src/mcp-server.ts`, `src/config.ts`, `src/state-store.ts`, `tests/evidence.test.mjs` (new).

**Invariants.**
- Evidence is a pure function of the verification run; re-running verification creates a new bundle
  and invalidates the old one.
- A bundle is never written outside `PI_COFFEE_DATA_DIR/evidence` (path traversal rejected).
- Symlinked candidates/artifacts are not followed outside the candidate root.
- Merge never succeeds without a matching manifest.

### 2.2 P0-2 Validator chain

**Problem.** One command must encode lint + typecheck + tests; failures are opaque, artifacts are
lost, and per-step timeouts are impossible.

**Design.**

```ts
interface ValidatorSpec {
  id: string;                    // unique, [a-z0-9][a-z0-9_-]*, max 64
  command: string;               // run with the configured bash
  required?: boolean;            // default true
  timeoutMs?: number;            // default PI_COFFEE_VALIDATOR_TIMEOUT_MS
  artifacts?: string[];          // relative globs (candidate root), bounded
  env?: Record<string, string>;  // explicit allowlist, merged after the runner env
}
```

- `DelegationSpec.validators?: ValidatorSpec[]` (max 16).
- Backward compatibility: when `validators` is absent, `acceptance_command` becomes the single
  required validator `id: "acceptance"`. When `validators` is present, `acceptance_command` must not
  also be supplied (spawn validation error) unless it duplicates a validator id, which is rejected as
  ambiguous.
- Execution: sequential, in the candidate, in declaration order. All validators run even after a
  failure (to produce complete evidence); `passed = every required validator passed`.
- Each validator's timeout is capped by `PI_COFFEE_VERIFY_TIMEOUT_MS` overall budget; exceeding the
  budget fails the remaining validators without running them.
- Clean-tree check and acceptance-file hash check run after all validators, unchanged.
- Result shape: `SessionMeta.verification.validators: ValidatorResult[]`; `verification.result`
  remains the aggregate `{code, stdout, stderr, timedOut}` derived as: first required failure wins,
  otherwise the last validator; this keeps existing `pi_review`/`assertCurrent`/report code working.
- Review obligations unchanged: any nonempty `existingValidationChanges` still requires `pi_review`.

**Files.** `src/validators.ts` (new), `src/integration.ts`, `src/manager.ts` (spawn validation),
`src/types.ts` (`DelegationSpec.validators`), `src/mcp-server.ts` (spawn input schema), `tests/validators.test.mjs` (new).

**Invariants.**
- Validator ids unique and stable across a verification (evidence folders keyed by id).
- A validator may not escape the candidate: commands run with `cwd` = candidate; `artifacts` glob
  results must resolve inside the candidate (symlinks rejected).
- Per-validator failure never erases another validator's evidence.

### 2.3 P0-3 Sandbox backends

**Problem.** A worker (and its acceptance command) runs with the daemon user's full filesystem and
credentials. The README already calls coordination "not an OS sandbox".

**Design.** Add a sandbox abstraction with two phases, both required for P0 completion.

```ts
type SandboxKind = "worktree" | "docker";
interface SandboxRecord {
  kind: SandboxKind;
  image?: string;
  imageDigest?: string;
  network?: "bridge" | "none";
  mounts?: { source: string; target: string; mode: "rw" | "ro" }[];
}
```

Config:

| Key | Default | Meaning |
| --- | --- | --- |
| `PI_COFFEE_SANDBOX` | `worktree` | Default backend when a spec does not ask for one. |
| `PI_COFFEE_SANDBOX_IMAGE` | *(empty)* | Required for `docker`; e.g. `pi-coffee-sandbox:0.3`. |
| `PI_COFFEE_SANDBOX_NETWORK` | `bridge` | `none` disables worker network (model calls must go through a proxy later). |
| `PI_COFFEE_SANDBOX_ENV_ALLOW` | provider keys | Comma-separated env var names forwarded into the container; everything else is dropped. |
| `PI_COFFEE_DOCKER_BIN` | `docker` | Docker CLI path (fake binary in tests). |

`spec.isolation?: "worktree" | "docker"` requests a backend. The daemon caps it: if
`PI_COFFEE_SANDBOX=worktree`, a `docker` request is rejected with an actionable error (never silently
downgraded). Every session records `sandbox` in `SessionMeta`; verification copies it into the
evidence manifest.

**Phase A — sandboxed verification.** `IntegrationGate.verify` runs validators through the sandbox:

```
docker run --rm --name pi-coffee-verify-<rand> --network <net> \
  -v <candidate>:/workspace -w /workspace \
  [-e KEY=VALUE for allowlisted keys] \
  <image> bash -lc '<validator command>'
```

Candidate path is mounted read-write (validators may write build outputs under `/workspace`, which
is discarded with the candidate). Artifacts are copied out before the worktree is removed. Timeouts
run through `runCommand` as today; a killed container is removed with `docker rm -f`.

**Phase B — sandboxed worker.** `PiRpcClient` gains a spawn-command factory:

```
docker run --rm -i --name pi-coffee-<sessionId> --network <net> \
  -v <worktree>:/workspace -w /workspace \
  -v <workerAgentDir>:/agent \
  -e PI_COORD_SESSION_ID=... -e <allowlisted provider env> \
  <image> pi --mode rpc ...
```

- `workerAgentDir` is mounted at `/agent`; the RPC client uses `--agent-dir /agent` (already passed
  via env/args by the daemon's worker CLI invocation; the exact flag is confirmed against the pinned
  pi version during implementation).
- Process identity (`worker-process.ts`) records the container name and the docker CLI pid; stop uses
  `docker rm -f <name>` first, then verifies the container is gone. Daemon restart recovery treats a
  running container as an owned survivor and stops it exactly like a process group.
- Allowed env defaults: the configured provider key variable(s) and `PI_*` values needed by pi; never
  `HOME`, `SSH_*`, `GH_TOKEN`, `AWS_*`. The allowlist is enforced by construction (build the env
  object, do not filter afterwards).
- Network defaults to `bridge` because the worker must reach the model provider; strict isolation
  requires the future credential proxy (`none` today means "no model access" and is documented).

**Files.** `src/sandbox.ts` (new), `src/rpc-client.ts`, `src/worker-process.ts`, `src/manager.ts`
(spawn/stop/recovery), `src/integration.ts`, `src/config.ts`, `src/state-store.ts`,
`tests/sandbox.test.mjs` (new; fake docker shim), `tests/docker-live.test.mjs` (optional, skipped
without docker).

**Invariants.**
- No host path other than the worktree, the worker agent dir, and the candidate is mounted.
- Container name is derived from the session id and is idempotent; a stale container from a crash is
  detected and removed before spawn.
- Transcripts and acceptance files still live inside the worktree/agent dir, so evidence capture and
  resume work unchanged.
- Removing `docker` availability fails closed with a clear error, never falls back to host execution
  when the spec asked for docker.

### 2.4 P0-4 Coordination receipts, secret filter, audit log

**Design.**

*Read-back receipts.* `Mailbox.post` and `Board.post` write, then re-read and compare a canonical
JSON encoding; the persisted message gains `sha256` (of `{from,to,kind,text,ts}`). `pi_send` returns
`{delivered: true, sha256, readBack: true}`. A mismatch reports `coordination write was not read back`
and fails the call without leaving a half-written entry (atomic temp + rename on the state store).

*Secret filter.* `src/secrets.ts`: patterns for `sk-[A-Za-z0-9_-]{16,}`, `AKIA[0-9A-Z]{16}`,
`ghp_/gho_/ghu_/ghs_/ghr_[A-Za-z0-9]{20,}`, `xox[baprs]-...`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`,
JWT `eyJ...`, and high-entropy assignments to names matching `(_KEY|TOKEN|SECRET|PASSWORD)$`.
Applied to mailbox text, board values, `outcomeNote`, evidence logs, and handoff reasons.
`PI_COFFEE_SECRET_POLICY=reject|redact` (default `reject`). Rejections name the pattern class, never
the matched value.

*Hash-chained audit log.* Append-only JSONL at `${PI_COFFEE_DATA_DIR}/audit/audit.jsonl`:

```ts
interface AuditEntry {
  seq: number;
  ts: number;
  actor: string;            // orchestrator | worker:<id> | dashboard | system
  action: string;           // spawn, send, answer, commit, verify, review, merge, finish, gc, stop, claim, release, board, resume, drain, sandbox
  target: string;           // session id, lock path, branch
  detail?: Record<string, unknown>; // already redacted
  payloadSha256: string;    // canonical hash of detail + action + target + actor
  prevHash: string;
  hash: string;             // sha256(prevHash + payloadSha256 + seq + ts)
}
```

Rotation: when a file exceeds `PI_COFFEE_AUDIT_MAX_MB` (default 32), close it and start
`audit-<n>.jsonl`; a `.head` sidecar holds the latest seq/hash so truncation is detectable.
`pi_audit` (`action: verify|tail`) and `GET /internal/audit/verify` recompute the chain and report
`{ok, entries, firstBrokenSeq?}`. Audit writes are best-effort for the tool call but always attempted
before a successful response; a failed append fails the guarded action (fail closed).

**Files.** `src/secrets.ts`, `src/audit.ts` (new), `src/mailbox.ts`, `src/manager.ts` (hook actions),
`src/state-store.ts` (mailbox sha256 optional), `src/mcp-server.ts`, `src/index.ts`, tests
`tests/secrets.test.mjs`, `tests/audit.test.mjs`, `tests/receipts.test.mjs`.

## 3. P1 — interop and workflow

### 3.1 P1-1 Runner abstraction and ACP workers

**Design.**

```ts
interface RunnerSpec {
  kind: "pi" | "acp";
  command?: string[];            // ACP agent command, e.g. ["claude-code-acp"]
  env?: Record<string, string>;  // explicit allowlist
}
```

- Default `pi` (today's behavior). `PI_COFFEE_RUNNER=pi|acp`, `PI_COFFEE_ACP_COMMAND` (JSON array or
  space-split), `spec.runner` overrides per spawn.
- `src/runner.ts` defines `RunnerTransport`: `start(opts)`, `prompt(text)`, `events()`, `stop()`,
  `interrupt?()`, `setModel?()`, `state?()`, `stats?()`. `PiRpcClient` becomes the `pi` implementation
  behind this interface; `src/runner-acp.ts` implements ACP v1 over stdio JSON-RPC:
  `initialize` → `session/new` → `session/prompt`, consuming `session/update`
  (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`), mapping
  permission requests to existing `UiRequest`/`UiResponse`, and `session/cancel` on stop.
- Session metadata: `provider`/`model` stay empty for ACP unless reported; `thinking` unsupported
  (recorded as `null`, documented); transcript capture keeps the ACP JSON-RPC frames under
  `sessions/<id>/acp.jsonl` for `pi_tail`/evidence.
- Worker agent dir/extensions do not apply to ACP; file claims still enforced daemon-side (the
  extension is pi-only, so claims remain advisory for ACP workers, documented as a limitation).
- Tests: `tests/fake-acp-agent.mjs` deterministic agent (newline-delimited JSON-RPC): initialize,
  session/new, prompt → emits chunks + a tool call, cancel. `tests/runner-acp.test.mjs` drives a full
  spawn → prompt → settle → finish cycle offline.

**Non-goal:** ACP v2 draft, remote ACP transport, authentication flows beyond the agent's own.

### 3.2 P1-2 PR creation and merge-queue integration

**Design.**

- Config: `PI_COFFEE_GH_BIN` (default `gh`), `PI_COFFEE_GH_REMOTE` (default `origin`),
  `PI_COFFEE_PR_LABEL` (default `pi-coffee`), `PI_COFFEE_GH_TOKEN` (optional; falls back to the
  environment `GH_TOKEN` only if `PI_COFFEE_GH_ALLOW_ENV_TOKEN=1`).
- Tool `pi_pr`: requires a current verification and a clean worker branch. Sequence: `git push`
  (authorized by calling the tool) → `gh pr list --head <branch> --json number` (idempotent) → create
  with title `goal` (truncated) and body containing contract summary, verification id, validator
  results, evidence `manifestSha256`, and the diff stat. Returns `{pr, url, created}`. Never pushes
  tags. Authorization: user must have approved push/PR; the tool refuses when `PI_COFFEE_ALLOW_PUSH=0`.
- `pi_merge` gains `mode: "local" | "merge-queue"` (default local = today). Merge-queue mode: requires
  a PR from `pi_pr`; runs `gh pr merge <number> --squash --auto` (or `--merge` per config), then
  records `integration = { via: "merge-queue", pr, mergedSha: null }` and a follow-up verification of
  the merged commit is deferred to `pi_verify --at-main` (new optional mode) before the outcome can be
  success.
- Offline tests use a fake `gh` executable recording argv and printing JSON; live tests skip without
  `gh` + auth.

### 3.3 P1-3 Dashboard actions (opt-in)

**Design.** `PI_COFFEE_DASHBOARD_ACTIONS=0|1` (default 0; enabling requires `PI_COFFEE_TOKEN`).
New endpoints under `/dashboard/api`:

| Method/Path | Action | Preconditions |
| --- | --- | --- |
| `POST /api/sessions/:id/finish` | record a read-only review acceptance with note | read-only purpose, settled, unchanged worktree |
| `POST /api/sessions/:id/send` | send a message to a worker | worker running, two-strikes respected |
| `POST /api/sessions/:id/merge` | same gate as `pi_merge` | current verify + review evidence |
| `POST /api/sessions/:id/stop` | stop with preserved worktree | not already stopped |

Guards: `Authorization: Bearer <PI_COFFEE_TOKEN>` + `X-Pi-Coffee-Action: 1` custom header
(CSRF), `Content-Type: application/json`, same-origin check for `Origin`, an `X-Pi-Coffee-Confirm:
<sessionId>` header for destructive actions, per-action audit entries. UI: buttons with typed
confirmation, evidence viewer (manifest + truncated logs), diff browser, inline request-changes
textarea. Read-only dashboard behavior unchanged when disabled.

### 3.4 P1-4 Task DAG (`blocked_by`)

**Design.** `DelegationSpec.blocked_by?: string[]` (max 8, session ids `s<N>`), plus
`SessionMeta.blocked?: { by: string[]; since: number; reason?: "deps_failed" | "cycle" }`.
`pi_spawn` with `blocked_by` validates acyclic/known ids, persists a *pending* session (no worktree,
no process), and returns `{status: "blocked", blockedBy}`. A dependency is satisfied when every
listed session has an `integration` record for its current verification. On merge/finish events the
coordinator scans blocked sessions and starts those whose dependencies are satisfied (capacity
permitting; otherwise stays `ready`). Abandoned/failed dependencies mark `reason: "deps_failed"` and
surface a handoff notice; `pi_stop` cancels a blocked session without a worktree. Cycles are rejected
at spawn. `pi_list`/`pi_status` expose blocked state and reasons; `pi_wait` gains
`until: "ready"`? (not required for P1 completion; listed as optional).

### 3.5 P1-5 MCP surface hardening

Because the latest official SDK (1.32.2) does not implement MCP 2026-07-28, P1-5 delivers what is
achievable without a protocol rewrite:

1. `GET /internal/capabilities` (token-protected when configured): server version, protocol version,
   tool names + annotations, feature flags (`evidence`, `validators`, `sandbox`, `runner`, `pr`,
   `dashboardActions`, `dag`). Intended for orchestrators and probes.
2. Deterministic tool registration order + a snapshot test (prompt-cache friendly).
3. Complete tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) for all 30+ tools,
   validated by a test.
4. Structured spawn/verify inputs documented with JSON-schema-friendly descriptions (SDK outputSchema
   where it is stable).
5. `docs/plans/mcp-2026-07-28.md` note describing the deltas (stateless transport, `server/discover`,
   `subscriptions/listen`, tasks extension, MRTR) and the migration gate (SDK upgrade), so the next
   revision is a schedule, not a surprise.

Live MCP 2026-07-28 features are explicitly out of P1 scope.

## 4. Cross-cutting

### 4.1 Config additions (all validated, all with defaults)

| Key | Default | Used by |
| --- | --- | --- |
| `PI_COFFEE_EVIDENCE_TTL_DAYS` | 30 | P0-1 |
| `PI_COFFEE_EVIDENCE_KEEP_PER_SESSION` | 10 | P0-1 |
| `PI_COFFEE_EVIDENCE_MAX_MB` | 64 | P0-1 |
| `PI_COFFEE_EVIDENCE_MAX_FILE_MB` | 8 | P0-1 |
| `PI_COFFEE_VALIDATOR_TIMEOUT_MS` | 600000 | P0-2 |
| `PI_COFFEE_VERIFY_TIMEOUT_MS` | 900000 | P0-2 |
| `PI_COFFEE_SECRET_POLICY` | `reject` | P0-4 |
| `PI_COFFEE_AUDIT_MAX_MB` | 32 | P0-4 |
| `PI_COFFEE_SANDBOX` | `worktree` | P0-3 |
| `PI_COFFEE_SANDBOX_IMAGE` | *(empty)* | P0-3 |
| `PI_COFFEE_SANDBOX_NETWORK` | `bridge` | P0-3 |
| `PI_COFFEE_SANDBOX_ENV_ALLOW` | provider keys | P0-3 |
| `PI_COFFEE_DOCKER_BIN` | `docker` | P0-3 |
| `PI_COFFEE_RUNNER` | `pi` | P1-1 |
| `PI_COFFEE_ACP_COMMAND` | *(empty)* | P1-1 |
| `PI_COFFEE_GH_BIN` | `gh` | P1-2 |
| `PI_COFFEE_GH_REMOTE` | `origin` | P1-2 |
| `PI_COFFEE_PR_LABEL` | `pi-coffee` | P1-2 |
| `PI_COFFEE_ALLOW_PUSH` | `0` | P1-2 |
| `PI_COFFEE_DASHBOARD_ACTIONS` | `0` | P1-3 |

### 4.2 State schema

`state.json` gains a top-level `schemaVersion: 2` plus optional session fields
(`blocked`, `sandbox`, `verification.validators`, `verification.evidence`). Loader migration: v1 →
v2 is additive (defaults filled); unknown fields are preserved on save where already allowed. A v2
state is *not* readable by a v1 daemon — the release notes and CHANGELOG mark the upgrade as
forward-only, and the daemon refuses to start on a newer schema with an actionable message.

### 4.3 Errors and fail-closed rules

- Evidence missing/mutated at merge → refuse.
- Sandbox requested but unavailable → refuse (no fallback).
- Secret detected under `reject` → refuse the write/verification.
- Audit append fails → refuse the guarded action.
- Runner handshake failure → session error with handoff notice, no writes.
- Any new tool that mutates state must appear in the audit log.

### 4.4 Testing strategy

- Unit tests per module with injected fakes (`fake pi`, `fake docker`, `fake gh`, `fake ACP agent`).
- Offline integration tests through the real daemon (existing pattern in `tests/daemon-routes.test.mjs`).
- Optional live tests behind `PI_COFFEE_LIVE_DOCKER=1` / `PI_COFFEE_LIVE_GH=1`; skipped by default.
- `npm run verify` is the gate for every milestone; `node scripts/smoke.mjs` for end-to-end shape.
- Docs consistency: update README tool/config tables in the same commit as the code (test
  `tests/docs-consistency.test.mjs` new: every MCP tool and config key appears in README/zh README).

### 4.5 Security review checklist (per milestone)

Path traversal; symlink escaping; command injection via spec fields; env leakage into sandbox;
secret persistence in evidence/audit/state; audit chain tamper; dashboard auth/CSRF; PR token
handling; container name injection; unvalidated globs; unbounded artifact copy; log redaction; tool
input size limits.

## 5. Risks and open questions

| Risk | Mitigation |
| --- | --- |
| Docker worker spawn diverges from pi's host expectations (`--agent-dir`, extension path) | Confirm exact flags against pinned pi 1.4.0 during P0-3B; fake-docker test plus one live run before merge. |
| Evidence bundles grow state/disk | Caps + TTL + per-session keep; metrics expose bytes. |
| Validator chain changes verification semantics | Default single-validator path is byte-identical; golden tests assert compat. |
| ACP agent differences (permissions, cancellation) | Start with one deterministic fake and a single real agent; document unsupported features. |
| PR/merge-queue needs auth and can push | Opt-in `PI_COFFEE_ALLOW_PUSH`, explicit tool call, audit, never automatic. |
| MCP 2026-07-28 spec gap | Explicit doc + capability endpoint; revisit when SDK ships; no partial protocol hacks. |
| Scope creep | This plan is the contract; additions go to P2 (OTel, durable state, eval harness). |
