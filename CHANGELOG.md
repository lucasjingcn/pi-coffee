# Changelog

All notable changes to pi-coffee are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The hash-chained audit log is now verifiable in a real deployment: `pi_audit`
  (`action: verify|tail`), `GET /internal/audit/verify`, and a verification on
  every daemon start that logs `audit chain verified` or `audit chain BROKEN`
  with the first broken seq. `AuditLog.verify()` previously had no production
  caller, so an edited, reordered or truncated entry was detectable only from the
  test suite.
- `npm run demo` (`scripts/demo.mjs`) runs the deterministic offline smoke test, so
  a fresh install can be proven end to end (daemon, worktrees, acceptance files,
  locks, verify/merge gates, persistence) without a model call or a provider key.
- `scripts/register-clients.mjs` (`npm run register:clients`) is the single MCP
  registration path: it registers the stdio proxy as `pi` with Codex and the pi
  CLI when they are installed, reports DSH/Claude Code/Cursor with the exact
  command or snippet instead of writing their configuration, and restores the
  Codex config when an add fails.
- One-line install without a git checkout: `scripts/bootstrap.sh` fetches the newest release into
  `~/.pi-coffee/app` and runs the same installer (`curl -fsSL
  https://raw.githubusercontent.com/lucasjingcn/pi-coffee/main/scripts/bootstrap.sh | bash`). It
  prefers the release tarball, falls back to the `main` archive, reattaches the terminal so the
  provider prompts still work under `curl | bash`, and accepts `PI_COFFEE_BOOTSTRAP_ARCHIVE` for
  mirrors and tests.
- The package is publishable: `pi-coffee` is a real CLI (`install`, `setup`, `doctor`,
  `register-clients`, `start`, `status`, `demo`, `version`) instead of a private daemon binary, with
  a `files` whitelist (305 kB tarball) and `prepack` build. The release workflow publishes to npm
  with provenance when `NPM_TOKEN` is configured and skips cleanly when it is not.
- `npm run doctor` reports which MCP clients are registered (Codex, pi, DSH, Claude Code, Cursor)
  and the exact command for each missing one. The section is informational and never changes the
  exit code, because an unregistered client does not make the daemon unhealthy.
- Both READMEs now open with the one-line installer, the scripted-install flags, the credential-free
  `npm run demo` check, a copy-paste first-worker prompt and a read-only console screenshot
  (`docs/images/dashboard.png`).

### Fixed (read-only audit of the install/CLI commits)

The one-line installer could not install from a published release, and several
preflight checks answered the wrong question:

- A release tarball has no `src/` and no `tsconfig.json` (the package ships a
  prebuilt `dist/`), yet `install.sh` always ran `npm run build`, so every
  `curl | bash` install from a release asset aborted with
  `error TS5058: The specified path does not exist: 'tsconfig.json'`. It now builds
  only a checkout and installs runtime dependencies for a published copy; the same
  exception covers `npm run demo` / `pi-coffee demo`, which used to fail with
  `tsc: command not found`.
- The release workflow set `NODE_AUTH_TOKEN` without `registry-url`, so npm never
  received it (`ENEEDAUTH`) and the publish step failed; `npm publish` now runs
  last — after the image and the GitHub release exist — so a registry problem can
  neither hide the artifacts nor pass silently.
- `npx pi-coffee register-clients` wrote a permanent MCP registration pointing at
  `scripts/proxy.mjs` inside the prunable npx cache; every command that writes
  durable state (`install`, `setup`, `register-clients`, `start`, `upgrade`) now
  refuses to run from there and points at the one-line installer instead.
- The Windows installer duplicated the registration logic and registered only
  Codex and pi; it now calls the same `register-clients.mjs` as Unix (so DSH,
  Claude Code and Cursor are reported too) and prints the port the daemon serves
  instead of a hardcoded 8787.
- A failed Codex registration left a half-written `config.toml` behind (when the
  file did not exist before) while the summary claimed a restore; the file is now
  removed, and the message distinguishes "restored", "left unchanged" and "could
  not restore".
- `doctor` reported a credential PASS whenever `auth.json` existed, even if it
  held only another provider's login; it now requires an entry for the provider.
  Under `--background` it also validates the agent directory the service will see
  (the env file), not the shell's `PI_CODING_AGENT_DIR`.
