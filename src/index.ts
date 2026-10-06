import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { Coordinator } from "./manager.js";
import { buildServer } from "./mcp-server.js";
import { daemonCodeDir, recordCodeVersion } from "./code-version.js";
import type { LockMode } from "./locks.js";
import { z } from "zod";
import { WORKER_STARTUP_POLICY } from "./worker-agent-dir.js";
import { logLine } from "./log.js";

const config = loadConfig();
const coord = new Coordinator(config);

// Captured once at daemon startup: pi_status compares this in-memory value with
// the current dist/manager.js mtime so a rebuilt dist without a restart is visible.
const codeDir = daemonCodeDir();
const runningCodeMtimeMs = recordCodeVersion(codeDir);

function log(...args: unknown[]): void {
  logLine("pi-coffee", ...args);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Read and JSON-parse a request body, rejecting anything over 32 MiB. */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

/** Accept either the custom header or a standard bearer token. */
function authorized(req: IncomingMessage): boolean {
  if (!config.token) return true;
  if (req.headers["x-pi-coord-token"] === config.token) return true;

  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth === `Bearer ${config.token}`) return true;
  return false;
}

function requestToken(req: IncomingMessage): string {
  const header = req.headers["x-pi-coord-token"];
  if (typeof header === "string") return header;
  const auth = req.headers.authorization;
  return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

function visibleSession(meta: ReturnType<typeof coord.snapshot>) {
  const { controlKeyHash: _controlKeyHash, scopeKeyHash: _scopeKeyHash, ...visible } = meta;
  return visible;
}

// ---------------------------------------------------------------------------
// MCP endpoint
// ---------------------------------------------------------------------------

async function handleMcp(req: IncomingMessage, res: ServerResponse, parsedBody: unknown): Promise<void> {
  if (req.method === "GET" || req.method === "DELETE") {
    // Stateless deployment: no standalone SSE stream or session teardown.
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }

  const server = buildServer(coord, { dir: codeDir, distMtimeMs: runningCodeMtimeMs });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

// ---------------------------------------------------------------------------
// Internal API (used by the worker extension and stdio proxy)
// ---------------------------------------------------------------------------

const internalString = z.string().min(1);
const internalSchemas: Record<string, z.ZodTypeAny> = {
  "/internal/hello": z.object({ sessionId: internalString.optional() }),
  "/internal/status": z.object({ sessionId: internalString.optional() }),
  "/internal/claim": z.object({ sessionId: internalString, paths: z.array(internalString),
    mode: z.enum(["rw", "ro"]).optional(), repo: internalString.optional() }),
  "/internal/authorize-write": z.object({ sessionId: internalString }),
  "/internal/release": z.object({ sessionId: internalString, paths: z.array(internalString).optional(), repo: internalString.optional() }),
  "/internal/inbox": z.object({ sessionId: internalString.optional(), unreadOnly: z.boolean().optional() }),
  "/internal/read": z.object({ ids: z.array(internalString).optional(), sessionId: internalString.optional() }),
  "/internal/send": z.object({ from: internalString.optional(), to: internalString, text: internalString,
    kind: z.enum(["note", "question", "answer", "broadcast"]).optional(), deliver: z.boolean().optional() }),
  "/internal/board/get": z.object({ board: internalString.optional(), key: internalString.optional(), latest: z.boolean().optional() }),
  "/internal/board/post": z.object({ board: internalString, key: internalString,
    value: z.unknown().refine(value => value !== undefined, "value required"), from: internalString.optional() }),
};

async function handleInternal(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const token = requestToken(req);
  const workerSid = token ? coord.workerSessionForToken(token) : undefined;
  const master = Boolean(config.token) && authorized(req) && !workerSid;
  const mutating = new Set(["/internal/hello", "/internal/claim", "/internal/authorize-write",
    "/internal/release", "/internal/read", "/internal/send", "/internal/board/post"]);
  if (!workerSid && !master && (Boolean(config.token) || (coord.hasProtectedSessions() && mutating.has(url.pathname)))) {
    return sendJson(res, 401, { error: "unauthorized" });
  }

  let body: any = {};
  try {
    if (req.method === "POST" || req.method === "PATCH") {
      const parsed = await readBody(req);
      body = parsed === undefined ? {} : parsed;
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return sendJson(res, 400, { error: "expected a JSON object" });
      }
      const result = (internalSchemas[url.pathname] ?? z.object({})).safeParse(body);
      if (!result.success) return sendJson(res, 400, { error: "invalid endpoint payload" });
      body = result.data;
    }
  } catch (error) {
    return sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) });
  }

  const own = (id: unknown): void => {
    if (workerSid && id !== workerSid) throw new Error("worker token cannot target another session");
  };

  try {
    switch (url.pathname) {
      case "/internal/health":
        return sendJson(res, 200, { ok: true, sessions: coord.list().length, workerStartupPolicy: WORKER_STARTUP_POLICY });

      case "/internal/hello": {
        const sid = url.searchParams.get("sessionId") || body.sessionId;
        own(sid);
        if (sid) coord.markExtension(sid);
        return sendJson(res, 200, { ok: true });
      }

      case "/internal/sessions":
        return sendJson(res, 200, { sessions: coord.list()
          .filter((meta) => !workerSid || (meta.scopeKeyHash && meta.scopeKeyHash === coord.snapshot(workerSid).scopeKeyHash))
          .map(visibleSession) });

      case "/internal/status": {
        const sid = url.searchParams.get("sessionId") || body.sessionId;
        if (sid) {
          if (workerSid) coord.assertSameScope(workerSid, sid);
          return sendJson(res, 200, visibleSession(coord.snapshot(sid)));
        }
        return sendJson(res, 200, { sessions: coord.list()
          .filter((meta) => !workerSid || (meta.scopeKeyHash && meta.scopeKeyHash === coord.snapshot(workerSid).scopeKeyHash))
          .map(visibleSession) });
      }

      case "/internal/claim": {
        const { sessionId, paths, mode, repo } = body as {
          sessionId: string;
          paths: string[];
          mode?: LockMode;
          repo?: string;
        };
        if (!sessionId || !Array.isArray(paths)) {
          return sendJson(res, 400, { error: "sessionId and paths required" });
        }
        own(sessionId);
        return sendJson(res, 200, coord.claim(sessionId, paths, mode ?? "rw", repo));
      }

      case "/internal/authorize-write": {
        if (typeof body.sessionId !== "string") return sendJson(res, 400, { error: "sessionId required" });
        own(body.sessionId);
        coord.authorizeWrite(body.sessionId);
        return sendJson(res, 200, { ok: true });
      }

      case "/internal/release": {
        const { sessionId, paths, repo } = body as { sessionId: string; paths?: string[]; repo?: string };
        own(sessionId);
        return sendJson(res, 200, { released: coord.releaseLocks(sessionId, paths, repo) });
      }

      case "/internal/locks":
        return sendJson(res, 200, { locks: coord.locksList() });

      case "/internal/inbox": {
        const sid = url.searchParams.get("sessionId") || body.sessionId;
        own(sid);
        const unread = url.searchParams.get("unread") === "1" || body.unreadOnly === true;
        return sendJson(res, 200, { messages: coord.inbox(sid, unread) });
      }

      case "/internal/read": {
        const ids = (body.ids as string[]) ?? [];
        own(body.sessionId);
        coord.markRead(ids, body.sessionId);
        return sendJson(res, 200, { ok: true });
      }

      case "/internal/send": {
        const { from, to, text, kind, deliver } = body as any;
        if (!to || !text) return sendJson(res, 400, { error: "to and text required" });
        if (workerSid) {
          if (to === "*") throw new Error("worker broadcast is unavailable across session scopes");
          coord.assertSameScope(workerSid, to);
        }
        return sendJson(res, 200, coord.postMessage(workerSid ?? from ?? "unknown", to, text, kind ?? "note", deliver ?? true));
      }

      case "/internal/board/get": {
        const board = url.searchParams.get("board") || body.board;
        const latest = url.searchParams.get("latest") === "1" || body.latest === true;
        if (!board) return sendJson(res, 400, { error: "board required" });
        const scopedBoard = workerSid ? coord.scopedBoardName(workerSid, board) : board;
        const key = url.searchParams.get("key") || body.key;
        const entries = latest ? coord.boardLatest(scopedBoard) : coord.boardRead(scopedBoard, key);
        return sendJson(res, 200, { entries: workerSid ? entries.map((entry) => ({ ...entry, board })) : entries });
      }

      case "/internal/board/post": {
        const { board, key, value, from } = body as any;
        if (!board || !key || value === undefined) {
          return sendJson(res, 400, { error: "board, key, value required" });
        }
        const entry = coord.boardPost(workerSid ? coord.scopedBoardName(workerSid, board) : board,
          key, String(value), workerSid ?? from ?? "unknown");
        return sendJson(res, 200, workerSid ? { ...entry, board } : entry);
      }

      default:
        return sendJson(res, 404, { error: `unknown endpoint ${url.pathname}` });
    }
  } catch (e) {
    return sendJson(res, 500, { error: String(e instanceof Error ? e.message : e) });
  }
}

