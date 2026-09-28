# pi-mcp

Let **Codex act as the general manager (大总管)** that drives multiple concurrent **pi** coding
sessions. Codex decomposes work, spawns isolated pi workers, assigns tasks, reviews their diffs for
bugs, answers their questions, tracks progress, and owns the final merge/commit/push.

- **Isolation**: every worker gets its own `git worktree` + branch, so file edits never collide.
- **No collisions beyond that too**: workers auto-claim files (edit/write/bash) and are blocked if
  another worker holds a conflicting claim.
- **Inter-session messaging**: mailbox + shared board; workers can message each other or Codex.
- **Human-in-the-loop for agents**: workers ask blocking questions (`coord_ask`) that surface to
  Codex as MCP tool results and are answered with `pi_answer`.
- **Codex instructions on connect**: MCP `instructions` + an `orchestrate` prompt + a
  `pi-orchestrator` Codex skill.

## Architecture

```
Codex ──streamable HTTP MCP──► pi-mcp daemon ──RPC JSONL──► pi worker 1 (worktree/branch)
  ▲                            (registry, locks,        ──RPC JSONL──► pi worker 2 (worktree/branch)
  └── skill + instructions      mailbox, board, UI)      ──RPC JSONL──► pi worker N ...
                                     ▲
                     worker-side pi extension (pi-coordinator.ts):
                     auto file-claims, inbox polling, coord_* tools
```

The daemon spawns each worker as a long-lived `pi --mode rpc` child and injects the worker extension.
The runtime path is deliberately the `pi` executable, not pi's internal modules, so `pi update`
doesn't break the integration.

## Install

Run as the **same Unix user that runs Codex** (see Deployment note):

```bash
./install.sh          # npm install + build + install codex skill + `codex mcp add pi`
```

Then start the daemon (keep it running; systemd/tmux recommended):

```bash
./run.sh              # listens on http://127.0.0.1:8787
```

Restart Codex. It connects to pi-mcp, receives the 大总管 instructions, loads the
`pi-orchestrator` skill, and can call the `pi_*` tools.

## Run and connect Codex (Linux and macOS)

1. Build + register — run as the **same user that runs Codex** (and whose `pi` is authenticated):
   ```bash
   cd pi-mcp
   ./install.sh     # npm install + build + install the Codex skill + `codex mcp add pi`
   ```
2. Start the daemon (binds loopback only):
   ```bash
   ./run.sh                                  # foreground, quick test
   sudo ./deploy/linux/install-service.sh    # Linux: systemd system service
   ./deploy/macos/install-daemon.sh          # macOS: launchd user agent
   ```
3. Verify: `curl http://127.0.0.1:8787/internal/health` → `{"ok":true,...}`
4. Restart Codex. It connects, receives the 大总管 instructions, loads the `pi-orchestrator`
   skill, and exposes the `pi_*` tools.

If `codex` is not on PATH, add the server manually to `~/.codex/config.toml` and restart Codex:
```toml
[mcp_servers.pi]
command = "node"            # absolute path recommended
args = ["<abs-path>/pi-mcp/dist/stdio-proxy.js"]

[mcp_servers.pi.env]
PI_MCP_URL = "http://127.0.0.1:8787/mcp"
```
Codex launches the tiny **stdio proxy**, which forwards to the HTTP daemon and auto-reconnects, so a
daemon restart never breaks the Codex session (unlike a direct `url =` connection).

For a non-root Linux user service: run `./deploy/linux/install-service.sh` as that user (installs to
`~/.config/systemd/user/`); run `loginctl enable-linger <user>` once so it starts on boot.

## macOS / remote deployment

The daemon is plain Node + git + HTTP, so it runs on macOS unchanged. Two topologies:

### A. Everything on the Mac (recommended when the repo is on the Mac)
1. Prereqs: **Node >= 22.19**, **git**, and **`pi`** installed + authenticated as the same user.
2. Copy this directory to the Mac (exclude `node_modules`/`dist`):
   `rsync -a --exclude node_modules --exclude dist ./ mac:~/pi-mcp/`
