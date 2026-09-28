#!/usr/bin/env node
/**
 * stdio -> HTTP bridge for pi-mcp.
 *
 * Codex starts this as a stdio MCP server. It forwards every JSON-RPC message to
 * the pi-mcp HTTP daemon, retrying on failure. Because the daemon's /mcp endpoint
 * is stateless, a daemon restart never breaks the Codex session: the next request
 * simply reconnects.
 *
 * Env:
 *   PI_MCP_URL    full MCP URL (default http://127.0.0.1:8787/mcp)
 *   PI_MCP_PORT   used if PI_MCP_URL is unset
 *   PI_MCP_TOKEN  optional bearer/x-pi-coord-token
 */
const URL = process.env.PI_MCP_URL || `http://127.0.0.1:${process.env.PI_MCP_PORT || 8787}/mcp`;
const TOKEN = process.env.PI_MCP_TOKEN || "";

function log(...args: unknown[]): void {
  console.error("[pi-mcp-proxy]", ...args);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (TOKEN) h["x-pi-coord-token"] = TOKEN;
  return h;
}

/** Parse either a plain JSON body or an SSE body (`data: {...}`). */
function parseBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to SSE parsing */
    }
  }

  for (const line of trimmed.split("\n")) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (payload) {
      try {
        return JSON.parse(payload);
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

/**
 * Codes that can only be observed before a request reaches the daemon. Retrying
 * these is safe because no handler could have run. Anything else (HTTP error
 * responses, resets, body/read failures, invalid JSON, ambiguous transport
 * errors) might have executed a mutation and must never be replayed.
 */
const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

/**
 * Validate that a parsed daemon body is a well-formed JSON-RPC 2.0 response
 * correlated to `id` before forwarding it to the caller. Anything else means the
 * caller would be left waiting on an unresolved request, so it is rejected.
 */
function isValidJsonRpcResponse(resp: unknown, id: unknown): boolean {
  if (resp === null || typeof resp !== "object" || Array.isArray(resp)) return false;
  const o = resp as Record<string, unknown>;

  if (o.jsonrpc !== "2.0" || o.id !== id) return false;

  const hasResult = Object.prototype.hasOwnProperty.call(o, "result");
  const hasError = Object.prototype.hasOwnProperty.call(o, "error");
  if (hasResult === hasError) return false; // must have exactly one of result/error

  if (hasError) {
    const err = o.error;
    if (err === null || typeof err !== "object" || Array.isArray(err)) return false;
    const e = err as Record<string, unknown>;
    if (typeof e.code !== "number" || !Number.isInteger(e.code)) return false;
    if (typeof e.message !== "string") return false;
  }
  return true;
}

/** Walk a fetch error's nested `cause`/`errors` chain looking for a pre-connection code. */
function isPreConnectionFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === null || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);

    const obj = cur as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof obj.code === "string" && RETRYABLE_CODES.has(obj.code)) return true;
    if (Array.isArray(obj.errors)) stack.push(...obj.errors);
    if (obj.cause !== undefined) stack.push(obj.cause);
  }
  return false;
}

async function post(body: unknown): Promise<unknown> {
  const attempts = 8;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(URL, { method: "POST", headers: headers(), body: JSON.stringify(body) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return parseBody(text);
    } catch (e) {
      // Only transient failures that occur before the connection is established
      // are safe to retry; everything else propagates and is reported once.
      if (i === attempts - 1 || !isPreConnectionFailure(e)) throw e;
      await sleep(Math.min(200 * (i + 1), 1500));
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error("pi-mcp proxy: retry loop exhausted");
}

// ---------------------------------------------------------------------------
// stdin framing
// ---------------------------------------------------------------------------

let buf = "";
let pending = 0;
let ended = false;

function maybeExit(): void {
  if (ended && pending === 0) process.exit(0);
}

function enqueueLine(line: string): void {
  if (!line.trim()) return;
  pending++;
  void handleLine(line).finally(() => {
    pending--;
    maybeExit();
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).replace(/\r$/, "");
    buf = buf.slice(nl + 1);
    enqueueLine(line);
  }
});
process.stdin.on("end", () => {
  ended = true;
  // Flush a final request that arrived without a trailing newline.
  const tail = buf.replace(/\r$/, "");
  buf = "";
  enqueueLine(tail);
  maybeExit();
});

async function handleLine(line: string): Promise<void> {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const id = msg?.id;
  const isRequest = id !== undefined && id !== null;

  try {
    const resp = await post(msg);
    if (!isRequest) return; // notifications are allowed to have no response

    if (!isValidJsonRpcResponse(resp, id)) {
      // Empty/invalid body or an unparseable/unmatched/ill-formed response:
      // still give the caller exactly one correlated reply instead of dropping it.
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "pi-mcp daemon returned an empty, invalid, or unmatched response" },
        }) + "\n",
      );
      return;
    }

    process.stdout.write(JSON.stringify(resp) + "\n");
  } catch (e) {
    log("forward failed:", String(e));
    if (isRequest) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: `pi-mcp daemon unreachable: ${String(e)}` },
        }) + "\n",
      );
    }
  }
}
