# P0/P1 Implementation and Landing Plan

Status: active · Branch `p0-p1-hardening` (worktree) · Base `7f70ece` · Target `main`
Design source of truth: [p0-p1-development.md](p0-p1-development.md)

This document is the executable plan: milestone order, exact deliverables, acceptance commands,
review obligations, and the pre-merge bug hunt. Every milestone must leave `npm run verify` green and
`main` untouched. `main` is only merged at the end, after the full bug-hunt pass and a clean verify
on the final candidate.

## 0. Ground rules

1. **One milestone per commit series.** Each milestone ends with:
   - `npm run typecheck` green,
   - `npm test` green (offline; no network/model calls),
   - targeted new tests green,
   - `npm run verify` green before moving on (run at least at milestone boundaries and before merge),
   - README (and `README.zh-CN.md`) updated in the same milestone when tools/config change,
   - `CHANGELOG.md` updated under `## [Unreleased]`.
2. **No behavior change by default.** Every feature is opt-in. A default-config daemon must behave
   exactly like `7f70ece`; compat tests assert this.
3. **Fail closed.** Missing evidence, missing sandbox, secret detected, audit append failure, and
   invalid runner handshake all refuse the action instead of degrading silently.
4. **Fakes over mocks.** New external tools (docker, gh, ACP agent) are exercised through small fake
   executables, matching the existing "fake pi" test style.
5. **Never push during development.** Push/PR happens only through the final merge procedure, and
   only after the bug hunt.

## 1. Milestones

Dependencies are strictly ordered; a milestone may not start before its predecessor's `npm run verify`
is green. `Size` is a rough relative estimate (S ≤ half day, M ≤ 1 day, L 1–2 days).

### M1 — Plan documents (this commit) · S
- Add `docs/plans/p0-p1-development.md`, `docs/plans/p0-p1-implementation.md`, link from README
  Development section (EN + zh).
- Acceptance: files exist; `npm run verify` unchanged (docs only).
- Commit: `docs(plans): add P0/P1 evidence, isolation and interop plan`.

### M2 — Secret filter and audit chain · M
- `src/secrets.ts`: pattern classes + `scan()`/`assertNoSecrets()`/`redact()`; unit tests including
  false-positive guards (hashes, base64 payloads, ordinary prose).
- `src/audit.ts`: append-only hash chain, rotation + `.head`, `verifyChain()`; unit tests for
  tamper/truncate/reorder detection.
- Hook `secretPolicy` into mailbox text, board values, and outcome notes; wire the audit log into
  coordinator actions. Strict (fail-closed) appends: spawn, commit, review, verify, merge, finish,
  answer. Best-effort appends that must not add latency to delivery or cleanup: send, mailbox, board,
  stop, gc. Claim/release/drain audit coverage lands with the MCP surface work (M13).
- `AuditLog.close()` drains queued appends; `Coordinator.stopAll()` closes the log so tests and
  shutdown cannot race a late append.
- Config: `PI_COFFEE_SECRET_POLICY`, `PI_COFFEE_AUDIT_MAX_MB`; both documented in README/zh README.
- Acceptance: `node --test tests/secrets.test.mjs tests/audit.test.mjs`; full `npm test` green.
- Commit: `feat(security): secret filter and hash-chained audit log`.

### M3 — Mailbox/board receipts + delivery evidence · S–M
- Canonical payload hashing (`mailboxSha256` / `boardSha256`), `sha256` persisted on messages and
  board entries (optional field: legacy entries keep loading), read-back through a flush + re-read of
  `state.json` with one retry for a racing older save. State writes were already atomic (temp + rename).
- `pi_message` and `/internal/send` return `{delivered, sha256, readBack}`; `pi_board_post` and
  `/internal/board/post` return `{sha256, readBack}`. A missing/tampered entry throws
  `coordination write was not read back` instead of reporting delivery.
- Acceptance: `node --test tests/receipts.test.mjs` (unit + MCP + legacy + tamper cases); full suite.
- Commit: `feat(coordination): read-back receipts for mailbox and board`.

