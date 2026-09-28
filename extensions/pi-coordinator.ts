/**
 * pi-coordinator.ts — worker-side thin client for the pi-mcp coordinator daemon.
 *
 * Loaded only into daemon-spawned pi sessions (via `--extension`). It is inert
 * unless PI_COORD_URL / PI_COORD_SESSION_ID are present in the environment.
 *
 * Responsibilities:
 *   - enforce advisory file claims on edit/write (auto-claim, block on conflict)
 *   - poll the mailbox and inject peer/coordinator messages into the conversation
 *   - expose peer tools: send/inbox/claim/release/board/status/sessions
 */
import { isAbsolute, relative } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const base = process.env.PI_COORD_URL;
  const sessionIdEnv = process.env.PI_COORD_SESSION_ID;
  if (!base || !sessionIdEnv) return; // not a coordinated session
  const sessionId: string = sessionIdEnv;
  const token = process.env.PI_COORD_TOKEN || "";

  const held = new Set<string>();
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  async function call(path: string, body?: unknown, method: "GET" | "POST" = "POST"): Promise<any> {
    const url = new URL(path, base);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["x-pi-coord-token"] = token;
    const res = await fetch(url, {
      method,
      headers,
      body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) throw new Error(`coordinator ${path} -> ${res.status}: ${text}`);
    return parsed;
  }

  function relInRepo(ctx: ExtensionContext, p: string): string | undefined {
    if (typeof p !== "string" || p.length === 0) return undefined;
    const abs = isAbsolute(p) ? p : `${ctx.cwd}/${p}`;
    const rel = relative(ctx.cwd, abs).split("\\").join("/");
    return rel.startsWith("..") ? undefined : rel; // outside the worktree: not ours to lock
  }

  /** Best-effort extraction of repo files a bash command will write. */
  function bashPaths(cmd: string): string[] {
    const out = new Set<string>();
    const add = (raw?: string) => {
      if (!raw) return;
      const p = raw.replace(/^["']|["']$/g, "");
      if (!p || p.startsWith("-") || /[$`*?{|]/.test(p) || p.startsWith("&")) return;
      out.add(p);
    };
    for (const m of cmd.matchAll(/(?:^|[^0-9>])>>?\s*("[^"]+"|'[^']+'|[^\s;|&<>()]+)/g)) add(m[1]);
    for (const m of cmd.matchAll(/\btee\b(?:\s+-a)?\s+("[^"]+"|'[^']+'|[^\s;|&<>()]+)/g)) add(m[1]);
    if (/\bsed\b[^\n]*\s-i/.test(cmd)) {
      for (const tok of cmd.split(/\s+/)) if (tok.includes("/") || /\.\w+$/.test(tok)) add(tok);
    }
    return [...out];
  }

  function ok(text: string) {
    return { content: [{ type: "text" as const, text }], details: undefined as unknown };
  }

  // --- peer tools -----------------------------------------------------------

  pi.registerTool({
    name: "coord_send",
    label: "coord_send",
    description: "Send a message to another worker session (or '*' to broadcast). Injected into their conversation.",
    parameters: Type.Object({
      to: Type.String({ description: "Target session id, or '*' for all" }),
      message: Type.String(),
      kind: Type.Optional(Type.String({ description: "note | question | answer | broadcast" })),
    }),
    async execute(_id, params) {
      const res = await call("/internal/send", {
        from: sessionId,
        to: params.to,
        text: params.message,
        kind: params.kind ?? "note",
        deliver: true,
      });
      return ok(JSON.stringify(res));
    },
  });

  pi.registerTool({
    name: "coord_inbox",
    label: "coord_inbox",
    description: "Read messages addressed to this session.",
    parameters: Type.Object({ unread_only: Type.Optional(Type.Boolean()) }),
    async execute(_id, params) {
      const res = await call(`/internal/inbox?sessionId=${encodeURIComponent(sessionId)}&unread=1`, undefined, "GET");
      if (params.unread_only === false) {
        const all = await call(`/internal/inbox?sessionId=${encodeURIComponent(sessionId)}`, undefined, "GET");
        return ok(JSON.stringify(all));
      }
      return ok(JSON.stringify(res));
    },
  });

  pi.registerTool({
    name: "coord_claim",
    label: "coord_claim",
    description: "Reserve repo-relative files/directories so other workers cannot write them.",
    parameters: Type.Object({
      paths: Type.Array(Type.String()),
      mode: Type.Optional(Type.String({ description: "rw (default) or ro" })),
    }),
    async execute(_id, params) {
      const res = await call("/internal/claim", { sessionId, paths: params.paths, mode: params.mode ?? "rw" });
      if (res.ok) for (const p of params.paths) held.add(p);
      return ok(JSON.stringify(res));
    },
  });

  pi.registerTool({
    name: "coord_release",
    label: "coord_release",
    description: "Release this session's file claims (all, or the given paths).",
    parameters: Type.Object({ paths: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params) {
      const res = await call("/internal/release", { sessionId, paths: params.paths });
      if (params.paths) for (const p of params.paths) held.delete(p);
      else held.clear();
      return ok(JSON.stringify(res));
    },
  });

  pi.registerTool({
    name: "coord_board_post",
    label: "coord_board_post",
    description: "Post a fact/decision/interface to a shared board that all workers can read.",
    parameters: Type.Object({ board: Type.String(), key: Type.String(), value: Type.String() }),
    async execute(_id, params) {
      return ok(JSON.stringify(await call("/internal/board/post", { ...params, from: sessionId })));
    },
  });

  pi.registerTool({
    name: "coord_board_read",
    label: "coord_board_read",
    description: "Read the shared board (optionally latest entry per key).",
    parameters: Type.Object({
      board: Type.String(),
      latest: Type.Optional(Type.Boolean()),
      key: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const q = new URLSearchParams({ board: String(params.board) });
      if (params.latest) q.set("latest", "1");
      if (params.key) q.set("key", String(params.key));
      return ok(JSON.stringify(await call(`/internal/board/get?${q}`, undefined, "GET")));
    },
  });

  pi.registerTool({
    name: "coord_ask",
    label: "coord_ask",
    description:
      "Ask the coordinator (Codex) a blocking question and wait for the answer. Use when blocked or when a decision/approval is needed. kind=confirm (yes/no), select, or input (default).",
    parameters: Type.Object({
      question: Type.String(),
      kind: Type.Optional(Type.String({ description: "confirm | select | input" })),
      options: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const title = "Worker asks Codex";
      if (params.kind === "confirm") {
        const yes = await ctx.ui.confirm(title, params.question);
        return ok(yes ? "yes" : "no");
      }
      if (params.kind === "select" && params.options && params.options.length > 0) {
        const v = await ctx.ui.select(params.question, params.options.map(String));
        return ok(v ?? "(cancelled)");
      }
      const v = await ctx.ui.input(title, params.question);
      return ok(v ?? "(no answer)");
    },
  });

  pi.registerTool({
    name: "coord_status",
    label: "coord_status",
    description: "List all worker sessions and their status.",
    parameters: Type.Object({}),
    async execute() {
      return ok(JSON.stringify(await call("/internal/sessions", undefined, "GET")));
    },
  });

  // --- lock enforcement -----------------------------------------------------

  async function ensureClaims(rels: string[]): Promise<{ blocked?: string }> {
    const need = rels.filter((r) => !held.has(r));
    if (need.length === 0) return {};
    const res = await call("/internal/claim", { sessionId, paths: need, mode: "rw" });
    if (res.ok) {
      for (const r of need) held.add(r);
      return {};
    }
    const holders = (res.conflicts ?? []).map((c: any) => `${c.path} @ ${c.sessionId}`).join(", ");
    return {
      blocked: `File is claimed by another worker: ${holders}. Coordinate with coord_send, choose different files, or ask the coordinator to reassign.`,
    };
  }

  pi.on("tool_call", async (event, ctx) => {
    let rels: string[] = [];
    if (event.toolName === "edit" || event.toolName === "write") {
      const rel = relInRepo(ctx, (event.input as any)?.path);
      if (rel) rels = [rel];
    } else if (event.toolName === "bash") {
      const cmd = (event.input as any)?.command;
      if (typeof cmd === "string") {
        rels = bashPaths(cmd)
          .map((p) => relInRepo(ctx, p))
          .filter((p): p is string => Boolean(p));
      }
    } else {
      return undefined;
    }
    if (rels.length === 0) return undefined;
    try {
      const r = await ensureClaims([...new Set(rels)]);
      if (r.blocked) return { block: true, reason: r.blocked };
      return undefined;
    } catch {
      // Coordinator unreachable: fail open so a daemon outage doesn't freeze work.
      return undefined;
    }
  });

  // --- mailbox polling ------------------------------------------------------

  async function pollInbox(): Promise<void> {
    try {
      const res = await call(`/internal/inbox?sessionId=${encodeURIComponent(sessionId)}&unread=1`, undefined, "GET");
      const msgs: any[] = res?.messages ?? [];
      if (msgs.length === 0) return;
      const text = msgs
        .map((m) => `[coordinator] from ${m.from} (${m.kind}):\n${m.text}`)
        .join("\n\n");
      // Inject first, then mark read: at-least-once delivery beats silently dropping a message.
      pi.sendUserMessage(`${text}\n\n(Use coord_send to reply, coord_board_read to check shared state.)`, {
        deliverAs: "followUp",
      });
      await call("/internal/read", { ids: msgs.map((m) => m.id) });
    } catch {
      /* daemon down: keep polling quietly */
    }
  }

  pi.on("session_start", () => {
    void call("/internal/hello", { sessionId }).catch(() => {});
    if (pollTimer) return;
    pollTimer = setInterval(() => void pollInbox(), 2500);
    pollTimer.unref?.();
  });

  pi.on("session_shutdown", async () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    await call("/internal/release", { sessionId }).catch(() => {});
    held.clear();
  });
}
