# Configuration

Everything is configured through environment variables, read by `src/config.ts`. Defaults below are
the values used when nothing overrides them; programmatic overrides passed to `loadConfig` win over
both env vars and defaults.

Bad values stop startup instead of limping along: ports must be integers from 1 to 65535, session
caps and warning thresholds must be positive safe integers, and the TTL must be finite and at least
one minute (fractional minutes are fine). Numbers use decimal notation and booleans accept only `0`
or `1`. The log rotation knobs are the one exception: an unreadable value falls back to its default,
so a typo cannot stop the daemon from starting.

For background installs, `npm run start`, the stdio proxy, `setup` and `doctor` read the same private
env file (`PI_COFFEE_ENV_FILE`, default `~/.pi-coffee/env`). Transient shell credentials are not
inherited by background services, so put provider keys there; `npm run doctor -- --background`
checks persisted credentials before startup is installed.

## Daemon and daemon state

| Variable | Default | Meaning |
|---|---|---|
| `PI_COFFEE_HOST` | `127.0.0.1` | Bind address. Loopback by default. |
| `PI_COFFEE_PORT` | `8787` | Port for `/mcp` and `/internal/*`. Under `docker compose` the container always listens on `8787`; set `PI_COFFEE_HOST_PORT` (compose only) to change the published host port. |
| `PI_COFFEE_TOKEN` | *(none)* | Optional shared secret for `/mcp` and `/internal/*`, sent as `x-pi-coord-token` or `Authorization: Bearer`. |
| `PI_COFFEE_DATA_DIR` | `~/.pi-coffee` | Daemon state: locks, mailbox, board, session metadata, evidence, audit log, control credentials. |
| `PI_COFFEE_DEFAULT_REPO` | *(none)* | Default repository for `pi_spawn`. If unset, every spawn must pass `repo`. |
| `PI_COFFEE_WORKSPACE_ROOT` | `~/.pi-coffee/worktrees` | Where worktrees are created. |
| `PI_COFFEE_BASE_REF` | `HEAD` | Base ref for new worktrees. |
| `PI_COFFEE_ENV_FILE` | `~/.pi-coffee/env` | File that `npm run start`, the proxy, setup and doctor read for daemon settings and credentials. |
| `PI_COFFEE_SKIP_SETUP` | *(unset)* | Set to `1` for unattended background installation: skip the credential prompt and expect credentials in the env file or pi's `auth.json`. |

## Workers and models

| Variable | Default | Meaning |
|---|---|---|
| `PI_COFFEE_PROVIDER` / `PI_COFFEE_MODEL` | `deepseek` / `deepseek-flash` | Worker provider and model. |
| `PI_COFFEE_STRONG_MODEL` | *(empty)* | Model for an explicit manual upgrade. Empty means no upgrade is available. |
| `PI_COFFEE_THINKING` | `xhigh` | pi thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Overridable per spawn. |
| `PI_COFFEE_MAX_SESSIONS` | `8` | Hard cap on concurrent workers. |
| `PI_COFFEE_PARALLEL_WARN` | `4` | Warns in `pi_spawn` once this many workers are active. |
| `PI_COFFEE_PI_BIN` | pinned local pi CLI with `npm run start` | Explicit pi CLI override. |
| `PI_COFFEE_BASH_BIN` | detected Bash | Bash executable for acceptance commands; on Windows, Git for Windows supplies it. |
| `PI_COFFEE_EXTENSION` | bundled `extensions/pi-coordinator.ts` | Coordinator extension loaded into every worker. |
| `PI_COFFEE_WORKER_PLUGINS` | *(empty)* | Comma-separated glob allowlist of global plugins a worker may inherit: npm/git package sources, external extension entries and MCP server names. Empty means none; `*` restores full inheritance. Core `builtin:` extensions always survive. |
| `PI_COFFEE_WORKER_WARN_MS` / `PI_COFFEE_WORKER_STALL_MS` / `PI_COFFEE_WORKER_IDLE_MS` | `60000` / `600000` / `1800000` | Watchdog thresholds: no-activity warning, stalled worker, idle worker. The stall deadline must exceed the warning deadline. |

## Runners

| Variable | Default | Meaning |
|---|---|---|
| `PI_COFFEE_RUNNER` | `pi` | Default worker runner: `pi` (pinned CLI) or `acp` (Agent Client Protocol). |
| `PI_COFFEE_ACP_COMMAND` | *(empty)* | ACP agent argv (JSON array or whitespace-separated); required when `PI_COFFEE_RUNNER=acp`. |

## Verification and evidence