3. On the Mac: `cd ~/pi-mcp && ./install.sh && ./run.sh`
   Codex then connects to `http://127.0.0.1:8787/mcp`. Repos should be cloned on the Mac.

Keep the daemon running as a launchd agent (auto-start on login, restart on crash):
```bash
cd ~/pi-mcp && npm install && npm run build
./deploy/macos/install-daemon.sh      # writes ~/Library/LaunchAgents/com.pimcp.daemon.plist
# logs: ~/.pi-mcp/logs/daemon.{out,err}.log   stop: launchctl bootout gui/$(id -u)/com.pimcp.daemon
```
The LaunchAgent sets a PATH that includes Homebrew and `~/.pi/agent/bin`, so `pi` and `git` resolve.

If `codex` is not on the Mac's PATH (e.g. the desktop app), add the server manually in the app or
in `~/.codex/config.toml`:
```toml
[mcp_servers.pi]
url = "http://127.0.0.1:8787/mcp"
```

### B. Mac Codex -> daemon on another machine (e.g. this Linux box)
Use when the repository and `pi` credentials live on the daemon host and Mac Codex only orchestrates.
Bind to the LAN/VPN and set a token:
```bash
PI_MCP_HOST=0.0.0.0 PI_MCP_TOKEN=<secret> ./run.sh
```
On the Mac:
```bash
PI_MCP_TOKEN=<secret> codex mcp add pi \
  --url http://<daemon-host>:8787/mcp --bearer-token-env-var PI_MCP_TOKEN
```
`pi_diff` / `pi_commit` / `pi_merge` / `pi_push` let Codex review and integrate code that lives on
the daemon host without direct filesystem access. Only expose on a trusted network/VPN; loopback is
the default.

## Tools exposed to Codex

| Tool | Purpose |
|---|---|
| `pi_spawn` | Create worktree+branch, start a worker. Takes a structured `spec{goal, scope[], non_goals[], contracts[], constraints[], task_type}` (goal+scope required and validated); `scope` is pre-claimed so overlapping workstreams are rejected at dispatch; `task_type=design\|security` is blocked unless `spec_override`; `acceptance_files` + `acceptance_command` write Codex-authored tests into the worktree before start and lock them (test-first delegation). |
| `pi_send` | Instruct a worker: `mode=prompt\|steer\|followup`. The 3rd instruction is blocked (two-strikes) unless `override:true`; a retry auto-escalates to the strong model. |
| `pi_wait` | Block until `settled` or until a worker `question`. Re-poll with timeouts ≤ 120s. |
| `pi_status` / `pi_list` | Snapshots: status, model, cost, context, pending questions. |
| `pi_tail` | Incremental transcript (`since=lastEntryId`). |
| `pi_diff` | Committed + uncommitted + untracked changes of a worker branch. |
| `pi_commit` / `pi_merge` / `pi_push` | Commit a worker, merge its branch into the main repo (conflicts returned), push. |
| `pi_answer` | Answer a worker question (`confirmed` / `value` / `cancelled`). |
| `pi_claim` / `pi_release` / `pi_locks` | Manual file claims / inspect conflicts. |
| `pi_message` / `pi_inbox` | Durable mailbox; optional injection into the recipient. |
| `pi_board_post` / `pi_board_read` | Shared blackboard (contracts, ownership, decisions). |
| `pi_stop` | Stop a worker; optionally remove its worktree/branch. |
| `pi_gc` | Reclaim finished work: stop+evict workers, remove clean finished worktrees, and delete only branches proven merged (tip is an ancestor of the repo's current HEAD). Retains abandoned/unfinished, active, dirty, checked-out, current/default, and squash/rebase branches; reports `branches_deleted` + per-branch `branches_retained` reasons. |

Worker-side tools (inside each pi session): `coord_ask`, `coord_send`, `coord_inbox`,
`coord_claim`, `coord_release`, `coord_board_post`, `coord_board_read`, `coord_status`.

## Worker extension behavior

- **Auto-claim**: on `edit`/`write` it claims the target path; on `bash` it heuristically claims
  redirect/`tee`/`sed -i` targets. A conflicting claim blocks the tool with an explanatory reason,
  so the worker coordinates instead of stomping another worker. Lock keys combine the canonical
  Git common directory with a repo-relative path: separate repositories do not collide, while
  symlink aliases and linked worktrees of the same repository still conflict. Absolute paths inside
  a worker's worktree are normalized to the same relative key. Listed locks include `repo` (the
  canonical Git common directory). Manual `pi_claim` / `pi_release` calls can select a `repo`;
  omitting it uses the daemon default repo, while worker sessions always use their own repository.