// ---------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  let url: URL;
  try {
    // Fixed base: never trust the Host header.
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return sendJson(res, 400, { error: "invalid request URL" });
  }

  if (url.pathname === "/mcp") {
    void (async () => {
      if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });

      let parsedBody: unknown;
      if (req.method === "POST") {
        try {
          parsedBody = await readBody(req);
        } catch (e) {
          return sendJson(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32700, message: String(e instanceof Error ? e.message : e) },
            id: null,
          });
        }
      }

      try {
        await handleMcp(req, res, parsedBody);
      } catch (e) {
        log("mcp error:", e);
        if (!res.headersSent) sendJson(res, 500, { error: String(e) });
      }
    })();
    return;
  }

  if (url.pathname.startsWith("/internal/")) {
    void handleInternal(req, res, url).catch((e) => {
      log("internal error:", e);
      if (!res.headersSent) sendJson(res, 500, { error: String(e) });
    });
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await coord.init();
  server.listen(config.port, config.host, () => {
    log(`listening on http://${config.host}:${config.port}`);
    log(`  MCP endpoint:      http://${config.host}:${config.port}/mcp`);
    log(`  workspace root:    ${config.workspaceRoot}`);
    log(`  default repo:      ${config.defaultRepo}`);
    log(`  default model:     ${config.provider}/${config.model}`);
    log(`  max sessions:      ${config.maxSessions}`);
  });
}

async function shutdown(signal: string): Promise<void> {
  log(`received ${signal}, stopping sessions...`);
  server.close();
  await coord.stopAll();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT").catch((error) => { log("shutdown failed:", error); process.exit(1); }));
process.on("SIGTERM", () => void shutdown("SIGTERM").catch((error) => { log("shutdown failed:", error); process.exit(1); }));

main().catch((e) => {
  log("fatal:", e);
  process.exit(1);
});