### M4 — Evidence bundle core · M–L
- `src/evidence.ts`: atomic writer (temp dir + rename, manifest last), manifest v1 with file
  sizes/sha256, per-file and total caps with tail truncation, secret redaction, `verifyEvidenceBundle`,
  `listEvidenceBundles`, id and path-escape guards.
- `IntegrationGate.verify`: one `git diff <baseRef>` call for the reviewed patch (worktree is clean),
  plus changed files, stdout/stderr, validator records; writes the bundle before returning and links
  `evidence` (relative dir + manifest sha256) into the verification record.
- `pi_verify` result carries `evidence`; audit entry records the evidence dir and manifest hash.
- Acceptance: `node --test tests/evidence.test.mjs` (manifest round-trip, truncation, redaction,
  tamper detection, path traversal, listing, full daemon verify); full suite stable across repeats.
- Commit: `feat(verify): durable evidence bundles`.

### M5 — Validator chain · M
- `DelegationSpec.validators` (`id`, `command`, `required`, `timeoutMs`, `artifacts`, `env`) with
  validation: unique ids, regex, 16-entry cap, timeout range, relative artifact globs, non-secret env.
  `acceptance_command` is the single-validator default and may not be combined with validators.
- `IntegrationGate` resolves the effective chain, runs it sequentially with per-step and overall
  budgets (the `pi_verify` timeout argument bounds the chain), records every step, continues after a
  failure, and keeps legacy failure text for the single `acceptance` validator.
- Evidence stores `validators/<id>/{stdout,stderr,result.json}` and `artifacts/<id>/...`; declared
  artifact outputs are tolerated by the candidate cleanliness check, other writes still fail it.
- Acceptance: `node --test tests/validators.test.mjs` (ordering, optional failure, required failure,
  timeout kill, artifact capture, spawn ambiguity, spec validation, contract invalidation).
- Commit: `feat(verify): validator chain with per-validator evidence`.

### M6 — Evidence retention + `pi_evidence` tool + merge gate · S–M
- `pruneEvidence` removes expired bundles, keeps the newest `keepPerSession`, and clears stale
  `.tmp-*` directories after one hour; wired into the autoClean sweeper and `pi_gc`
  (`evidence_removed`, `evidence_bytes`).
- `pi_evidence` (`list|get|verify`) with a read-only annotation; `get` returns the manifest, `verify`
  recomputes every file hash.
- `IntegrationGate.assertCurrent` re-reads the recorded bundle (manifest sha256 + all file hashes), so
  `pi_merge` and successful outcomes fail closed when the bundle is missing or modified; legacy
  records without an evidence ref keep working.
- Acceptance: `node --test tests/evidence-mcp.test.mjs` (MCP surface, tamper/missing merge refusal,
  retention/prune); full suite.
- Commit: `feat(evidence): retention, inspection tool and merge gate`.

### M7 — Sandbox phase A (verification commands) · M
- `src/sandbox.ts`: `DockerSandbox` with cached `docker version` + `image inspect` probe, env
  allowlist (host names only), candidate mount at `/workspace`, unique container names, `docker rm -f`
  on timeout, and fail-closed behavior with no host fallback.
- Config: `PI_COFFEE_SANDBOX`/`_IMAGE`/`_NETWORK`/`_ENV_ALLOW`, `PI_COFFEE_DOCKER_BIN`;
  `spec.isolation` requests a backend but cannot bypass daemon policy; spawn probes docker before
  creating a worktree and records `meta.sandbox`.
- `IntegrationGate.verify` runs the validator chain through the sandbox when configured; evidence
  records image, digest and network.
- Acceptance: `node --test tests/sandbox.test.mjs` (5 cases: run/record, probe refusal without a
  worktree, no host fallback, timeout cleanup, isolation policy); full suite.
- Commit: `feat(sandbox): run verification commands in docker`.

### M8 — Sandbox phase B (worker process) · M–L
- `PiRpcClient.spawnPrefix` lets the daemon prepend a container command; `buildWorkerDockerPrefix`
  maps worktree -> `/workspace`, session dir -> `/session`, extension -> read-only mount, forwards
  `PI_COORD_*` (token by env name, never argv) and allowlisted host env names; `PI_COORD_URL` points at
  `host.docker.internal`.
- Manager uses container paths for `--session-dir`/`--extension`/`--session`, clears stale containers
  before resume, and removes the worker container on stop, failed startup and archived recovery.