## Cleanup & branch retention

`pi_gc` reclaims finished work in two steps: it stops/evicts finished workers and removes their
clean worktrees, then deletes the branches of finished workstreams (`success_first`,
`success_second`, `taken_over`) that are **proven merged**.

- **Ancestry criterion**: a branch is deleted only when its tip is an ancestor of the repository's
  current `HEAD` (`git merge-base --is-ancestor`), i.e. its commits are contained in the integrated
  history. Squash- or rebase-integrated branches are *not* ancestors and are retained for manual
  inspection; gc never force-deletes.
- **Historical scope**: candidates come from persisted session metadata, so branches whose worktree
  was already removed (e.g. after a daemon restart) are still reclaimed. Sessions are deduplicated
  per repo+branch, and missing worktrees never block the check.
- **Safety rails**: `abandoned`/unfinished sessions are retained; a branch is never deleted when it
  is the current/default branch, checked out in any worktree, tied to an active session, or tied to
  an existing dirty worktree. These rails hold regardless of `PI_MCP_DELETE_BRANCHES`.
- **Reporting**: gc returns `branches_deleted` (count of actual deletions) and `branches_retained`
  (`{repo, branch, reason}` for each retained candidate). A failed git call retains the branch and is
  reported, never counted as deleted.
- **Closure workflow**: review the full diff, verify the acceptance command, merge, close the
  workstream with `pi_finish`, then run `pi_gc`. Merged finished branches disappear automatically;
  anything retained stays inspectable and can be removed deliberately. Explicit `pi_stop` with
  `delete_branch: true` remains the force-delete escape hatch; gc never uses it.

## Adaptive routing & scoreboard

- **Structured delegation**: `pi_spawn` requires a `spec` with `goal` and `scope` (validated). `scope`
  is pre-claimed at dispatch, so two workstreams with overlapping files are rejected before any code is
  written. `task_type=design|security` is blocked (judgment work stays with Codex).
- **Cheap first, smart on retry**: the first instruction runs on `PI_MCP_MODEL`; the second
  (correction) automatically escalates the worker to `PI_MCP_STRONG_MODEL`. That keeps weak-model
  token spend for the common case and brings in the stronger model exactly when it matters.
- **Two-strikes gate**: after two instructions, `pi_send` refuses a third unless `override:true`.
- **Delegation scoreboard**: close each workstream with `pi_finish` (outcome + `tests_owned_by_codex`)
  and call `pi_report` at task completion for first-try / second-try / taken-over counts and
  percentages.
- **Inbox polling**: every 2.5s it injects unread mailbox messages as follow-ups.
- **Question loop**: `coord_ask` opens a `ctx.ui` dialog which becomes an RPC UI request; the daemon
  surfaces it through `pi_wait`/`pi_status`, and Codex resolves it via `pi_answer`.

## Configuration (env)

