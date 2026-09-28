import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { Coordinator } from "./manager.js";
import { buildServer } from "./mcp-server.js";
import type { LockMode } from "./locks.js";

const config = loadConfig();
const coord = new Coordinator(config);

function log(...args: unknown[]): void {
  console.error("[pi-mcp]", ...args);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
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

function authorized(req: IncomingMessage): boolean {
  if (!config.token) return true;
  if (req.headers["x-pi-coord-token"] === config.token) return true;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth === `Bearer ${config.token}`) return true;
  return false;
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, parsedBody: unknown): Promise<void> {
  if (req.method === "GET" || req.method === "DELETE") {
    // Stateless deployment: no standalone SSE stream or session teardown.
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  const server = buildServer(coord);
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

async function handleInternal(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
  let body: any = {};
  try {
    if (req.method === "POST" || req.method === "PATCH") body = (await readBody(req)) ?? {};
  } catch (error) {
    return sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) });
  }

  try {
    switch (url.pathname) {
      case "/internal/health":
        return sendJson(res, 200, { ok: true, sessions: coord.list().length });

      case "/internal/hello": {
        const sid = url.searchParams.get("sessionId") || body.sessionId;
        if (sid) coord.markExtension(sid);
        return sendJson(res, 200, { ok: true });
      }

      case "/internal/sessions":
        return sendJson(res, 200, { sessions: coord.list() });

      case "/internal/status": {
        const sid = url.searchParams.get("sessionId") || body.sessionId;
        if (sid) return sendJson(res, 200, coord.snapshot(sid));
        return sendJson(res, 200, { sessions: coord.list() });
      }

      case "/internal/claim": {
        const { sessionId, paths, mode, repo } = body as {
          sessionId: string;
          paths: string[];
          mode?: LockMode;
          repo?: string;
        };
        if (!sessionId || !Array.isArray(paths)) return sendJson(res, 400, { error: "sessionId and paths required" });
        return sendJson(res, 200, coord.claim(sessionId, paths, mode ?? "rw", repo));
      }

      case "/internal/release": {
        const { sessionId, paths, repo } = body as { sessionId: string; paths?: string[]; repo?: string };
        return sendJson(res, 200, { released: coord.releaseLocks(sessionId, paths, repo) });
      }

      case "/internal/locks":
        return sendJson(res, 200, { locks: coord.locksList() });

      case "/internal/inbox": {
        const sid = url.searchParams.get("sessionId") || body.sessionId;
        const unread = url.searchParams.get("unread") === "1" || body.unreadOnly === true;
        return sendJson(res, 200, { messages: coord.inbox(sid, unread) });
      }

      case "/internal/read": {
        const ids = (body.ids as string[]) ?? [];
        coord.markRead(ids, body.sessionId);
        return sendJson(res, 200, { ok: true });
      }

      case "/internal/send": {
        const { from, to, text, kind, deliver } = body as any;
        if (!to || !text) return sendJson(res, 400, { error: "to and text required" });
        return sendJson(res, 200, coord.postMessage(from ?? "unknown", to, text, kind ?? "note", deliver ?? true));
      }

      case "/internal/board/get": {
        const board = url.searchParams.get("board") || body.board;
        const latest = url.searchParams.get("latest") === "1" || body.latest === true;
        if (!board) return sendJson(res, 400, { error: "board required" });
        return sendJson(res, 200, { entries: latest ? coord.boardLatest(board) : coord.boardRead(board, body.key) });
      }

      case "/internal/board/post": {
        const { board, key, value, from } = body as any;
        if (!board || !key || value === undefined) return sendJson(res, 400, { error: "board, key, value required" });
        return sendJson(res, 200, coord.boardPost(board, key, String(value), from ?? "unknown"));
      }

      default:
        return sendJson(res, 404, { error: `unknown endpoint ${url.pathname}` });
    }
  } catch (e) {
    return sendJson(res, 500, { error: String(e instanceof Error ? e.message : e) });
  }
}

const server = createServer((req, res) => {
  let url: URL;
  try {
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

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((e) => {
  log("fatal:", e);
  process.exit(1);
});
