# Changelog

All notable changes to pi-coffee are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The Docker runtime image now installs `procps`: the worker-ownership probe uses
  `ps`, so `pi_spawn`/`pi_resume` failed in the container (which only installed
  bash, git and ripgrep). `npm run doctor` now checks for `ps` too.
- Verification rejects an acceptance command that commits changes to the
  candidate worktree. A clean `git status` used to hide the mutation, so the
  recorded "passed" evidence described a different tree than the one merged.
- Validation-change detection now covers `package.json`, lockfiles, `Makefile`,
  Docker/Compose files and `.github/workflows`/`.github/actions`, so rewriting
  the validation definition requires `pi_review` instead of silently expanding
  what the acceptance command runs.
- The 48h session-directory sweep no longer deletes the transcript of a stopped
  but unfinished session that still has a worktree or a live worker branch; the
  transcript is what `pi_resume` needs, and `reclaimStale` already owns the
  beyond-recovery case.
- Mutating `/internal/*` endpoints (`claim`, `release`, `send`, `board/post`,
  `drain`, `shutdown`, …) require POST/PATCH; a GET used to execute side effects,
  so any local page or process could stop the daemon.
- `pi_message` no longer reports a message as delivered before the injection
  attempt resolves.
- Installing the Linux service restarts the unit after `enable --now`, and the
  install guard checks the system unit as well as the user unit (the user check
  silently passed under sudo). The macOS installer refuses to `bootout` a running
  daemon unless `--force` is given.
- Worker write locks are revalidated with the daemon on every `edit`/`write`/
  `bash`, and `coord_release` clears overlapping cached paths, so an operator
  `pi_release` or a parent-directory release can no longer leave an edit
  unclaimed.