- `doctor`'s pi row used `~/.pi/agent/mcp.json` and its DSH row was `registered:
  false` forever; both now follow `PI_CODING_AGENT_DIR` and detect a managed
  `cordis.patch.yml`. An unreadable Codex config is reported as "not registered"
  instead of crashing the preflight (which aborted the install).
- `setup` still hardcoded `~/.pi/agent/auth.json`, so a relocated pi login made it
  exit 2 and, under `set -e`, aborted the install right after the client
  registration; a missing credential is now the doctor's single follow-up instead.
  Agent-directory resolution is shared (`scripts/lib/agent-dir.mjs`).
- `install-cli` wrote the `pi` entry and the PATH line before verifying the
  runtime, so a failed check left a broken `pi` command shadowing the user's own
  and a permanent rc edit; it verifies first, restores the previous entry, and only
  then touches PATH (with the real bin directory instead of a literal
  `$HOME/.local/bin`).
- `bootstrap.sh` reused the unversioned `main` snapshot forever, so a re-run never
  picked up new code; that copy is refreshed now, an existing versioned copy is
  reused only when it looks complete, and `PI_COFFEE_BOOTSTRAP_SHA256` verifies the
  download (documented: unpinned by default).
- `tests/cli.test.mjs` built paths with `URL.pathname`, which fails for a checkout
  in a directory with a space and on Windows; it uses `fileURLToPath` now.

### Fixed (read-only audit of the last 30 commits)

Security and data safety:

- `/internal/*` refused only GET: a cross-site page could still `POST` a `text/plain`
  "simple request" (or an auto-submitted form) to drain or shut the daemon down.
  Mutating requests now require `content-type: application/json` (415) and reject a
  foreign `Origin`/`Sec-Fetch-Site` (403); workers, scripts and `curl` send neither
  header and keep working.
- A docker worker could write `<repo>/.git/config` and redirect `core.hooksPath` (or
  define `filter.*.clean` with a `.gitattributes`) so the *host* daemon executed its
  code during `pi_commit`/`pi_merge`/`git worktree add`. Those calls now pass
  `-c core.hooksPath=/dev/null` for sandboxed sessions, and `<repo>/config` is mounted
  back read-only inside the container.
- `resolveGitMounts` trusted the `.git` pointer written by the sandboxed process, so a
  worker could make the next container bind-mount an arbitrary host path (its HOME).
  The resolved metadata must now stay inside the repository being sandboxed.
- Secret detection missed the shapes people actually paste: a truncated
  `-----BEGIN … PRIVATE KEY-----` block, passwords/DSNs containing `!@#$%`, and
  `scheme://user:password@host`. All three are covered now (new `credential-url` class).
- `/internal/locks` and `/internal/audit/verify` now respect the worker-token scope;
  a scope violation or unknown session answers 403/404 instead of 500.

Correctness:

- `pi_stop` with an `outcome` dropped `preserve_worktree`/`delete_branch`, and the
  default auto cleanup then deleted a clean worktree the caller asked to keep.
- A complete RPC frame larger than 8 MiB (a long `get_entries` reply) was reported as a
  desynchronized stream and killed the worker; the cap now applies to the *unterminated*
  residue only (64 MiB), and fragment buffering is linear instead of quadratic.
- The stdio proxy exited with `process.exit(0)` on stdin EOF and truncated a large reply
  mid-JSON; it now waits for stdout to flush.
- ACP `stop()` cleared its SIGKILL timer as soon as the root exited, so tool children in
  the agent's process group survived a "confirmed" shutdown and their locks were
  released; survivors are now sampled, killed and verified like the pi runner.
- The audit chain's `verify()` bypassed the append queue, so verifying while appending
  reported a healthy log as BROKEN; and a hash-consistent tail appended past the head
  sidecar was accepted. Reads share the queue, and an unanchored tail is reported
  (only this log's own failed sidecar write is tolerated).
- `isCandidateClean` parsed non-`-z` porcelain output, so artifact files with spaces or
  quotes could never match and verification failed for the wrong reason.
- The dashboard returned `200 {"ok":true}` for a failed merge, dropping conflicts/output.
- Finishing an earlier session after a later merge was impossible (the recorded merge
  commit had to equal the target HEAD); it only has to be an ancestor now.
- Merge-queue sessions could never record success: `pi_merge mode=merge-queue` writes no
  local integration record, so finish now adopts the merged PR from GitHub (still
  fail-closed: the PR must be MERGED with a merge commit that is in the target history).
- A worker that merged or rebased the target branch was charged with everyone else's
  commits (`changes outside declared scope`); change attribution now starts at
  `merge-base(HEAD, target)`.
- The dashboard's Send gate was read-then-act (a double click delivered twice); the
  two-strikes slot is reserved inside `Coordinator.send` before the first await.
- `pi_evidence verify` now compares the manifest hash recorded by the verification, so it
  agrees with the merge gate instead of reporting a replaced bundle as `ok`.
- Code freshness hashed only `dist/manager.js`: editing another module and rebuilding
  kept `stale: false`. The fingerprint covers the whole `dist`.
- `verifications_total`/`merges_total` were state-derived but declared as counters (a
  re-verify lowered them), and `active_workers` ignored in-flight spawn slots.
- A timed-out ACP turn let the next queued turn fire a second `session/prompt`; the
  runner is now poisoned instead. A stdin pipe error also kills the agent before
  reporting `exit`.

Operations:

- `npm run upgrade` on macOS could not change the code: launchd's `KeepAlive` restarted
  the *old* build after the graceful shutdown and the installer then refused with
  "pi-coffee is running". The upgrade now boots the LaunchAgent out and points at
  `npm run install:local`; the Windows path prints `Start-ScheduledTask` and the drain
  cancel result is verified instead of being assumed.
- The release workflow built the container image *after* creating the GitHub release, so
  a failed build could not be retried (duplicate release); the image is built first, the
  release is idempotent, a pre-release tag no longer moves `:latest`/GitHub "Latest", and
  `verify.yml` builds the runtime image without pushing.
- The merge-queue method is configurable (`PI_COFFEE_PR_MERGE_METHOD`) instead of a
  hardcoded `--squash`; `gh` failures keep the real cause (`ENOENT`, timeout) instead of
  `exit null`, with a note that the effect may already have been applied.
- `~/.pi-coffee/env` accepts `export KEY=VALUE` (it used to create a key named
  `export KEY` and silently ignore the setting), `doctor` respects `PI_CODING_AGENT_DIR`,
  and `setup-dsh --write` exits 1 when a hand-written `pi-coffee` row is in the way
  instead of claiming success.
- The console bounds its payloads: file lists are capped at 50 entries and the diff route
  truncates at 2 MiB with a marker.

### Fixed

- The suite is green on Linux and macOS CI again. Three environment-dependent
  failures: docker-worker fixtures bound a loopback listener that the Linux
  coord-host guard correctly refuses (they now bind a reachable interface, and the
  guard itself is exercised through an exported platform-parameterised predicate);
  the doctor credential test only passed on a machine with a real
  `~/.pi/agent/auth.json` (it now runs with a private HOME and checks the
  interactive/background distinction directly); and `pi`'s descendant tree was
  sampled *after* closing stdin, so a fast graceful exit could confirm the stop
  with a detached tool still running — it is sampled before EOF now.
- `loadConfig` validates `overrides.host` instead of only the environment value.
  The docker coord-host rule reads the listener address, but overrides were applied
  after validation, so a caller that asked for a reachable interface (tests, the
  daemon's own config builder) was still rejected as a loopback daemon.
- Sandbox containers now mount the git metadata their checkout points at. A linked
  worktree keeps `.git` as a file naming `<repo>/.git/worktrees/<name>`, so a
  container that mounted only the candidate made every git-dependent acceptance
  command exit 128 (`fatal: not a git repository`). The metadata is mounted at the
  absolute paths git recorded, which leaves `git rev-parse`, `git diff`, hooks and
  `git -C subdir` behaving exactly as on the host; a plain checkout needs no extra
  mount. Worker containers get the same treatment, so `git` works inside them too.
- Sandbox containers run as the invoking uid/gid (and supplementary groups) on
  Linux (`PI_COFFEE_SANDBOX_USER=auto`; `root` keeps the image default, `0:0` forces
  root, `uid:gid` pins an exact identity on Linux).
  As root, every file written into a bind mount landed root-owned on the host and
  the daemon's own cleanup (`git worktree remove`, removing a verification
  candidate) failed with EACCES even though the command had passed. Docker Desktop
  already maps writes back to the host user, so the image default is kept there.
- Verification no longer touches a candidate whose git metadata was pruned or
  rewritten from inside the sandbox: `git worktree remove` failing (a container can
  drop `<common>/worktrees/<name>` with one `git worktree prune`) used to throw out
  of the cleanup block, discarding a recorded result and leaking the temporary
  candidate. Cleanup now prunes the stale registration and deletes the checkout,
  and candidate preparation ignores repository hooks. The repository's hook
  directory is also mounted read-only inside the sandbox, so a sandboxed command
  can no longer plant a hook that `pi_commit`/`pi_merge` would later execute on the
  host, while `git add`/`git commit` inside the container keep working.
- `PI_COFFEE_VERIFY_TMPDIR` selects where verification candidates are created
  (default: the system temp dir). The candidate is bind-mounted into the sandbox,
  so a docker daemon that cannot see the system temp dir — colima shares only
  `$HOME` — used to mount an empty `/workspace` and fail every docker verification
  for reasons the acceptance command could not explain.
- - The Docker runtime image now installs `procps`: the worker-ownership probe uses
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
- An unterminated pi stdout line fails the RPC client closed instead of
  buffering without bound (64 MiB; a newer entry below also stops a *complete*
  large frame from being mistaken for a desynchronized stream); the stdio proxy
  answers requests in arrival order.
- Docker pins the bundled pi version and separates the host port from the fixed
  container port; `npm run start` lets the process environment override the
  settings file; the installer backs up and restores the Codex config when MCP
  registration fails and no longer removes pi's entry before re-adding it.
- CI runs the extension typecheck plus platform-neutral suites on Windows, and a
  release refuses a tag that does not match `package.json`.
- The ACP runner serializes turns instead of racing a second `session/prompt`.
  ACP v1 answers one prompt per turn, yet `steer`/`followUp` sent a second one
  while the first was still running; whichever returned first cleared the single
  `streaming` flag, emitted `agent_settled` and flipped the worker to idle, so
  `pi_wait`, `pi_verify`, `pi_commit` and read-only `pi_finish` could proceed
  while the agent was still writing the worktree — and the last turn's text (plus
  any agent-side "session busy" rejection) was lost. Turns are now chained, a
  queued instruction is acked immediately instead of blocking the orchestrator
  for the rest of somebody else's turn, and `isStreaming` counts the whole
  accepted backlog, so `agent_start`/`agent_settled` fire on its edges only. ACP
  still has no steering channel: a `steer` or follow-up instruction runs as the
  next turn.

### Fixed (post-merge review of the 0.3.x hardening)

- A shutdown confirmed by the worker's stdin-EOF exit now samples and verifies the
  process tree too: pi's graceful path skips the SIGTERM handler that kills its
  detached bash tools, so a confirmed stop could release locks (and delete the
  worktree) while a tool was still writing. Surviving descendants are terminated,
  and only then is the stop confirmed.
- `/internal/drain` and `/internal/shutdown` stay reachable for a loopback caller
  when no `PI_COFFEE_TOKEN` is configured. Gating them on "protected sessions
  exist" locked `npm run upgrade` and HTTP graceful shutdown out of their own
  daemon for good, since that deployment has no credential that can satisfy the
  rule. Other mutating endpoints keep the rule, and POST-only still applies.
- A `cp`/`mv`/`install`/`ln`/`rsync`/`scp` destination followed by `&&`, `;`, `|`
  or a newline is no longer dropped, so the escape check and the write claim see
  it again; `/dev/fd/../..`-style paths stop being treated as discard devices.
- `pi_verify(timeout_ms)` bounds a single acceptance command again: the
  per-validator default (10 minutes) no longer caps a chain of one, where nothing
  needs protecting from a greedy predecessor.
- The proxy, health probe, `status`, `inspect`, `doctor`, `upgrade` and `setup-dsh`
  load `~/.pi-coffee/env` with the daemon's precedence (exported value wins, file
  fills gaps). They used to let the file win, so one duplicated key could point
  them at a different port, token or data directory than the running daemon.
- An artifact glob now tolerates a rewritten *tracked* report file: the candidate
  status is parsed untrimmed, so the leading column of ` M path` no longer eats
  two characters of every tracked path.
- `gh pr create` adopts the pull request that exists when the label step fails,
  instead of retrying into "already exists" and reporting a failure for work that
  happened; both error messages are preserved when it really fails.
- A failed `vault.save` during spawn removes the worktree and branch it created,
  matching what the changelog already claimed; `pi_resume` audits before taking
  claims, so a failed append can no longer strand scope/acceptance locks; a
  successful verification is only recorded after its audit entry is durable.
- The periodic sweeper also reclaims archived sessions (no runtime), which used to
  wait for another restart once the startup sweep hit its TTL skip.
- An audit head-sidecar write failure no longer reuses the sequence number: the
  durable entry owns it, and `resolveHead` repairs the sidecar.
- Oversized `/internal/*` bodies answer `413` again (the `PayloadTooLargeError`
  was mapped to 400 before the handler that special-cases it).
- The dashboard lists archived sessions (matching `/metrics`) and can record
  `success_second`/`taken_over` instead of always writing `success_first`, which
  distorted `first_try_rate`.
- Secret detection is case-insensitive and covers `Authorization: Bearer …`, so
  `password:`/`api_key=` values are rejected on coordination surfaces too.
- `PI_COFFEE_SANDBOX=docker` refuses `PI_COFFEE_SANDBOX_NETWORK=none` and, on
  Linux, a loopback listener with the default `host.docker.internal` coord host:
  the container could reach neither the daemon nor authorize a write. The coord
  host is now configurable with `PI_COFFEE_SANDBOX_COORD_HOST`.
- A validator's explicit `env` wins over an allowlisted host name in the docker
  sandbox (it was silently replaced by the daemon's value), and a container that
  cannot be removed fails the stop instead of releasing locks.
- The ACP runner caps one unterminated stdout line at 8 MiB.
- `install.sh` and `deploy/macos/install-daemon.sh` detect a running daemon by
  capturing `launchctl print` output: `… | grep -q` returns 141 under `pipefail`,
  which silently disabled the guard. Under sudo, `install.sh` now asks the
  invoking user's systemd about their `--user` unit as well.
- `npm run upgrade` cancels the drain when the shutdown is refused, and a
  truncated drain-status reply no longer crash-loops the poller; the health probe
  prints the endpoint it actually probed.
- `npm run install:local` no longer aborts on a machine without Codex, and no
  longer leaves a half-installed tree when no provider credential is configured:
  a missing client is skipped, a missing credential is a warning, and both are
  named with the exact follow-up command in the final summary.
- The user-facing `pi` installer no longer fails with a `dyld: Library not loaded`
  error when the Node on PATH cannot be copied into its private prefix (Homebrew's
  `node` links `libnode.dylib`). On Unix the unusable copy is removed and the
  launcher uses the supported Node on PATH, as it already preferred at runtime;
  Windows keeps the hard failure because it launches the private runtime directly.

### Changed

- `npm run install:local` is client-agnostic and scriptable: it registers the MCP
  server with every client it detects (a missing Codex is skipped, not fatal),
  accepts setup options non-interactively (`--provider`, `--api-key`, `--model`,
  `--thinking`, `--skip-setup` forwarded through `npm run install:local -- …`), and
  ends with a Next-steps summary that names the endpoint, logs, restart command and
  the credential follow-up when one is needed.

- The documentation is restructured around a short README (960 → ~235 lines, same
  for the Chinese version). Tool, configuration, coordination and operations
  detail moved to `docs/reference/` and `docs/development.md` instead of being
  appended to the front page. The docs moved out of the README were already in
  it, so no claim was dropped; duplicated rows, a list item broken by a later
  insertion, a section stranded below the license, and cross-project policy text
  left over from the orchestration rules are gone.
- `tests/docs-consistency.test.mjs` now enforces the new layout: all tools in the
  reference and both READMEs, all `PI_COFFEE_*` names in
  `docs/reference/configuration.md`, a README line cap, and every relative
  Markdown link resolving to a real file.

## [0.3.1] - 2026-11-01

### Fixed

- `pi_spawn` now forwards `blocked_by` and accepts `spec.isolation`; both were silently stripped by
  the MCP schema/call, so the dependency gate and docker policy never ran from MCP.
- `pi_pr` parses the URL printed by `gh pr create` (gh 2.102 rejects `--json`), reuses only open PRs,
  and treats a missing label as cosmetic; merge-queue pushes the branch and refuses a PR whose head is
  not the verified worker.
- ACP permission answers map `value`/`confirmed:false` to the matching reject option instead of always
  selecting the first (allow) option.
- Verification and resume refuse a session whose recorded sandbox differs from the daemon backend;
  startup recovery removes the docker worker container as well as stopping its CLI process group.
- Evidence manifests no longer embed raw validator stdout/stderr (they bypassed redaction and caps).
- State now writes `schemaVersion: 2`, loads legacy v1 state, and refuses a newer schema.
- Dashboard send honours the two-strikes gate; oversized action bodies drain instead of resetting the
  socket; every rejected action writes a denial audit entry.
- `pi_merge`/`pi_resume` audit before mutating, so an audit failure cannot leave a completed action
  reported as failed; finish restores the previous outcome if its audit append fails.
- Verification sandbox forwards allowlisted env by name (`-e NAME`), keeping values out of `docker ps`.
- Capabilities lists health/shutdown/capabilities endpoints; PR operations take the repository guard.

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
