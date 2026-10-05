import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Coordinator, SessionMeta } from "./manager.js";
import type { DelegationSpec } from "./types.js";
import { WORKSTREAM_PURPOSES } from "./types.js";
import { validateReviewSpec } from "./candidate-review.js";
import { MCP_INSTRUCTIONS, PLAYBOOK } from "./playbook.js";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], isError: true };
}

/** Two-strikes: initial task + one correction. The next instruction is blocked by default. */
const MAX_DELEGATED_ATTEMPTS = 2;

/** Task classifications Codex must assign; judgment types must not be delegated. */
const TASK_TYPES = ["mechanical", "feature", "refactor", "debug", "design", "security"] as const;
const JUDGMENT_TYPES = new Set(["design", "security"]);

/** Trim a session snapshot to the fields Codex actually needs over MCP. */
function compactMeta(m: SessionMeta) {
  return {
    id: m.id,
    name: m.name,
    status: m.status,
    branch: m.branch,
    worktree: m.worktree,
    model: m.model,
    provider: m.provider,
    cost: m.cost,
    context: m.context,
    turns: m.turns ?? 0,
    instructions_sent: m.instructionsSent ?? 0,
    outcome: m.outcome ?? "unrecorded",
    control_required: m.controlKeyHash !== undefined,
    purpose: m.spec?.purpose ?? "unspecified",
    tests_owned_by_codex: m.testsOwnedByCodex ?? null,
    output_tokens: m.tokens?.output ?? 0,
    lastEntryId: m.lastEntryId,
    lastText: m.lastText,
    extension: m.extension ?? false,
    acceptance: m.acceptance ?? null,
    verification: m.verification ?? null,
    reviewAcceptance: m.reviewAcceptance ?? null,
    candidateReview: m.candidateReview ?? null,
    integration: m.integration ?? null,
    spec: m.spec ?? null,
    pendingQuestions: m.pendingQuestions.map((q) => ({
      id: q.id,
      method: q.method,
      title: q.title,
      message: q.message,
      options: q.options,
    })),
    error: m.error,
    handoff: m.handoff,
    shutdown_unconfirmed: m.shutdownUnconfirmed ?? false,
    recovery: m.handoff ? { worktree: m.worktree, branch: m.branch, report_available: !!m.lastText } : undefined,
  };
}

type Detail = "summary" | "full";

/** Routine polling keeps actionable state without replaying contracts and transcripts. */
export function summaryMeta(m: SessionMeta) {
  return {
    id: m.id,
    name: m.name,
    status: m.status,
    purpose: m.spec?.purpose ?? "unspecified",
    outcome: m.outcome ?? "unrecorded",
    control_required: m.controlKeyHash !== undefined,
    turns: m.turns ?? 0,
    cost: m.cost,
    output_tokens: m.tokens?.output ?? 0,
    instructions_sent: m.instructionsSent ?? 0,
    verified: m.verification?.passed ?? false,
    review_accepted: m.reviewAcceptance !== undefined,
    candidate_reviewed: !!m.candidateReview && m.candidateReview.verificationId === m.verification?.id,
    candidate_review_required: !!m.spec?.requirements?.length || !!m.verification?.existingValidationChanges?.length,
    integrated: m.integration !== undefined,
    pendingQuestions: m.pendingQuestions,
    error: m.error,
    handoff: m.handoff,
    shutdown_unconfirmed: m.shutdownUnconfirmed ?? false,
    recovery: m.handoff ? { worktree: m.worktree, branch: m.branch, report_available: !!m.lastText } : undefined,
  };
}

function sessionView(m: SessionMeta, detail: Detail) {
  return detail === "full" ? compactMeta(m) : summaryMeta(m);
}

function auditBoard(m: SessionMeta): string {
  return m.scopeKeyHash ? `${m.scopeKeyHash}:pi-coffee` : "pi-coffee";
}

/** Full cost evidence belongs to pi_metrics; the scoreboard needs only coverage. */
export function summaryReport(report: Record<string, unknown>, detail: Detail = "summary") {
  if (detail === "full") return report;
  const evidence = report.cost_evidence as Record<string, unknown> | undefined;
  if (!evidence) return report;
  const worker = evidence.worker as Record<string, unknown> | undefined;
  const orchestrator = evidence.orchestrator as Record<string, unknown> | undefined;
  const combined = evidence.combined as Record<string, unknown> | undefined;
  return {
    ...report,
    cost_evidence: {
      selected_session_ids: evidence.selected_session_ids,
      unknown_session_ids: evidence.unknown_session_ids,
      worker: worker && {
        currency: worker.currency,
        total: worker.total,
        complete: worker.complete,
        missing_session_ids: worker.missing_session_ids,
      },
      orchestrator: orchestrator && {
        currency: orchestrator.currency,
        total: orchestrator.total,
        complete: orchestrator.complete,
        missing_session_ids: orchestrator.missing_session_ids,
      },
      combined: combined && {
        currency: combined.currency,
        total: combined.total,
        complete: combined.complete,
        reasons: combined.reasons,
      },
    },
  };
}

