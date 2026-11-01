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
