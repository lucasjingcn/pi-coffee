import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Coordinator, SessionMeta } from "./manager.js";
import type { DelegationSpec } from "./types.js";
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
    tests_owned_by_codex: m.testsOwnedByCodex ?? null,
    output_tokens: m.tokens?.output ?? 0,
    lastEntryId: m.lastEntryId,
    lastText: m.lastText?.slice(0, 800),
    extension: m.extension ?? false,
    acceptance: m.acceptance ?? null,
    spec: m.spec ?? null,
    pendingQuestions: m.pendingQuestions.map((q) => ({
      id: q.id,
      method: q.method,
      title: q.title,
      message: q.message,
      options: q.options,
    })),
    error: m.error,
  };
}

export function buildServer(coord: Coordinator): McpServer {
  const server = new McpServer(
    { name: "pi-mcp", version: "0.1.0" },
    { instructions: MCP_INSTRUCTIONS },
  );

  server.registerPrompt(
    "orchestrate",
    {
      title: "pi-mcp orchestrator playbook",
      description:
        "Load the full playbook for acting as the general manager over pi worker sessions (delegation, review, integration).",
    },
    () => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: PLAYBOOK } }],
    }),
  );

  server.registerTool(
    "pi_spawn",
    {
      title: "Spawn a pi worker session",
      description:
        "Create an isolated git worktree + branch and start a long-lived pi coding session in it. Returns the session id used by all other pi_* tools.",
      inputSchema: {
        task: z.string().optional().describe("Short task label (used in the session/branch name)"),
        repo: z.string().optional().describe("Repository path (defaults to daemon config)"),
        name: z.string().optional(),
        baseRef: z.string().optional().describe("Base ref/commit to branch from (default HEAD)"),
        branch: z.string().optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        prompt: z.string().optional().describe("Optional first instruction to send immediately"),
        spec: z
          .object({
            goal: z.string().describe("One unambiguous sentence: what must be true when done"),
            scope: z.array(z.string()).describe("Worktree-relative paths the worker may touch"),
            non_goals: z.array(z.string()).optional(),
            contracts: z.array(z.string()).optional(),
            constraints: z.array(z.string()).optional(),
            task_type: z.enum(TASK_TYPES).optional(),
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
            "Spec-derived acceptance tests written into the worktree BEFORE the worker starts. They are locked against worker edits, so the worker must make them pass rather than change them.",
          ),
        acceptance_command: z.string().optional().describe("Command that runs the acceptance test (recorded for verification)"),
      },
    },
    async (args) => {
      const spec = args.spec as DelegationSpec | undefined;
      // Spec linter: a structured spec must carry goal + scope, and a delegation must carry a spec or a prompt.
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
          "pi-mcp",
          "judgment-override",
          `${args.task ?? spec?.goal}: ${args.spec_override_reason ?? "(no reason given)"}`,
          "codex",
        );
      }
      const warnings: string[] = [];
      if (!args.acceptance_files?.length) {
        warnings.push("no acceptance_files provided: test-first delegation is strongly recommended");
      }
      const meta = await coord.spawn({
        task: args.task,
        repo: args.repo,
        name: args.name,
        baseRef: args.baseRef,
        branch: args.branch,
        model: args.model,
        provider: args.provider,
        prompt: args.prompt,
        spec,
        acceptanceFiles: args.acceptance_files,
        acceptanceCommand: args.acceptance_command,
      });
      const out: Record<string, unknown> = { ...compactMeta(meta) };
      if (warnings.length) out.warnings = warnings;
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
    async ({ session_id, message, mode, model, provider, override, override_reason }) => {
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
            "If it is genuinely too large, spawn ONE stronger-model worker (deepseek-v4-pro) with the concrete failures and evidence, then verify hard.",
            "To insist on another delegated correction anyway, call pi_send with override:true and override_reason.",
          ],
        });
      }
      if (sent >= MAX_DELEGATED_ATTEMPTS && override) {
        coord.boardPost(
          "pi-mcp",
          "delegation-override",
          `${session_id}: ${override_reason ?? "(no reason given)"}`,
          "codex",
        );
      }
      // Adaptive model routing: the first attempt uses the cheap model; a retry escalates to the
      // strong model so the second attempt is more likely to succeed (and avoid a costly take-over).
      const escalate = sent >= 1 && !model;
      const useModel = model ?? (escalate ? coord.config.strongModel : undefined);
      await coord.send(session_id, message, mode ?? "prompt", true, { provider, model: useModel });
      return json({
        ok: true,
        session_id,
        mode: mode ?? "prompt",
        instructions_sent: sent + 1,
        overridden: sent >= MAX_DELEGATED_ATTEMPTS,
        escalated_to: escalate ? useModel : null,
      });
    },
  );

  server.registerTool(
    "pi_wait",
    {
      title: "Wait for workers",
      description:
        "Block until all listed sessions settle (until=settled), or until any worker asks a question (until=question). Returns current snapshots. Prefer timeouts <= 120000ms and re-poll.",
      inputSchema: {
        session_ids: z.array(z.string()).min(1),
        until: z.enum(["settled", "question"]).optional(),
        timeout_ms: z.number().int().min(0).max(120_000).optional(),
      },
    },
    async ({ session_ids, until, timeout_ms }) => {
      const res = await coord.wait(session_ids, until ?? "settled", Math.min(timeout_ms ?? 60_000, 120_000));
      return json({ timedOut: res.timedOut, sessions: res.sessions.map(compactMeta) });
    },
  );

  server.registerTool(
    "pi_status",
    {
      title: "Worker status",
      description: "Get status/cost/pending-questions for one session, or all sessions when session_id is omitted.",
      inputSchema: { session_id: z.string().optional() },
    },
    async ({ session_id }) => {
      if (session_id) return json(compactMeta(coord.snapshot(session_id)));
      return json({ sessions: coord.list().map(compactMeta), metrics: await coord.metrics() });
    },
  );

  server.registerTool(
    "pi_metrics",
    {
      title: "Output-discipline metrics",
      description:
        "Aggregate worker output tokens/cost and the orchestrator's instruction volume. Use to check the discipline: workers should emit the code (high worker_output_tokens), Codex should emit judgment (low instruction volume). Note: Codex's own tokens are not observable here; the orchestrator figure is a lower bound.",
      inputSchema: {},
    },
    async () => json(await coord.metrics()),
  );

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
    "pi_commit",
    {
      title: "Commit a worker's changes",
      description: "Stage and commit all changes in a worker's worktree. Use before merging.",
      inputSchema: { session_id: z.string(), message: z.string() },
    },
    async ({ session_id, message }) => json({ result: await coord.commit(session_id, message) }),
  );

  server.registerTool(
    "pi_merge",
    {
      title: "Merge a worker branch",
      description:
        "Merge a worker's branch into a branch of the main repo (default: the repo's current branch). On conflict the merge is left in progress and conflicts are returned for you to resolve.",
      inputSchema: {
        session_id: z.string(),
        into: z.string().optional().describe("Target branch in the main repo (default: current)"),
        no_ff: z.boolean().optional(),
      },
    },
    async ({ session_id, into, no_ff }) => json(await coord.merge(session_id, into, no_ff ?? true)),
  );

  server.registerTool(
    "pi_push",
    {
      title: "Push a branch",
      description: "Push the main repo's current branch (or an explicit branch) to a remote.",
      inputSchema: { session_id: z.string(), remote: z.string().optional(), branch: z.string().optional() },
    },
    async ({ session_id, remote, branch }) => json({ result: await coord.push(session_id, remote ?? "origin", branch) }),
  );

  server.registerTool(
    "pi_exec",
    {
      title: "Run a command in a worker's worktree",
      description:
        "Execute a shell command (e.g. the acceptance test/build) inside a worker's worktree and return exit code, stdout, stderr. Use this to verify a worker's work yourself before merging.",
      inputSchema: {
        session_id: z.string(),
        command: z.string(),
        timeout_ms: z.number().int().min(1000).max(1_800_000).optional(),
      },
    },
    async ({ session_id, command, timeout_ms }) => json(await coord.exec(session_id, command, timeout_ms ?? 600_000)),
  );

  server.registerTool(
    "pi_answer",
    {
      title: "Answer a worker's question",
      description:
        "Respond to a pending question surfaced by pi_wait(until=question)/pi_status. For confirm use confirmed; for select/input/editor use value; use cancelled to dismiss.",
      inputSchema: {
        session_id: z.string(),
        request_id: z.string(),
        value: z.string().optional(),
        confirmed: z.boolean().optional(),
        cancelled: z.boolean().optional(),
      },
    },
    async ({ session_id, request_id, value, confirmed, cancelled }) => {
      await coord.answer(session_id, request_id, { value, confirmed, cancelled });
      return json({ ok: true });
    },
  );

  server.registerTool(
    "pi_stop",
    {
      title: "Stop a worker",
      description: "Stop a worker session. Optionally record its final outcome and remove its git worktree/branch.",
      inputSchema: {
        session_id: z.string(),
        remove_worktree: z.boolean().optional(),
        delete_branch: z.boolean().optional().describe("Also delete the worker branch (default false: keep it)"),
        outcome: z
          .enum(["success_first", "success_second", "taken_over", "abandoned"])
          .optional()
          .describe("Final disposition for the delegation scoreboard"),
        note: z.string().optional(),
      },
    },
    async ({ session_id, remove_worktree, delete_branch, outcome, note }) => {
      if (outcome) coord.setOutcome(session_id, outcome, note);
      await coord.stop(session_id, { removeWorktree: remove_worktree ?? false, deleteBranch: delete_branch });
      return json({ ok: true, session_id, outcome: outcome ?? coord.snapshot(session_id).outcome ?? "unrecorded" });
    },
  );

  server.registerTool(
    "pi_finish",
    {
      title: "Close a workstream with an outcome",
      description:
        "Record the final disposition of a worker workstream for the delegation scoreboard: success_first (done on the initial task), success_second (done after one correction), taken_over (you finished it yourself after two failed attempts), or abandoned. Call this for EVERY workstream when the task completes.",
      inputSchema: {
        session_id: z.string(),
        outcome: z.enum(["success_first", "success_second", "taken_over", "abandoned"]),
        note: z.string().optional(),
        stop: z.boolean().optional().describe("Also stop the worker (default false; keep it alive through integration)"),
        tests_owned_by_codex: z
          .boolean()
          .optional()
          .describe("True if the acceptance test was authored from the spec and owned by you, not the worker"),
      },
    },
    async ({ session_id, outcome, note, stop, tests_owned_by_codex }) => {
      coord.setOutcome(session_id, outcome, note);
      if (tests_owned_by_codex !== undefined) coord.setTestsOwned(session_id, tests_owned_by_codex);
      if (stop) await coord.stop(session_id);
      return json({
        ok: true,
        session_id,
        outcome,
        tests_owned_by_codex: tests_owned_by_codex ?? null,
        instructions_sent: coord.snapshot(session_id).instructionsSent ?? 0,
      });
    },
  );

  server.registerTool(
    "pi_report",
    {
      title: "Delegation scoreboard",
      description:
        "At task completion, report to the user: how many workstreams were delegated, how many succeeded on the first try / second try, how many you took over yourself, and the percentages. Call this and summarize it to the user.",
      inputSchema: {},
    },
    async () => json(await coord.report()),
  );

  server.registerTool(
    "pi_gc",
    {
      title: "Clean up finished workers",
      description:
        "Stop and evict every finished (outcome-recorded) worker and remove its worktree if clean (branches are kept). Use to reclaim disk after a task.",
      inputSchema: {},
    },
    async () => json(await coord.gc()),
  );

  server.registerTool(
    "pi_list",
    { title: "List workers", description: "List all known worker sessions.", inputSchema: {} },
    async () => json({ sessions: coord.list().map(compactMeta) }),
  );

  server.registerTool(
    "pi_claim",
    {
      title: "Claim files",
      description:
        "Claim repo-relative paths (files or directories) so other workers cannot write them. Workers auto-claim on edit/write; use this to reserve files up front.",
      inputSchema: {
        session_id: z.string(),
        paths: z.array(z.string()).min(1).describe("Repo-relative paths (POSIX separators)"),
        mode: z.enum(["rw", "ro"]).optional(),
      },
    },
    async ({ session_id, paths, mode }) => json(coord.claim(session_id, paths, mode ?? "rw")),
  );

  server.registerTool(
    "pi_release",
    {
      title: "Release file claims",
      description: "Release claims for a session. Omit paths to release everything it holds.",
      inputSchema: { session_id: z.string(), paths: z.array(z.string()).optional() },
    },
    async ({ session_id, paths }) => json({ released: coord.releaseLocks(session_id, paths) }),
  );

  server.registerTool(
    "pi_locks",
    { title: "List file claims", description: "List all active file claims across sessions.", inputSchema: {} },
    async () => json({ locks: coord.locksList() }),
  );

  server.registerTool(
    "pi_message",
    {
      title: "Message a worker (peer channel)",
      description:
        "Post a durable message to a worker's mailbox and (optionally) inject it into that worker's conversation. Use for coordination between Codex and workers or between workers.",
      inputSchema: {
        session_id: z.string().describe("Recipient session id, or '*' to broadcast"),
        message: z.string(),
        kind: z.enum(["note", "question", "answer", "broadcast"]).optional(),
        from: z.string().optional(),
        deliver: z.boolean().optional().describe("Inject into the recipient's conversation (default true)"),
      },
    },
    async ({ session_id, message, kind, from, deliver }) => {
      const res = coord.postMessage(from ?? "codex", session_id, message, kind ?? "note", deliver ?? true);
      return json(res);
    },
  );

  server.registerTool(
    "pi_inbox",
    { title: "Read a worker's mailbox", description: "Read messages addressed to a worker.", inputSchema: { session_id: z.string(), unread_only: z.boolean().optional() } },
    async ({ session_id, unread_only }) => json({ messages: coord.inbox(session_id, unread_only ?? false) }),
  );

  server.registerTool(
    "pi_board_post",
    {
      title: "Post to the shared board",
      description: "Append a fact/decision/interface to a shared blackboard that every worker can read (e.g. API contracts, ownership).",
      inputSchema: { board: z.string(), key: z.string(), value: z.string(), from: z.string().optional() },
    },
    async ({ board, key, value, from }) => json(coord.boardPost(board, key, value, from ?? "codex")),
  );

  server.registerTool(
    "pi_board_read",
    {
      title: "Read the shared board",
      description: "Read board entries. Pass latest=true to get only the newest entry per key.",
      inputSchema: { board: z.string(), key: z.string().optional(), latest: z.boolean().optional() },
    },
    async ({ board, key, latest }) =>
      json({ entries: latest ? coord.boardLatest(board) : coord.boardRead(board, key) }),
  );

  return server;
}