export function buildServer(coord: Coordinator): McpServer {
  const server = new McpServer(
    { name: "pi-coffee", version: "0.1.0" },
    { instructions: MCP_INSTRUCTIONS },
  );

  server.registerPrompt(
    "orchestrate",
    {
      title: "pi-coffee orchestrator playbook",
      description:
        "Load the full playbook for acting as the general manager over pi worker sessions (delegation, review, integration).",
    },
    () => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: PLAYBOOK } }],
    }),
  );

  // -------------------------------------------------------------------------
  // Delegation lifecycle
  // -------------------------------------------------------------------------

  server.registerTool(
    "pi_spawn",
    {
      title: "Spawn a pi worker session",
      description:
        "Create an isolated git worktree + branch and start a long-lived pi coding session in it. Returns a one-time control_key; retain it in this chat for later worker writes. It is never shown by list/status/report.",
      inputSchema: {
        task: z.string().optional().describe("Short task label (used in the session/branch name)"),
        repo: z.string().optional().describe("Repository path (defaults to daemon config)"),
        name: z.string().optional(),
        baseRef: z.string().optional().describe("Base ref/commit to branch from (default HEAD)"),
        branch: z.string().optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        thinking: z
          .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe("pi thinking level for this worker (default: PI_COFFEE_THINKING, xhigh). Lower it for purely mechanical work."),
        prompt: z.string().optional().describe("Optional first instruction to send immediately"),
        scope_key: z.string().min(1).optional().describe("Pass a prior pi_spawn scope_key to let this chat's workers coordinate with one another"),
        spec: z
          .object({
            goal: z.string().describe("One unambiguous sentence: what must be true when done"),
            scope: z.array(z.string()).describe("Worktree-relative paths the worker may touch"),
            non_goals: z.array(z.string()).optional(),
            contracts: z.array(z.string()).optional(),
            constraints: z.array(z.string()).optional(),
            task_type: z.enum(TASK_TYPES).optional(),
            purpose: z.enum(WORKSTREAM_PURPOSES).optional().describe("Assigned work: implementation, read-only review, or investigation. Missing purpose is reported as unspecified, never inferred."),
            requirements: z.array(z.object({id: z.string().trim().min(1), text: z.string().min(1)})).optional()
              .describe("Coordinator-authored hard requirements with unique IDs; each needs met=true and evidence in pi_review before merge."),
            validation_paths: z.array(z.string()).optional()
              .describe("Additional worktree-relative validation files/directories; edits to existing definitions need per-file pi_review approval."),
          })
          .optional()
          .describe("Structured task contract. Required: goal, scope. Rendered into the worker prompt."),
        spec_override: z
          .boolean()
          .optional()
          .describe("Force delegating a design/security task (requires spec_override_reason)"),
        spec_override_reason: z.string().optional(),
        acceptance_files: z
          .array(z.object({ path: z.string().describe("Worktree-relative path"), content: z.string() }))
          .optional()
          .describe(
            "Coordinator-authored acceptance files written before startup. Advisory locks plus content hashes protect integration; this is not an OS sandbox.",
          ),
        acceptance_command: z.string().optional().describe("Fixed acceptance command executed by pi_verify against the merged candidate; required for verification/integration"),
      },
    },
    async (args) => {
      const spec = args.spec as DelegationSpec | undefined;
      validateReviewSpec(spec);

      // Spec linter: a structured spec must carry goal + scope, and a delegation
      // must carry either a spec or a prompt.
      if (spec) {
        const missing: string[] = [];
        if (!spec.goal || !spec.goal.trim()) missing.push("goal");
        if (!spec.scope || spec.scope.length === 0) missing.push("scope");
        if (missing.length) {
          return errorJson({
            error: "incomplete task spec",
            missing,
            required: { goal: "one unambiguous sentence", scope: ["worktree-relative paths the worker may touch"] },
            example: {
              goal: "Add input validation to createUser so empty email is rejected with 400",
              scope: ["src/users/create.ts", "tests/users/create.test.ts"],
              non_goals: ["do not change the HTTP router"],
              contracts: ["createUser(input): Promise<User>", "throws ValidationError on bad input"],
              constraints: ["no new dependencies"],
              task_type: "feature",
            },
          });
        }
      }
      if (!spec && !args.prompt) {
        return errorJson({
          error: "provide a task spec or a prompt",
          hint: "Prefer spec{goal,scope,acceptance_files,...}; a bare prompt is the simplified path for trivial work.",
        });
      }

      const controlKey = randomBytes(32).toString("base64url");
      const scopeKey = args.scope_key ?? controlKey;
      const scopeHash = createHash("sha256").update(scopeKey).digest("hex");

      // Judgment work stays with Codex unless explicitly overridden with a reason.
      const taskType = spec?.task_type;
      if (taskType && JUDGMENT_TYPES.has(taskType) && !args.spec_override) {
        return errorJson({
          blocked: true,
          rule: "no-delegate-judgment",
          task_type: taskType,
          reason: `${taskType} work is judgment work and must not be delegated.`,
          do_this_instead: [
            "Do it yourself (preferred).",
            "If it truly must be delegated, pass spec_override:true with spec_override_reason.",
          ],
        });
      }
      if (taskType && JUDGMENT_TYPES.has(taskType) && args.spec_override) {
        coord.boardPost(
          `${scopeHash}:pi-coffee`,
          "judgment-override",
          `${args.task ?? spec?.goal}: ${args.spec_override_reason ?? "(no reason given)"}`,
          "codex",
        );
      }

      const warnings: string[] = [];
      if (!spec?.purpose) {
        warnings.push("no spec.purpose provided: this workstream will be reported as unspecified, not implementation");
      }
      if (!args.acceptance_files?.length) {
        warnings.push("no acceptance_files provided: test-first delegation is strongly recommended");
      }
      const activeWorkers = coord.activeWorkers();
      if (activeWorkers >= coord.config.parallelWarnThreshold) {
        warnings.push(
          `high parallelism: ${activeWorkers} workers already active (guideline <= ${coord.config.parallelWarnThreshold}). Integrate/merge before spawning more; over-parallelizing raises integration cost and lowers review quality.`,
        );
      }

      const meta = await coord.spawn({
        task: args.task,
        repo: args.repo,
        name: args.name,
        baseRef: args.baseRef,
        branch: args.branch,
        model: args.model,
        provider: args.provider,
        thinking: args.thinking,
        prompt: args.prompt,
        spec,
        acceptanceFiles: args.acceptance_files,
        acceptanceCommand: args.acceptance_command,
        controlKeyHash: createHash("sha256").update(controlKey).digest("hex"),
        scopeKeyHash: scopeHash,
        controlKey,
        scopeKey,
      });

      const out: Record<string, unknown> = { ...compactMeta(meta), control_key: controlKey, scope_key: scopeKey };
      if (warnings.length) out.warnings = warnings;

      // Advisory: small, single-file, no-acceptance work usually costs more to delegate than to do.
      const scopeLen = spec?.scope?.length ?? 0;
      if (scopeLen <= 1 && !args.acceptance_files?.length && (args.prompt?.length ?? 0) < 400) {
        out.hint =
          "This looks small/localized. Delegation overhead (spec + acceptance + review + verify) may exceed the work you offloaded - next time consider doing small fixes yourself.";
      }
      return json(out);
    },
  );

  server.registerTool(
    "pi_send",
    {
      title: "Send an instruction to a pi worker",
      description:
        "Deliver a message to a running worker. mode=prompt starts a turn (auto-queued as follow-up if busy); mode=steer interrupts after the current tool batch; mode=followup waits until the worker is otherwise done. TWO-STRIKES GATE: after 2 instructions to the same session, further sends are blocked unless override:true — take the work over yourself instead.",
      inputSchema: {
        session_id: z.string(),
        control_key: z.string().optional(),
        message: z.string(),
        mode: z.enum(["prompt", "steer", "followup"]).optional(),
        model: z.string().optional().describe("Override the worker model for this instruction"),
        provider: z.string().optional(),
        override: z
          .boolean()
          .optional()
          .describe("Force a third+ instruction despite the two-strikes gate (requires override_reason)"),
        override_reason: z.string().optional().describe("Why another delegated attempt is justified"),
      },
    },
    async ({ session_id, control_key, message, mode, model, provider, override, override_reason }) => {
      coord.assertControl(session_id, control_key);
      const snap = coord.snapshot(session_id);
      const sent = snap.instructionsSent ?? 0;

      if (sent >= MAX_DELEGATED_ATTEMPTS && !override) {
        return errorJson({
          blocked: true,
          rule: "two-strikes",
          instructions_sent: sent,
          reason: `${sent} instructions already sent to ${session_id} without meeting the acceptance criteria.`,
          do_this_instead: [
            "Do the work yourself (preferred).",
            "If it is genuinely too large, spawn ONE worker with an explicit stronger model" +
              (coord.config.strongModel
                ? ` ("${coord.config.strongModel}")`
                : " (pass a model id you trust to pi_spawn)") +
              " and the concrete failures and evidence, then verify hard.",
            "To insist on another delegated correction anyway, call pi_send with override:true and override_reason.",
          ],
        });
      }

      if (sent >= MAX_DELEGATED_ATTEMPTS && override) {
        coord.boardPost(
          auditBoard(snap),
          "delegation-override",
          `${session_id}: ${override_reason ?? "(no reason given)"}`,
          "codex",
        );
      }

      // Model routing: the worker stays on its spawn model unless Codex explicitly
      // passes `model`. Automatic escalation is DISABLED (owner decision): never
      // silently switch to a costlier model.
      const useModel = model ?? undefined;
      await coord.send(session_id, message, mode ?? "prompt", true, { provider, model: useModel });

      return json({
        ok: true,
        session_id,
        mode: mode ?? "prompt",
        instructions_sent: sent + 1,
        overridden: sent >= MAX_DELEGATED_ATTEMPTS,
        escalated_to: null,
      });
    },
  );

  server.registerTool(
    "pi_wait",
    {
      title: "Wait for workers",
      description:
        "Block until all listed sessions settle (until=settled), any worker asks a question (until=question), or a new daemon handoff notice requires attention. Returns concise snapshots by default. " +
        "The default wait window is 30000ms; expiry does not stop workers or mean task failure. Keep the wait below the outer script/client/transport deadline with headroom. " +
        "With a 60s outer deadline, use 30000ms and only one blocking wait per codemode script; re-poll in a new codemode call. " +
        "Longer waits (up to 120000ms) require sufficient outer deadline headroom. Use pi_status/pi_list for non-blocking snapshots.",
      inputSchema: {
        session_ids: z.array(z.string()).min(1),
        until: z.enum(["settled", "question"]).optional(),
        timeout_ms: z.number().int().min(0).max(120_000).optional()
          .describe("Wait window in milliseconds (default 30000; 0 does not wait). Keep below the outer script/client/transport deadline with headroom; use longer windows only when the client supports them."),
        detail: z.enum(["summary", "full"]).optional(),
        after_notice_ids: z.array(z.string()).optional().describe("Previously consumed handoff notice IDs; new notices wake this wait even if workers are still working"),
      },
    },
    async ({ session_ids, until, timeout_ms, detail, after_notice_ids }) => {
      const res = await coord.wait(session_ids, until ?? "settled", Math.min(timeout_ms ?? 30_000, 120_000), after_notice_ids);
      return json({
        timedOut: res.timedOut,
        sessions: res.sessions.map((m) => sessionView(m, detail ?? "summary")),
        ...(res.timedOut ? {
          wait_hint: "Wait window expired; this does not stop workers or indicate task failure. Inspect returned statuses and handoff notices, then continue waiting for active workers in a new call. Do not stop or re-spawn workers solely because this wait expired.",
        } : {}),
      });
    },
  );

  server.registerTool("pi_recover_control", {
    title: "Recover this scope's worker control",
    description: "Explicitly recover a persisted worker control key using this chat's scope_key. Does not expose other scopes or legacy credentials; if both keys were lost, use the protected local worker-control CLI. Never display recovered keys to users.",
    inputSchema: { session_id: z.string(), scope_key: z.string().min(1) },
  }, async ({ session_id, scope_key }) => {
    const keys = await coord.recoverControl(session_id, scope_key);
    return json({ session_id, control_key: keys.controlKey, scope_key: keys.scopeKey });
  });

  server.registerTool(
    "pi_stop",
    {
      title: "Stop a worker",
      description: "Stop an unfinished worker early, optionally recording an outcome and removing its git worktree/branch. pi_finish already stops completed workstreams.",
      inputSchema: {
        session_id: z.string(),
        control_key: z.string().optional(),
        remove_worktree: z.boolean().optional(),
        preserve_worktree: z.boolean().optional().describe("Preserve files and checkout even when automatic cleanup is enabled"),
        delete_branch: z.boolean().optional().describe("Also delete the worker branch (default false: keep it)"),
        outcome: z
          .enum(["success_first", "success_second", "taken_over", "abandoned"])
          .optional()
          .describe("Final disposition for the delegation scoreboard"),
        note: z.string().optional(),
      },
    },
    async ({ session_id, control_key, remove_worktree, preserve_worktree, delete_branch, outcome, note }) => {
      coord.assertControl(session_id, control_key);
      if (outcome) await coord.setOutcome(session_id, outcome, note);
      if (!outcome || remove_worktree) {
        await coord.stop(session_id, { removeWorktree: remove_worktree ?? false, deleteBranch: delete_branch, preserveWorktree: preserve_worktree });
      }
      return json({ ok: true, session_id, outcome: outcome ?? coord.snapshot(session_id).outcome ?? "unrecorded" });
    },
  );

  server.registerTool(
    "pi_resume",
    {
      title: "Resume a stopped worker on its own transcript",
      description:
        "Restart a stopped, unfinished worker with the conversation it already has instead of re-dispatching. Keeps its worktree, branch, spec, acceptance record and control key; clears stale verification/review evidence. Refuses when the session already has an outcome, when a shutdown is unconfirmed, or when its transcript, agent directory or worktree is gone. The contract is already in the transcript and is not re-sent: pass prompt only for an explicit nudge.",
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        session_id: z.string(),
        control_key: z.string().optional(),
        prompt: z.string().optional().describe("Optional instruction to send once the worker is back up"),
        provider: z.string().optional(),
        model: z.string().optional().describe("Override the model (default: the session's own model, then the daemon default)"),
        thinking: z
          .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe("pi thinking level for the resumed worker (default: PI_COFFEE_THINKING)"),
      },
    },
    async ({ session_id, control_key, prompt, provider, model, thinking }) => {
      coord.assertControl(session_id, control_key);
      const meta = await coord.resume(session_id, { prompt, provider, model, thinking });
      return json({
        ok: true,
        ...compactMeta(meta),
        note: "continued the existing transcript; earlier verification and review evidence was cleared",
      });
    },
  );

  server.registerTool(
    "pi_finish",
    {
      title: "Close a workstream with an outcome",
      description:
        "Record the final disposition and stop the worker. Implementation success/takeover requires verification and integration; read-only review/investigation success requires a settled worker report, no worktree changes, and an acceptance note. Archived unfinished sessions may only be marked abandoned.",
      inputSchema: {
        session_id: z.string(),
        control_key: z.string().optional(),
        outcome: z.enum(["success_first", "success_second", "taken_over", "abandoned"]),
        note: z.string().optional(),
        tests_owned_by_codex: z
          .boolean()
          .optional()
          .describe("True if the acceptance test was authored from the spec and owned by you, not the worker"),
      },
    },
    async ({ session_id, control_key, outcome, note, tests_owned_by_codex }) => {
      coord.assertControl(session_id, control_key);
      await coord.setOutcome(session_id, outcome, note);
      if (tests_owned_by_codex !== undefined) coord.setTestsOwned(session_id, tests_owned_by_codex);
      return json({
        ok: true,
        session_id,
        outcome,
        tests_owned_by_codex: tests_owned_by_codex ?? null,
        instructions_sent: coord.snapshot(session_id).instructionsSent ?? 0,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  server.registerTool(
    "pi_status",
    {
      title: "Worker status",
      description: "Get concise status and pending questions for one or all sessions. Use detail=full for contracts, transcript excerpt, verification and integration records; pi_metrics provides full cost evidence.",
      inputSchema: { session_id: z.string().optional(), detail: z.enum(["summary", "full"]).optional() },
    },
    async ({ session_id, detail }) => {
      const view = detail ?? "summary";
      if (session_id) return json(sessionView(coord.snapshot(session_id), view));
      return json({ sessions: coord.list().map((m) => sessionView(m, view)),
        ...(view === "full" ? { metrics: await coord.metrics() } : {}) });
    },
  );

  server.registerTool(
    "pi_metrics",
    {
      title: "Output-discipline metrics",
      description:
        "Report cost evidence for active and historical workers, including failures. Unknown costs remain unknown. Orchestrator costs need explicit source records; output volume is not savings evidence.",
      annotations: { readOnlyHint: true },
      inputSchema: { session_ids: z.array(z.string()).min(1).optional() },
    },
    async ({ session_ids }) => json(await coord.metrics(session_ids)),
  );

  server.registerTool("pi_record_cost", {
    title: "Record orchestrator cost evidence",
    description: "Register a sourced orchestrator cost for explicit sessions. Use a stable record id; identical repeats are idempotent and conflicting repeats fail. Never invent missing usage or savings.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: { id: z.string().min(1), amount: z.number().finite().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/),
      source: z.enum(["manual", "estimate", "provider"]), reference: z.string().min(1), session_ids: z.array(z.string()).min(1),
      control_keys: z.record(z.string()).optional() },
  }, async ({ control_keys, ...record }) => {
    for (const id of record.session_ids) coord.assertControl(id, control_keys?.[id]);
    return json(coord.recordCost(record));
  });

  server.registerTool(
    "pi_tail",
    {
      title: "Tail a worker transcript",
      description:
        "Incrementally read session entries. Pass the lastEntryId from a previous call as `since` to get only new entries (cheap polling).",
      inputSchema: {
        session_id: z.string(),
        since: z.string().optional(),
        max: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ session_id, since, max }) => {
      const res = await coord.tail(session_id, since, max ?? 30);
      return json(res);
    },
  );

  server.registerTool(
    "pi_diff",
    {
      title: "Worker diff",
      description: "Show the worker branch's committed changes since base plus uncommitted edits, for integration decisions.",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => json(await coord.diff(session_id)),
  );

  server.registerTool(
    "pi_list",
    { title: "List workers", description: "List concise worker states. Supply session_ids to inspect only your workstreams, including stopped history; use detail=full for complete records.",
      inputSchema: { session_ids: z.array(z.string()).min(1).optional(), detail: z.enum(["summary", "full"]).optional() } },
    async ({ session_ids, detail }) => {
      const sessions = session_ids === undefined ? coord.list() : [...new Set(session_ids)].map((id) => coord.snapshot(id));
      return json({ sessions: sessions.map((m) => sessionView(m, detail ?? "summary")) });
    },
  );

  server.registerTool(
    "pi_report",
    {
      title: "Delegation scoreboard",
      description:
        "Report concise outcomes by purpose, takeover reasons, cost coverage, and inconsistent recorded successes. Supply session_ids to scope a chat's workstreams; omit it only for global audit. Use detail=full for complete evidence; pi_metrics gives full per-session costs.",
      inputSchema: { session_ids: z.array(z.string()).min(1).optional(), detail: z.enum(["summary", "full"]).optional() },
    },
    async ({ session_ids, detail }) => json(summaryReport(await coord.report(session_ids), detail ?? "summary")),
  );

  // -------------------------------------------------------------------------
  // Integration
  // -------------------------------------------------------------------------

  server.registerTool(
    "pi_commit",
    {
      title: "Commit a worker's changes",
      description: "Stage and commit all changes in a worker's worktree. Use before merging.",
      inputSchema: { session_id: z.string(), control_key: z.string().optional(), message: z.string() },
    },
    async ({ session_id, control_key, message }) => {
      coord.assertControl(session_id, control_key);
      return json({ result: await coord.commit(session_id, message) });
    },
  );

  server.registerTool(
    "pi_verify",
    {
      title: "Verify the exact integration candidate",
      description: "Execute the registered acceptance command in an isolated merged candidate. Requires settled worker, committed scoped changes, unchanged acceptance files and clean checked-out target. Worker/target changes or restart invalidate evidence; pi_exec is not verification.",
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: { session_id: z.string(), control_key: z.string().optional(), into: z.string().optional(), timeout_ms: z.number().int().min(1000).max(1_800_000).optional() },
    },
    async ({ session_id, control_key, into, timeout_ms }) => {
      coord.assertControl(session_id, control_key);
      const proof = await coord.verify(session_id, into, timeout_ms);
      return proof.passed ? json(proof) : errorJson(proof);
    },
  );

  server.registerTool(
    "pi_review",
    {
      title: "Record the orchestrator review of a verified candidate",
      description: "After reading the complete diff and pi_verify evidence, record every hard requirement verdict and every changed existing validation file decision. Pass the exact pi_verify id. Missing, duplicate, unknown, unmet or unapproved items block review. Review evidence is a coordinator judgment, not an automatic semantic proof.",
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        session_id: z.string(), control_key: z.string().optional(), verification_id: z.string().min(1),
        requirements: z.array(z.object({id: z.string().min(1), met: z.boolean(), evidence: z.string().min(1)})),
        test_changes: z.array(z.object({path: z.string().min(1), approved: z.boolean(), reason: z.string().min(1)})),
      },
    },
    async ({session_id, control_key, verification_id, requirements, test_changes}) => {
      coord.assertControl(session_id, control_key);
      return json(await coord.review(session_id, verification_id, {requirements, test_changes}));
    },
  );

  server.registerTool(
    "pi_merge",
    {
      title: "Merge a worker branch",
      description:
        "Merge only with current successful pi_verify evidence into the clean checked-out target. Hard requirements and edits to existing validation also require exact-candidate pi_review evidence. Source/target/contract changes invalidate evidence. Successful Git merge alone does not close a task.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: {
        session_id: z.string(),
        control_key: z.string().optional(),
        into: z.string().optional().describe("Target branch in the main repo (default: current)"),
        no_ff: z.boolean().optional(),
      },
    },
    async ({ session_id, control_key, into, no_ff }) => {
      coord.assertControl(session_id, control_key);
      return json(await coord.merge(session_id, into, no_ff ?? true));
    },
  );

  server.registerTool(
    "pi_push",
    {
      title: "Push a branch",
      description: "Push the main repo's current branch (or an explicit branch) to a remote.",
      inputSchema: { session_id: z.string(), control_key: z.string().optional(), control_keys: z.record(z.string()).optional(), remote: z.string().optional(), branch: z.string().optional() },
    },
    async ({ session_id, control_key, control_keys, remote, branch }) => {
      coord.assertControl(session_id, control_key);
      coord.assertControlsForActiveRepo(session_id, { ...control_keys, [session_id]: control_key ?? "" });
      return json({ result: await coord.push(session_id, remote ?? "origin", branch) });
    },
  );

  server.registerTool(
    "pi_exec",
    {
      title: "Run a command in a worker's worktree",
      description:
        "Execute a shell command (e.g. the acceptance test/build) inside a worker's worktree and return exit code, stdout, stderr. Use this to verify a worker's work yourself before merging.",
      inputSchema: {
        session_id: z.string(),
        control_key: z.string().optional(),
        command: z.string(),
        timeout_ms: z.number().int().min(1000).max(1_800_000).optional(),
        login: z.boolean().optional().describe("Explicitly opt in to a login shell; default false preserves daemon PATH without loading user shell initialization"),
      },
    },
    async ({ session_id, control_key, command, timeout_ms, login }) => {
      coord.assertControl(session_id, control_key);
      return json(await coord.exec(session_id, command, timeout_ms ?? 600_000, login ?? false));
    },
  );

  server.registerTool(
    "pi_answer",
    {
      title: "Answer a worker's question",
      description:
        "Respond to a pending question surfaced by pi_wait(until=question)/pi_status. For confirm use confirmed; for select/input/editor use value; use cancelled to dismiss.",
      inputSchema: {
        session_id: z.string(),
        control_key: z.string().optional(),
        request_id: z.string(),
        value: z.string().optional(),
        confirmed: z.boolean().optional(),
        cancelled: z.boolean().optional(),
      },
    },
    async ({ session_id, control_key, request_id, value, confirmed, cancelled }) => {
      coord.assertControl(session_id, control_key);
      await coord.answer(session_id, request_id, { value, confirmed, cancelled });
      return json({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  server.registerTool(
    "pi_gc",
    {
      title: "Clean up finished workers",
      description:
        "Clean selected stopped workers, including historical sessions: accepted work and abandoned work with no commit or dirty files. Branches are removed only when safely merged; dirty, unrecorded, and abandoned work with commits is retained. Supply session_ids and matching control_keys. Global cleanup requires keys for every protected session, including history.",
      inputSchema: { session_ids: z.array(z.string()).min(1).optional(), control_keys: z.record(z.string()).optional() },
    },
    async ({ session_ids, control_keys }) => {
      if (session_ids) {
        for (const id of session_ids) coord.assertControl(id, control_keys?.[id]);
      } else {
        coord.assertControlsForAll(control_keys);
      }
      return json(await coord.gc(session_ids));
    },
  );

  // -------------------------------------------------------------------------
  // File claims
  // -------------------------------------------------------------------------

  server.registerTool(
    "pi_claim",
    {
      title: "Claim files",
      description:
        "Claim repo-relative paths (files or directories) so other workers cannot write them. Workers auto-claim on edit/write; use this to reserve files up front.",
      inputSchema: {
        session_id: z.string(),
        control_key: z.string().optional(),
        control_keys: z.record(z.string()).optional().describe("Required for manual codex claims across protected sessions"),
        paths: z.array(z.string()).min(1).describe("Repo-relative paths (POSIX separators)"),
        mode: z.enum(["rw", "ro"]).optional(),
        repo: z
          .string()
          .optional()
          .describe("Repository path selecting the lock namespace for a manual claimant (e.g. codex); defaults to the daemon default repo"),
      },
    },
    async ({ session_id, control_key, control_keys, paths, mode, repo }) => {
      if (session_id === "codex") coord.assertControlsForAll(control_keys);
      else coord.assertControl(session_id, control_key);
      return json(coord.claim(session_id, paths, mode ?? "rw", repo));
    },
  );

  server.registerTool(
    "pi_release",
    {
      title: "Release file claims",
      description: "Release claims for a session. Omit paths to release everything it holds in its repository namespace.",
      inputSchema: {
        session_id: z.string(),
        control_key: z.string().optional(),
        control_keys: z.record(z.string()).optional().describe("Required for manual codex releases across protected sessions"),
        paths: z.array(z.string()).optional(),
        repo: z
          .string()
          .optional()
          .describe("Repository path selecting the lock namespace for a manual claimant (e.g. codex); defaults to the daemon default repo"),
      },
    },
    async ({ session_id, control_key, control_keys, paths, repo }) => {
      if (session_id === "codex") coord.assertControlsForAll(control_keys);
      else coord.assertControl(session_id, control_key);
      return json({ released: coord.releaseLocks(session_id, paths, repo) });
    },
  );

  server.registerTool(
    "pi_locks",
    { title: "List file claims", description: "List all active file claims across sessions.", inputSchema: {} },
    async () => json({ locks: coord.locksList() }),
  );

  // -------------------------------------------------------------------------
  // Messaging and shared board
  // -------------------------------------------------------------------------

  server.registerTool(
    "pi_message",
    {
      title: "Message a worker (peer channel)",
      description:
        "Post a durable message to a worker's mailbox and (optionally) inject it into that worker's conversation. Use for coordination between Codex and workers or between workers.",
      inputSchema: {
        session_id: z.string().describe("Recipient session id, or '*' to broadcast"),
        control_key: z.string().optional(),
        control_keys: z.record(z.string()).optional().describe("Required to broadcast across protected sessions"),
        message: z.string(),
        kind: z.enum(["note", "question", "answer", "broadcast"]).optional(),
        from: z.string().optional(),
        deliver: z.boolean().optional().describe("Inject into the recipient's conversation (default true)"),
      },
    },
    async ({ session_id, control_key, control_keys, message, kind, from, deliver }) => {
      if (session_id === "*") coord.assertControlsForAll(control_keys);
      else coord.assertControl(session_id, control_key);
      const res = coord.postMessage(from ?? "codex", session_id, message, kind ?? "note", deliver ?? true);
      return json(res);
    },
  );

  server.registerTool(
    "pi_inbox",
    {
      title: "Read a worker's mailbox",
      description: "Read messages addressed to a worker.",
      inputSchema: { session_id: z.string(), unread_only: z.boolean().optional() },
    },
    async ({ session_id, unread_only }) => json({ messages: coord.inbox(session_id, unread_only ?? false) }),
  );

  server.registerTool(
    "pi_board_post",
    {
      title: "Post to the shared board",
      description: "Append a fact/decision/interface to a shared blackboard that every worker can read (e.g. API contracts, ownership).",
      inputSchema: { board: z.string(), key: z.string(), value: z.string(), from: z.string().optional(), scope_key: z.string().optional(), control_keys: z.record(z.string()).optional() },
    },
    async ({ board, key, value, from, scope_key, control_keys }) => {
      if (!scope_key) coord.assertControlsForAll(control_keys);
      const target = scope_key ? `${createHash("sha256").update(scope_key).digest("hex")}:${board}` : board;
      const entry = coord.boardPost(target, key, value, from ?? "codex");
      return json(scope_key ? { ...entry, board } : entry);
    },
  );

  server.registerTool(
    "pi_board_read",
    {
      title: "Read the shared board",
      description: "Read board entries. Pass latest=true to get only the newest entry per key.",
      inputSchema: { board: z.string(), key: z.string().optional(), latest: z.boolean().optional(), scope_key: z.string().optional() },
    },
    async ({ board, key, latest, scope_key }) => {
      const target = scope_key ? `${createHash("sha256").update(scope_key).digest("hex")}:${board}` : board;
      const entries = latest ? coord.boardLatest(target) : coord.boardRead(target, key);
      return json({ entries: scope_key ? entries.map((entry) => ({ ...entry, board })) : entries });
    },
  );

  return server;
}