| Env | Default | Meaning |
|---|---|---|
| `PI_MCP_HOST` | `127.0.0.1` | Bind address (loopback only). |
| `PI_MCP_PORT` | `8787` | HTTP port for `/mcp` and `/internal/*`. |
| `PI_MCP_PI_BIN` | `pi` | pi executable. |
| `PI_MCP_DEFAULT_REPO` | (none) | Default repo for `pi_spawn`; if unset, every `pi_spawn` must pass `repo`. |
| `PI_MCP_WORKSPACE_ROOT` | `~/.pi-mcp/worktrees` | Where worktrees are created. |
| `PI_MCP_PROVIDER` / `PI_MCP_MODEL` | `deepseek` / `deepseek-flash` | Worker model (first attempt). |
| `PI_MCP_STRONG_MODEL` | `deepseek-v4-pro` | Model a worker is escalated to on a retry. |
| `PI_MCP_THINKING` | `xhigh` | pi thinking level for workers (`off`\|`minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max`). Overridable per spawn via `pi_spawn.thinking`. |
| `PI_MCP_MAX_SESSIONS` | `8` | Hard concurrency cap. |
| `PI_MCP_PARALLEL_WARN` | `4` | Soft parallelism guideline; `pi_spawn` warns at/above this many active workers. |
| `PI_MCP_BASE_REF` | `HEAD` | Branch base for new worktrees. |
| `PI_MCP_AUTO_CLEAN` | `1` | Auto-remove finished workers' worktrees (branches kept). |
| `PI_MCP_WORKTREE_TTL_MIN` | `60` | Minutes a finished+idle worker is kept before the sweeper cleans it. |
| `PI_MCP_DELETE_BRANCHES` | `0` | Default for explicit `pi_stop` `delete_branch` (force-delete; default keeps the branch). `pi_gc` ignores it and only deletes ancestry-proven merged branches. |
| `PI_MCP_TOKEN` | (none) | Optional shared secret for `/mcp` and `/internal/*`. |
| `PI_MCP_DATA_DIR` | `~/.pi-mcp` | Daemon state (locks, mailbox, board, sessions). |

Startup rejects invalid effective settings: ports must be integers from 1 to 65535, session caps
and parallel warning thresholds must be positive safe integers, and TTL must be finite and at
least one minute (fractional minutes are allowed). Numeric env settings use decimal notation;
boolean settings accept only `0` or `1`. Explicit programmatic overrides take precedence.

State is saved by serialized atomic replacement of `state.json`, with the previous validated
snapshot kept in `state.json.bak`. Loading validates the entire snapshot before applying it. A
missing or corrupt primary can recover from a valid backup with a warning on stderr; corruption
without a valid backup, or a filesystem read error, aborts startup instead of resetting history.
Save failures are logged on stderr; a failed shutdown flush exits with a nonzero status. The backup
may lag the primary by one save and does not provide power-loss durability or multi-daemon locking.

## Deployment note (important)

The daemon and Codex should run as the **same Unix user**, and that user must have a working,
authenticated **`pi`** (`~/.pi/agent/auth.json`). Otherwise workers either can't authenticate or
can't write worktrees under the repo's ownership.

- If Codex runs as user X, install/authenticate `pi` for X and run `./run.sh` as X. There is no
  requirement to run as root: any user with a working `pi` and permission to the repo works.

## Testing

```bash
npm ci                    # development/CI: Node >= 22.19
npm run verify            # source + real pi extension API types + full offline tests
npm test                  # build, then run all tests/*.test.mjs (offline, no pi credentials needed)
SMOKE_LIVE=0 ./smoke.sh   # deterministic end-to-end smoke only (no model calls)
./smoke.sh                # same, plus a couple of tiny live model calls
```

`npm test` builds the TypeScript sources and runs the test suite. The offline smoke test boots a
throwaway git repo + daemon and exercises the full control surface (spec linter, task-type gate,
scope overlap, acceptance test-first + lock, committed diff, adaptive escalation, two-strikes gate,
finish/report, restart persistence) against a disposable fake `pi` JSONL RPC, so it needs no
installed/authenticated `pi` and no network or model access. With `SMOKE_LIVE=1` (the default when
unset) the same checks run, but the workers make a couple of tiny real model calls instead of
answering from the fake.

`./smoke.sh` always rebuilds the sources before running the smoke.

GitHub Actions runs `npm ci` and `npm run verify` on pushes and pull requests using Node 22.19.0
and Node 24. The pi API dependency is pinned for development type checking; these checks do not
authenticate or call a model provider.

## Limits

- Live worker processes do not survive a daemon restart: shutting the daemon down stops its
  workers, and after restart you must spawn new sessions (the session JSONL written by workers is
  kept, but the daemon does not automatically restart workers).