- A shutdown that needed SIGKILL now verifies that no recorded descendant
  process survived (for example pi's detached bash tools) and retains the locks
  instead of reporting a confirmed stop when one did.
- `inspect.mjs` applies the daemon's settings file, so it no longer inspects the
  wrong data directory while claiming to match the daemon.
- `npm test` now passes `--test-timeout` and `--test-force-exit`, and the two
  worker-ownership tests skip when `ps` is unavailable instead of leaking a
  detached fixture child and hanging the runner.
- Stopping a worker no longer fails while the same repository is being verified,
  merged or executed; the worktree cleanup is deferred to the sweeper instead of
  leaving the worker alive on SIGTERM.
- A daemon restart no longer shortens worktree/transcript retention below
  `PI_COFFEE_WORKTREE_TTL_MIN`; failed spawns remove the worktree and branch they
  created, including credential-persistence failures.
- `drain`/`/internal/shutdown` count in-flight spawns, so `active: 0` is a real
  restart point; claims are refused once a session is stopping/stopped/error,
  absolute paths from a manual claimant are rejected loudly, and lock keys
  resolve symlinked prefixes to the same physical path.
- `pi_message` reports `delivered` only after a confirmed injection; a post-merge
  hook that dirties the target is surfaced in the merge result.
- Literal `cp`/`mv`/`install`/`ln`/`rsync`/`touch`/`mkdir` destinations, `dd of=`
  and literal `sh -c` scripts are recognized write targets.
- An 8 MiB unterminated pi stdout line fails the RPC client closed instead of
  buffering without bound; the stdio proxy answers requests in arrival order.
- Docker pins the bundled pi version and separates the host port from the fixed
  container port; `npm run start` lets the process environment override the
  settings file; the installer backs up and restores the Codex config when MCP
  registration fails and no longer removes pi's entry before re-adding it.
- CI runs the extension typecheck plus platform-neutral suites on Windows, and a
  release refuses a tag that does not match `package.json`.

## [0.3.0] - 2026-11-01

### Added

- P0/P1 design and implementation plans under `docs/plans/` (durable evidence bundles, validator
  chains, sandboxed workers, receipted coordination with a hash-chained audit log, pluggable runners
  with ACP support, PR and merge-queue integration, dashboard actions, dependency-aware spawns, and
  MCP surface hardening).
- Secret detection on coordination surfaces (`PI_COFFEE_SECRET_POLICY=reject|redact`, default
  `reject`) covering mailbox text, board values, outcome notes, and evidence logs.
- Hash-chained audit log for coordinator actions (`PI_COFFEE_AUDIT_MAX_MB`, default 32) with best-effort
  appends for delivery/cleanup paths and fail-closed appends for authority gates.
- Read-back receipts for coordination writes: mailbox messages and board entries persist a canonical
  `sha256`, and `pi_message` / the internal send endpoint / `pi_board_post` verify it against durable
  state before reporting `readBack: true`. A missing or mismatched entry fails the call.
- Durable verification evidence bundles (`PI_COFFEE_DATA_DIR/evidence/<session>/<verification>/`):
  manifest with file sizes and sha256 hashes, combined stdout/stderr, the reviewed diff, changed
  files, validator records and sandbox metadata. Written atomically (temp directory + rename);
  `pi_verify` returns an `evidence` reference, and oversized logs keep a tail recorded in `truncated`.
  Retention is configured with `PI_COFFEE_EVIDENCE_TTL_DAYS`, `PI_COFFEE_EVIDENCE_KEEP_PER_SESSION`,
  `PI_COFFEE_EVIDENCE_MAX_MB` and `PI_COFFEE_EVIDENCE_MAX_FILE_MB`.
- Validator chains: `spec.validators` runs an ordered list of commands in the merged candidate with
  per-validator timeouts (`PI_COFFEE_VALIDATOR_TIMEOUT_MS`), required/optional semantics, an overall
  budget (`PI_COFFEE_VERIFY_TIMEOUT_MS`) and artifact globs captured into the evidence bundle.
  `acceptance_command` remains the single-validator default and cannot be combined with
  `spec.validators`; validator env values are checked for secrets before they are persisted.
- Task dependency gate: `pi_spawn blocked_by` accepts already-integrated session ids, rejects
  unknown ids, recorded cycles and failed dependencies (`deps_failed`), and exposes the dependency
  edge in status/list. Deferred auto-start remains documented future work.
- Opt-in dashboard write actions (`PI_COFFEE_DASHBOARD_ACTIONS=1`, requires `PI_COFFEE_TOKEN`):
  send/finish/merge/stop guarded by token + CSRF header + JSON content type + same-origin Origin, with
  per-session confirmation for destructive actions and coordinator audit entries.
- GitHub integration: `pi_pr` pushes a verified branch and creates (or reuses) a PR whose body carries
  the verification id, candidate SHAs and evidence manifest hash; `pi_merge mode=merge-queue` queues it
  with the GitHub merge queue. Both require `PI_COFFEE_ALLOW_PUSH=1`; tokens travel only through the
  child environment (`PI_COFFEE_GH_TOKEN` / explicit `PI_COFFEE_GH_ALLOW_ENV_TOKEN`).
- Pluggable worker runners: `PI_COFFEE_RUNNER=acp` / `spec.runner` drives an ACP v1 agent over stdio
  with the same lifecycle surface as pi (prompt, events, permissions, stop), a raw
  `sessions/<id>/acp.jsonl` transcript, and explicit non-goals (no model overrides, no resume, no
  docker sandbox).
- Docker sandbox phase B: workers run inside a deterministic `pi-coffee-worker-<id>` container that
  mounts only the worktree (`/workspace`), session directory (`/session`) and the worker extension
  (read-only); `PI_COORD_*` handshake values and allowlisted env names are forwarded, and containers
  are removed on stop, failed startup and restart recovery. `spec.isolation` cannot bypass policy.
- Docker sandbox phase A: verification/validator commands run in a fresh per-run container that
  mounts only the candidate at `/workspace`, forwards only `PI_COFFEE_SANDBOX_ENV_ALLOW` names and is
  removed after the run or timeout. `PI_COFFEE_SANDBOX=docker` + `PI_COFFEE_SANDBOX_IMAGE`;
  `spec.isolation` can request a backend but cannot bypass the daemon policy. Docker/image absence
  fails closed with no host fallback, and evidence records the sandbox image/digest/network.
- Evidence lifecycle: `pi_evidence` (`list|get|verify`) exposes bundles over MCP, `pi_merge` and
  successful outcomes fail closed when the recorded bundle is missing or modified, and the sweeper /
  `pi_gc` prune expired bundles (`evidence_removed`, `evidence_bytes`) while always keeping the newest
  `PI_COFFEE_EVIDENCE_KEEP_PER_SESSION` per session.

### Security

- Secret-like values in mailbox messages, board entries, and outcome notes are rejected (or redacted)
  before they are persisted.

## [0.2.0] - 2026-10-31

### Added

- Prometheus metrics renderer and optional structured JSON logs (`PI_COFFEE_LOG_FORMAT=json`).
- Read-only web dashboard for sessions, diffs, tails, and health.
- First-class DSH integration guide and an idempotent `scripts/setup-dsh.mjs`.
- `pi_drain` drain mode and `scripts/upgrade.mjs` for a safe restart.
- Automatic recovery of workers that were active when the daemon crashed.
- GitHub release workflow (npm tarball + GHCR image) and Dependabot updates.
- `engines` field: Node.js >= 22.19.0.

### Changed

- Upgraded `@earendil-works/pi-coding-agent` 1.1.0 → 1.4.0.
- Upgraded `@modelcontextprotocol/sdk` 1.30.1 → 1.32.2, `typebox` 1.3.34 → 1.4.3,
  `zod` 3.25 → 4.6, `@types/node` 22 → 24, `tsx` 4.19 → 4.23.
- CI now runs on Node 22.19.0, 24, and 26 with `actions/checkout@v7` and
  `actions/setup-node@v7`, and cancels superseded runs.

### Fixed

- `pi_resume` preserves the worker's provider and model instead of silently
  falling back to the daemon default when pi does not report them.
- Daemon test fixtures no longer read the real `~/.pi` credential store, so
  `npm run verify` can run while a daemon is active.

### Verification

- `npm run verify` passes the full offline test suite (typecheck, real pi extension types, offline MCP suite, playbook consistency); the exact count is whatever the repository currently holds, since a hard-coded number goes stale.
- CI matrix: Linux/macOS × Node 22.19.0/24/26 plus Windows startup.
- s287/s288/s289 passed `pi_verify`/`pi_review`/`pi_merge`; s286 was taken over manually after a declared-scope omission (`src/mcp-server.ts` needed the required `pi_drain` tool) blocked `pi_verify`, and the merged tree was verified with the same full suite.

### Security

- `npm audit --omit=dev` reports no known vulnerabilities after the dependency
  upgrade (zod 4 fixes GHSA-mrhx-c7xc-m3w5).