- Acceptance: `node --test tests/sandbox-worker.test.mjs` (prefix shape, spawn wiring, failed-start
  cleanup, stop cleanup); full suite. A live docker worker run is manual evidence, not CI.
- Commit: `feat(sandbox): run workers in per-session docker containers`.

### M9 — Runner abstraction + fake ACP agent · M–L
- `src/runner.ts` interface; `PiRpcClient` adapted behind it; `src/runner-acp.ts` ACP v1 client;
  `spec.runner` / `PI_COFFEE_RUNNER` / `PI_COFFEE_ACP_COMMAND`; transcript capture.
- `tests/fake-acp-agent.mjs` + `tests/runner-acp.test.mjs`: spawn → prompt → updates → stop.
- Acceptance: `node --test tests/runner-acp.test.mjs`; pi path behavior unchanged.
- Commit: `feat(runner): pluggable runners with ACP support`.

### M10 — PR creation and merge-queue mode · M
- `src/gh.ts` thin wrapper (argv capture, JSON parse, error mapping); `pi_pr` tool; `pi_merge`
  `mode: "merge-queue"`; push authorization `PI_COFFEE_ALLOW_PUSH`; audit entries.
- `tests/fake-gh` + `tests/pr.test.mjs` (create, idempotent existing PR, failure modes).
- Acceptance: `node --test tests/pr.test.mjs`.
- Commit: `feat(integration): PR creation and merge-queue mode`.

### M11 — Dashboard actions · M
- Opt-in write endpoints + token/CSRF/confirm guards; action-capable UI; evidence viewer; diff
  browser improvements; audit entries.
- Acceptance: `node --test tests/dashboard-actions.test.mjs` (auth matrix, disabled-by-default,
  replay/confirm checks).
- Commit: `feat(dashboard): opt-in review and merge actions`.

### M12 — Task DAG (`blocked_by`) · M
- Spec field validation (acyclic, known ids, cap 8); pending blocked session state; dependency
  satisfaction on integration; auto-start scan; `deps_failed` handoff; cancel/stop semantics; restart
  persistence.
- Acceptance: `node --test tests/dag.test.mjs` (chain, fan-out, cycle rejection, failed dependency,
  restart, blocked session never creates a worktree).
- Commit: `feat(scheduling): dependency-aware spawns`.

### M13 — MCP surface hardening + docs · S–M
- `/internal/capabilities`; deterministic tool order test; complete annotations; docs note
  `docs/plans/mcp-2026-07-28.md`; README/zh updates for every new tool/config; docs-consistency test.
- Acceptance: `node --test tests/capabilities.test.mjs tests/docs-consistency.test.mjs`.
- Commit: `feat(mcp): capability endpoint and hardened tool surface`.

### M14 — Release prep · S
- `package.json` 0.3.0; CHANGELOG 0.3.0 section (Added/Changed/Security/Verification); README
  "Dashboard, metrics and upgrades" + "Cleaning up finished work" + "Configuration" refresh;
  `docs/integrations/dsh.md` touch-up if tool list changed.
- Acceptance: `npm run verify` + `node scripts/smoke.mjs`.
- Commit: `chore(release): 0.3.0`.

### M15 — Pre-merge bug hunt and merge · M
- Full checklist below, fixes as separate commits, final verify, merge into `main`, push.
- No feature work in this milestone.

## 2. Acceptance commands per milestone

| Milestone | Command |
| --- | --- |
| M1 | `npm run verify` |
| M2 | `node --test tests/secrets.test.mjs tests/audit.test.mjs` + `npm run verify` |
| M3 | `node --test tests/receipts.test.mjs` + `npm run verify` |
| M4 | `node --test tests/evidence.test.mjs` + `npm run verify` |
| M5 | `node --test tests/validators.test.mjs` + `npm run verify` |
| M6 | `node --test tests/evidence-retention.test.mjs tests/evidence-mcp.test.mjs` + `npm run verify` |
| M7 | `node --test tests/sandbox.test.mjs` + `npm run verify` |
| M8 | `node --test tests/sandbox-worker.test.mjs` + `npm run verify` |
| M9 | `node --test tests/runner-acp.test.mjs` + `npm run verify` |
| M10 | `node --test tests/pr.test.mjs` + `npm run verify` |
| M11 | `node --test tests/dashboard-actions.test.mjs` + `npm run verify` |
| M12 | `node --test tests/dag.test.mjs` + `npm run verify` |
| M13 | `node --test tests/capabilities.test.mjs tests/docs-consistency.test.mjs` + `npm run verify` |
| M14 | `npm run verify` + `node scripts/smoke.mjs` |
| M15 | `npm run verify` + `node scripts/smoke.mjs` + manual checklist |