| Variable | Default | Meaning |
|---|---|---|
| `PI_COFFEE_VERIFY_TIMEOUT_MS` | `900000` | Overall budget (ms) for the whole validator chain. |
| `PI_COFFEE_VALIDATOR_TIMEOUT_MS` | `600000` | Default per-validator timeout (ms) when a validator does not set `timeoutMs`, for chains of two or more validators. A single validator (including the legacy `acceptance_command`) uses the whole `PI_COFFEE_VERIFY_TIMEOUT_MS`/`timeout_ms` budget instead. |
| `PI_COFFEE_VERIFY_TMPDIR` | *(system temp)* | Parent directory for verification candidates. Must be absolute. Point it at a path the docker daemon can bind-mount when the system temp dir is not shared (colima shares only `$HOME`). |
| `PI_COFFEE_EVIDENCE_TTL_DAYS` | `30` | Days a verification evidence bundle is retained (`0` disables TTL cleanup). |
| `PI_COFFEE_EVIDENCE_KEEP_PER_SESSION` | `10` | Newest evidence bundles kept per session regardless of TTL. |
| `PI_COFFEE_EVIDENCE_MAX_MB` | `64` | Total size budget for one evidence bundle (MiB). |
| `PI_COFFEE_EVIDENCE_MAX_FILE_MB` | `8` | Per-file budget inside a bundle; oversized logs keep a tail and are listed in `truncated`. |

## Docker sandbox

| Variable | Default | Meaning |
|---|---|---|
| `PI_COFFEE_SANDBOX` | `worktree` | Execution backend: `worktree` (host behavior) or `docker`. |
| `PI_COFFEE_SANDBOX_IMAGE` | *(empty)* | Required for `docker`: an image containing bash and the project toolchain. |
| `PI_COFFEE_SANDBOX_NETWORK` | `bridge` | Container network mode; `none` disables provider access and is refused with `PI_COFFEE_SANDBOX=docker`, because workers authorize writes against the daemon. |
| `PI_COFFEE_SANDBOX_COORD_HOST` | `host.docker.internal` | Host name a worker container uses to reach the daemon. Docker Desktop maps this to the host; on Linux it resolves to the bridge gateway, so the daemon must listen on an interface the bridge can reach. |
| `PI_COFFEE_SANDBOX_ENV_ALLOW` | *(empty)* | Comma-separated host env names forwarded into containers; nothing else is passed. |
| `PI_COFFEE_SANDBOX_USER` | `auto` | Container user. `auto` runs as the invoking uid/gid (plus supplementary groups) on Linux so bind-mount writes stay host-owned and cleanup cannot hit EACCES, and keeps the image default on Docker Desktop. `root` keeps the image default everywhere; use `0:0` for an image whose default user is root. `uid:gid` pins an exact identity (no supplementary groups) and is Linux-only in practice: on Docker Desktop a uid that differs from the mount owner makes git report `dubious ownership`. |
| `PI_COFFEE_DOCKER_BIN` | `docker` | Docker CLI path (a fake binary in tests). |

## Cleanup and retention

| Variable | Default | Meaning |
|---|---|---|
| `PI_COFFEE_AUTO_CLEAN` | `1` | Remove finished workers' worktrees automatically; branches are kept. |
| `PI_COFFEE_WORKTREE_TTL_MIN` | `60` | Minutes a finished, idle worker is kept before the sweeper cleans it. |
| `PI_COFFEE_WORKTREE_FINAL_TTL_MIN` | `10080` | Minutes a clean worktree of an unfinished or abandoned stopped worker is kept before final retention. `0` disables it; the branch is always kept. |
| `PI_COFFEE_DELETE_BRANCHES` | `0` | Default for the `delete_branch` flag on an explicit `pi_stop`. `pi_gc` ignores this. |

## Logs, audit and recovery

| Variable | Default | Meaning |
|---|---|---|
| `PI_COFFEE_LOG_MAX_MB` | `5` | Archive a daemon log at the next start once it exceeds this size. `0` disables rotation. |
| `PI_COFFEE_LOG_KEEP` | `1` | Rotated archives kept per log (`daemon.err.log.1`, `.2`, ...). |
| `PI_COFFEE_LOG_FORMAT` | `text` | `json` emits one JSON object per stderr line; credential-shaped values are redacted. |
| `PI_COFFEE_AUDIT_MAX_MB` | `32` | Rotate the hash-chained audit log once the active file reaches this size (MiB). |
| `PI_COFFEE_RECOVER_ON_START` | `1` | Auto-resume sessions that were active when the daemon crashed. `0` leaves them stopped for an explicit `pi_resume`. |
| `PI_COFFEE_SECRET_POLICY` | `reject` | How coordination surfaces handle detected secrets: `reject` fails the write, `redact` replaces the span with a marker. |

## GitHub integration

| Variable | Default | Meaning |
|---|---|---|
| `PI_COFFEE_ALLOW_PUSH` | `0` | Explicit opt-in for `pi_pr` and merge-queue pushes. |
| `PI_COFFEE_GH_BIN` | `gh` | GitHub CLI path for `pi_pr`. |
| `PI_COFFEE_GH_REMOTE` | `origin` | Remote pushed by `pi_pr`. |
| `PI_COFFEE_PR_LABEL` | `pi-coffee` | Label applied to created PRs. |
| `PI_COFFEE_GH_TOKEN` | *(empty)* | Token passed to `gh` as `GH_TOKEN` (never argv). |
| `PI_COFFEE_GH_ALLOW_ENV_TOKEN` | `0` | Allow an ambient `GH_TOKEN` to reach `gh` when no explicit token is set. |
| `PI_COFFEE_DASHBOARD_ACTIONS` | `0` | Opt-in write actions in the dashboard (send/finish/merge/stop); requires `PI_COFFEE_TOKEN`. |
