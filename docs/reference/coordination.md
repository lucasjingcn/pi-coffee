# Coordination reference

How workers stay out of each other's way, and where that protection stops.

## File claims

A worker claims a path before writing. The worker extension intercepts `edit`, `write` and `bash`:
on `edit`/`write` it claims the target file; on `bash` it scans the command for literal redirect,
`tee` and `sed -i` targets and claims those. If another worker holds a conflicting claim, the tool
call is blocked and the worker is told who holds it, so it can coordinate instead of trampling the
other change. The extension also blocks `edit`, `write` and `bash` when coordination is unavailable
or invalid — reconnect and retry after resolving the issue. Recognized writes outside the worktree,
including resolved symlink targets, are refused.

Claims are namespaced by the repository's canonical git common directory plus a repo-relative path.
Two checkouts of the same repository — including symlink aliases and linked worktrees — share a
namespace, while unrelated repositories never collide even when file names match. Absolute paths
inside a worker's worktree are normalized to the same relative key before hashing. `pi_claim` and
`pi_release` can target a specific `repo`; without it the daemon default is used, while worker
sessions always use their own repository.

**Claims are coordination protection, not a security sandbox.** They cover recognizable literal
targets; dynamic scripts, variables, command substitution and globs are not fully contained. Digest
and scope checks block invalid results from integration but cannot undo arbitrary script writes.
Untrusted workers require separate OS/container isolation, credential restrictions and appropriate
read-only acceptance mounts; this release does not provide that isolation.

## Mailbox and board

Workers and the orchestrator exchange durable messages (`pi_message` / `pi_inbox`, `coord_send` /
`coord_inbox`) and post shared facts (`pi_board_post` / `pi_board_read`, `coord_board_post` /
`coord_board_read`). Every send returns a read-back receipt (`sha256`, `readBack`) recomputed from
persisted state; a mismatch fails the call rather than claiming delivery.

Broadcasts are recorded per receiver, so a worker reading one does not consume it for the others. An
immediate delivery that succeeds is acknowledged; a failed one stays unread. Protected workers
receive explicitly addressed messages only and exclude global broadcasts, including old persisted
ones.

## Chat isolation

One daemon serves every MCP client configured to use it. Worker ids are global and the daemon does
not receive a trustworthy chat id, so each `pi_spawn` returns a one-time `control_key`; the daemon
stores only its hash and requires the key for worker writes, verification, merge, finish, stop and
cleanup. Keep each key in its originating chat.

The first spawn also returns `scope_key`: pass it to later spawns in the same chat to allow
worker-to-worker messages and a shared board. A worker's internal token is limited to its own session
and that scope rather than the daemon's master token. Keep both keys out of prompts, commits, reports
and user-facing output. `pi_status` / `pi_list` show `control_required`; legacy workers show `false`
and keep their old behavior.

Reads and global audits remain visible to daemon clients, and processes under the same OS user can
access local state. The boundary prevents cross-chat operations through the pi APIs; it is not
host-level access control.

## Audit log

Every coordinator action is appended to a hash-chained audit log under the data directory.
`pi_audit action=verify` recomputes the chain, and the daemon verifies it at startup, logging
`audit chain verified` or `audit chain BROKEN` with the first broken sequence. `GET
/internal/audit/verify` answers the same question over HTTP. Credential-shaped values are redacted
before they reach the log.

## Docker sandbox

Set `PI_COFFEE_SANDBOX=docker` (plus `PI_COFFEE_SANDBOX_IMAGE`) to run verification commands and
workers in containers instead of on the host.

Each verification run gets a fresh container that mounts the candidate at `/workspace`. Each worker
gets a deterministic `pi-coffee-worker-<id>` container that mounts its worktree at `/workspace`, its
session directory at `/session`, and the coordinator extension read-only. Both also mount the git
metadata their checkout points at: a linked worktree's `.git` is a *file* naming
`<repo>/.git/worktrees/<name>`, so a container with only the worktree mounted makes every `git`
command exit 128 (`not a git repository`). The metadata is mounted at the absolute paths git
recorded, which keeps `git rev-parse`, `git diff`, hooks and `git -C subdir` identical to the host.

Only env names in `PI_COFFEE_SANDBOX_ENV_ALLOW` (plus the `PI_COORD_*` handshake) are forwarded; a
worker reaches the daemon through `host.docker.internal`. Containers are removed on stop, failed
startup and restart recovery. A docker request fails closed when the daemon or image is unavailable —
there is no host fallback.

Git metadata is mounted read-write, the same power a host-run command already has: a command inside
a container can rewrite refs or `.git/config`, and one `git worktree prune` there deregisters
worktrees whose checkout it cannot see, exactly as the same command would on the host. The
repository's hook directory is the exception: it is mounted read-only, because hooks planted there
would execute on the host through `pi_commit`/`pi_merge`. Verification itself never runs repository
hooks for the candidate, while `pi_commit` and `pi_merge` still do on every backend, so repository
policy keeps applying to what the daemon commits.

If the docker daemon cannot see the system temp directory (colima shares only `$HOME`; Docker Desktop
shares `$TMPDIR` too), point `PI_COFFEE_VERIFY_TMPDIR` at a shared path: the verification candidate is
bind-mounted, so an invisible temp dir would mount as an empty `/workspace`. Give the sandbox its own
provider credential (or snapshot), and remember that `--network none` means no provider access.

This isolates commands and worker processes, not the daemon. Worker agent directories link the global
`skills`, `prompts`, `themes` and extension directories so a worker sees the same content, which
means a write through a dynamic bash path can reach global configuration too.
