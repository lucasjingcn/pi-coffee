# Changelog

All notable changes to pi-coffee are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- `npm run verify` passes 359/359 offline tests (typecheck, real pi extension types, offline MCP suite, playbook consistency).
- CI matrix: Linux/macOS × Node 22.19.0/24/26 plus Windows startup.
- s287/s288/s289 passed `pi_verify`/`pi_review`/`pi_merge`; s286 was taken over manually after a declared-scope omission (`src/mcp-server.ts` needed the required `pi_drain` tool) blocked `pi_verify`, and the merged tree was verified with the same full suite.

### Security

- `npm audit --omit=dev` reports no known vulnerabilities after the dependency
  upgrade (zod 4 fixes GHSA-mrhx-c7xc-m3w5).