`npm run verify` = ensure-deps + typecheck + extension typecheck + full offline suite + playbook
consistency. Any red blocks the milestone.

## 3. Pre-merge bug hunt (M15 checklist)

Run each item against the final branch. Record evidence (command + output) in the PR/merge note.

**Evidence and validators**
- [ ] Manifest sha256 matches after a full daemon restart; merge refuses a missing or byte-edited manifest.
- [ ] Path traversal: `sessionId`/`verificationId`/artifact names containing `..`, absolute paths, NUL → rejected.
- [ ] Symlinked artifact inside candidate pointing outside → rejected, not copied.
- [ ] Size caps: oversized stdout/artifact truncated with `truncated` marker; no silent loss.
- [ ] Secret in stdout/validator output under `reject` → verification fails; under `redact` → manifest counts redactions.
- [ ] Concurrent `pi_verify` for the same session → one wins, the other is rejected without corrupting state.
- [ ] Verify while the sweeper/GC runs → no partial bundle referenced by a merge.
- [ ] Validator timeout, non-zero exit, missing required validator → correct evidence + merge refusal.
- [ ] Legacy `acceptance_command`-only session behaves byte-identically to `7f70ece` (golden test).

**Sandbox**
- [ ] Docker missing while `PI_COFFEE_SANDBOX=docker` → fail closed with actionable error; no host fallback.
- [ ] Container name collisions (same session resume) → stale container removed/refused.
- [ ] Env allowlist: `HOME`, `SSH_AUTH_SOCK`, `GH_TOKEN`, cloud creds never passed (assert on docker argv).
- [ ] Mounts limited to worktree/agent dir/candidate (assert on docker argv).
- [ ] Timeout/cancel kills the container (`docker rm -f`), no orphan containers after stop/daemon restart.
- [ ] Worker transcript + evidence still captured from inside the container.
- [ ] `--network none` documented behavior: worker model call fails with a clear handoff notice.

**Coordination and audit**
- [ ] Read-back mismatch simulated (state store throws after write) → call fails, no ghost entry.
- [ ] Audit chain: edit/reorder/delete/truncate → `pi_audit verify` reports the first broken seq.
- [ ] Secret patterns: `sk-`, `ghp_`, `AKIA`, JWT, private key blocks rejected; hashes/base64 prose not false-positived.
- [ ] Mailbox/board/outcome notes cannot persist secrets (grep the state file in the test).
- [ ] Every state-changing tool produces exactly one audit entry (snapshot test).

**Runners / PR**
- [ ] `PI_COFFEE_RUNNER=pi` (default) unchanged: existing suite green.
- [ ] Fake ACP agent: handshake failure, malformed frame, cancel mid-prompt, permission request mapping.
- [ ] `pi_pr` idempotent (existing PR reused), no push when `PI_COFFEE_ALLOW_PUSH=0`, token never printed.
- [ ] `merge-queue` mode: PR not found, gh missing, auth failure, merge refused → integration record not written.
- [ ] PR body contains evidence hashes, not secrets or absolute host paths that leak credentials.

**Dashboard / DAG / MCP surface**
- [ ] Dashboard actions disabled by default; enabled without token → startup error.
- [ ] Wrong/missing token, missing confirm header, cross-origin request → 401/403, no action, audit records denial.
- [ ] Repeat merge/finish request (replay) → idempotent rejection, no double outcome.
- [ ] DAG: self-dep, cycle, unknown id rejected at spawn; dependency abandoned → `deps_failed`; restart keeps blocked state; blocked spawn creates no worktree.
- [ ] `/internal/capabilities` matches registered tools (snapshot test); token-protected when configured.
- [ ] Tool annotations complete and accurate (read-only tools never listed as destructive).

