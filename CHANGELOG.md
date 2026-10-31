# Changelog

All notable changes to pi-coffee are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