**Backward compatibility / release**
- [ ] Old `state.json` (v1) loads, migrates, and a restart round-trips without data loss (fixture test).
- [ ] `node scripts/smoke.mjs` passes; `PI_COFFEE_SANDBOX=worktree` default path used.
- [ ] README + zh README tool/config tables match code (docs-consistency test).
- [ ] CHANGELOG 0.3.0 accurately lists defaults and opt-ins; upgrade note for schema v2.
- [ ] No debug prints, no hardcoded local paths, no secrets in fixtures (`grep -R "sk-" tests/` clean).

## 4. Merge procedure

1. **Freeze:** no commits after the final verify except bug-hunt fixes; each fix reruns its targeted
   test and the full `npm run verify`.
2. **Rebase check:** `git fetch origin && git merge origin/main` into `p0-p1-hardening` (worktree),
   resolve, rerun `npm run verify`.
3. **Final evidence pack:** collect verify output, smoke output, bug-hunt checklist results into the
   merge note; `git log --oneline main..p0-p1-hardening` must be a clean, reviewable series.
4. **Merge:** from the main checkout (`/Users/lucasjing/code/pi-coffee`), `git merge --no-ff
   p0-p1-hardening`, then `npm run verify` on `main` again (post-merge verification), then `git push
   origin main`.
5. **Post-merge:** `git worktree remove` the hardening worktree, delete the branch only after push,
   confirm `git status` clean and remote HEAD equals local.
6. **Rollback:** before push, `git reset --hard 7f70ece` on `main` loses nothing (branch still has
   work). After push, revert merge commit `git revert -m 1 <sha>`; evidence bundles are additive and
   safe to leave; state schema v2 is forward-only, so a downgrade requires deleting `state.json`
   after exporting history — documented in CHANGELOG.

## 5. Commit conventions

- `feat(<area>): ...` / `fix(<area>): ...` / `test(...)` / `docs(...)` / `chore(release)`.
- One milestone per feature commit; tests and docs in the same commit as the code they describe.
- No merge commits inside the branch except the final rebase merge from `main`.

## 6. Progress log

- **M1 complete** — 2026-11-01: design + implementation plans added, README/zh linked, CHANGELOG
  `[Unreleased]` created.
- **M2 complete** — 2026-11-01: `src/secrets.ts` (7 pattern classes, reject/redact policy),
  `src/audit.ts` (hash chain, rotation, head sidecar, tamper/truncate detection, drain/close),
  coordinator hooks, config keys, README config rows, 15 new offline tests; full suite 374/374.
- **M3 complete** — 2026-11-01: canonical `sha256` on mailbox/board entries, read-back receipts in
  `pi_message` / `pi_board_post` / internal endpoints, legacy entries still verify, tamper and missing
  entries fail closed; 7 new tests; full suite 381/381.
- **M4 complete** — 2026-11-01: evidence bundle writer + verifier, daemon verification links the
  bundle, config keys and README rows, 8 new tests; load-sensitive RPC/smoke test bounds hardened
  (baseline `main` also flakes under this host's load, verified separately); full suite 389/389
  three consecutive runs.
- **M5 complete** — 2026-11-01: validator chain (`spec.validators`) with per-step/overall budgets,
  artifact capture, legacy compatibility and spec validation; 8 new tests; test-file concurrency
  lowered to 2 to keep host-loaded runs stable; full suite 397/397 three consecutive runs.
- **M6 complete** — 2026-11-01: evidence retention (TTL + keep-per-session + stale temp cleanup),
  `pi_evidence` MCP tool, and merge/outcome integrity checks against the recorded bundle; 4 new
  tests; full suite 401/401 twice.
- **M7 complete** — 2026-11-01: Docker sandbox phase A for verification commands (probe, mounts, env
  allowlist, timeout cleanup, fail-closed policy, evidence record); 5 new tests; full suite 406/406.
- **M8 complete** — 2026-11-01: worker containers (spawn prefix, container paths, token-by-env-name,
  stale-container cleanup, stop/startup-failure/recovery removal); 4 new tests; full suite 410/410.
