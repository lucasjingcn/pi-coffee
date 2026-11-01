/**
 * Read-only web console for the coordinator.
 *
 * The daemon mounts `createDashboardHandler` in its request router (the Lead
 * wires it; this module never touches src/index.ts). The console only observes
 * state: there is no spawn, stop, commit, merge or message action, so a leaked
 * URL cannot change the orchestration. Routes, all GET:
 *
 *   GET /dashboard                         server-rendered HTML shell + auto refresh
 *   GET /dashboard/api/health              minimal liveness JSON
 *   GET /dashboard/api/sessions            one summary row per session
 *   GET /dashboard/api/sessions/:id        fuller record for one session
 *   GET /dashboard/api/sessions/:id/diff   delegated to Coordinator.diff
 *   GET /dashboard/api/sessions/:id/tail   delegated to Coordinator.tail
 *
 * Auth: when a token is configured every route requires `x-pi-coord-token` or
 * `Authorization: Bearer <token>`; anything else is a 401 before any state is
 * read. Responses are built from an explicit allowlist of session fields, so
 * control-key/scope-key hashes, worker process identities and the token itself
 * never reach HTML or JSON.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IntegrationRecord, Verification } from "./integration.js";
import type { Coordinator, SessionMeta } from "./manager.js";
import type { DelegationSpec } from "./types.js";

/** Tail entries a dashboard page may request in one call (matches the MCP cap). */
const MAX_TAIL_ENTRIES = 200;

/** Longest worker report excerpt echoed back; transcripts go through /tail. */
const MAX_TEXT_CHARS = 4_000;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export interface DashboardDeps {
  coord: Coordinator;
  /** When set, every dashboard request must present this token. */
  token?: string;
}

/** Verification fields a console row needs; the raw command output stays out. */
type VerificationView = Pick<Verification,
  "passed" | "verifiedAt" | "command" | "codeChanged" | "changedFiles" | "existingValidationChanges">;

type IntegrationView = Pick<IntegrationRecord,
  "targetBranch" | "previousTargetSha" | "mergedSha" | "integratedAt">;

interface SessionSummary {
  id: string;
  name: string;
  status: string;
  purpose: string;
  outcome: string;
  provider?: string;
  model?: string;
  thinking?: string;
  cost?: number;
  turns: number;
  outputTokens: number;
  branch: string;
  worktree: string;
  createdAt: number;
  lastActivity: number;
  statsAt: number | null;
  pendingQuestions: number;
  verified: boolean;
  integrated: boolean;
  reviewAccepted: boolean;
  verification: VerificationView | null;
  integration: IntegrationView | null;
  error?: string;
}

interface SessionDetail extends SessionSummary {
  repo: string;
  baseRef: string;
  instructionsSent: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
  testsOwnedByCodex: boolean | null;
  extension: boolean;
  lastEntryId?: string;
  lastText: string | null;
  lastTextTruncated: boolean;
  acceptance: { files: string[]; command?: string } | null;
  spec: DelegationSpec | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Escape a dynamic value for element text and for quoted attribute values. */
function escapeHtml(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Constant-time credential comparison; length differences only leak length. */
function secretEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Accept either the custom header or a standard bearer token. */
function presentedToken(req: IncomingMessage): string | undefined {
  const header = req.headers["x-pi-coord-token"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const presented = presentedToken(req);
  return presented !== undefined && secretEquals(presented, token);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(text);
}

/** True when the coordinator does not know this session id. */
function isUnknownSession(error: unknown): boolean {
  return errorText(error).startsWith("unknown session");
}

// ---------------------------------------------------------------------------
// Session projection (allowlist: nothing secret is ever copied)
// ---------------------------------------------------------------------------

function verificationView(meta: SessionMeta): VerificationView | null {
  const verification = meta.verification;
  if (!verification) return null;
  return {
    passed: verification.passed,
    verifiedAt: verification.verifiedAt,
    command: verification.command,
    codeChanged: verification.codeChanged,
    changedFiles: [...verification.changedFiles],
    existingValidationChanges: [...verification.existingValidationChanges],
  };
}

function integrationView(meta: SessionMeta): IntegrationView | null {
  const integration = meta.integration;
  if (!integration) return null;
  return {
    targetBranch: integration.targetBranch,
    previousTargetSha: integration.previousTargetSha,
    mergedSha: integration.mergedSha,
    integratedAt: integration.integratedAt,
  };
}

function summarize(meta: SessionMeta): SessionSummary {
  const summary: SessionSummary = {
    id: meta.id,
    name: meta.name,
    status: meta.status,
    purpose: meta.spec?.purpose ?? "unspecified",
    outcome: meta.outcome ?? "unrecorded",
    provider: meta.provider,
    model: meta.model,
    thinking: meta.thinking,
    cost: meta.cost,
    turns: meta.turns ?? 0,
    outputTokens: meta.tokens?.output ?? 0,
    branch: meta.branch,
    worktree: meta.worktree,
    createdAt: meta.createdAt,
    lastActivity: meta.lastActivity,
    statsAt: meta.statsAt ?? null,
    pendingQuestions: meta.pendingQuestions.length,
    verified: meta.verification?.passed ?? false,
    integrated: meta.integration !== undefined,
    reviewAccepted: meta.reviewAcceptance !== undefined,
    verification: verificationView(meta),
    integration: integrationView(meta),
  };
  if (meta.error) summary.error = meta.error;
  return summary;
}

function detailOf(meta: SessionMeta): SessionDetail {
  const lastText = typeof meta.lastText === "string" ? meta.lastText : null;
  const truncated = lastText !== null && lastText.length > MAX_TEXT_CHARS;
  return {
    ...summarize(meta),
    repo: meta.repo,
    baseRef: meta.baseRef,
    instructionsSent: meta.instructionsSent ?? 0,
    tokens: meta.tokens,
    context: meta.context,
    testsOwnedByCodex: meta.testsOwnedByCodex ?? null,
    extension: meta.extension ?? false,
    lastEntryId: meta.lastEntryId,
    lastText: lastText === null ? null : truncated ? `${lastText.slice(0, MAX_TEXT_CHARS)}...` : lastText,
    lastTextTruncated: truncated,
    acceptance: meta.acceptance ? { files: [...meta.acceptance.files], command: meta.acceptance.command } : null,
    spec: meta.spec ?? null,
  };
}

// ---------------------------------------------------------------------------
// HTML page (single file, no external assets, nonce-based CSP)
// ---------------------------------------------------------------------------

function modelLabel(session: SessionSummary): string {
  const provider = session.provider ?? "n/a";
  const model = session.model ?? "n/a";
  return `${provider}/${model}`;
}

function costLabel(cost: number | undefined): string {
  return typeof cost === "number" && Number.isFinite(cost) ? `$${cost.toFixed(4)}` : "n/a";
}

function proofLabel(session: SessionSummary): string {
  const parts = [session.outcome, session.verified ? "verified" : "unverified"];
  if (session.reviewAccepted) parts.push("review-accepted");
  if (session.integrated) parts.push("integrated");
  if (session.pendingQuestions > 0) parts.push(`${session.pendingQuestions} question(s)`);
  return parts.join(" | ");
}

/** Client script: rebuilt rows use textContent, so refreshed data stays inert. */
const CLIENT_SCRIPT = `
(function () {
  "use strict";
  var REFRESH_MS = 5000;
  var tbody = document.getElementById("sessions");
  var status = document.getElementById("status");
  var panel = document.getElementById("detail");
  var output = document.getElementById("detail-body");
  var selected = null;

  function setStatus(text) { status.textContent = text; }

  function cell(text, className) {
    var td = document.createElement("td");
    if (className) td.className = className;
    td.textContent = text === undefined || text === null ? "n/a" : String(text);
    return td;
  }

  function model(session) {
    return (session.provider || "n/a") + "/" + (session.model || "n/a");
  }

  function cost(value) {
    return typeof value === "number" && isFinite(value) ? "$" + value.toFixed(4) : "n/a";
  }

  function proof(session) {
    var parts = [session.outcome, session.verified ? "verified" : "unverified"];
    if (session.reviewAccepted) parts.push("review-accepted");
    if (session.integrated) parts.push("integrated");
    if (session.pendingQuestions > 0) parts.push(session.pendingQuestions + " question(s)");
    return parts.join(" | ");
  }

  function row(session) {
    var tr = document.createElement("tr");
    tr.setAttribute("data-session", session.id);
    tr.appendChild(cell(session.id, "id"));
    tr.appendChild(cell(session.name));
    tr.appendChild(cell(session.status));
    tr.appendChild(cell(session.purpose));
    tr.appendChild(cell(model(session)));
    tr.appendChild(cell(cost(session.cost), "num"));
    tr.appendChild(cell(session.turns, "num"));
    tr.appendChild(cell(session.branch, "id"));
    tr.appendChild(cell(proof(session)));
    tr.addEventListener("click", function () { select(session.id); });
    return tr;
  }

  function render(sessions) {
    tbody.textContent = "";
    if (!sessions.length) {
      var empty = document.createElement("tr");
      var td = cell("No sessions.", "empty");
      td.colSpan = 9;
      empty.appendChild(td);
      tbody.appendChild(empty);
      return;
    }
    for (var i = 0; i < sessions.length; i++) tbody.appendChild(row(sessions[i]));
  }

  function getJson(path) {
    return fetch(path, { headers: { accept: "application/json" }, cache: "no-store" }).then(function (response) {
      if (!response.ok) throw new Error(path + " -> " + response.status);
      return response.json();
    });
  }

  function select(id) {
    selected = id;
    panel.hidden = false;
    output.textContent = "loading " + id + " ...";
    var base = "/dashboard/api/sessions/" + encodeURIComponent(id);
    Promise.all([getJson(base), getJson(base + "/diff"), getJson(base + "/tail?max=20")]).then(function (parts) {
      if (selected !== id) return;
      output.textContent = JSON.stringify({ session: parts[0], diff: parts[1], tail: parts[2] }, null, 2);
    }).catch(function (error) {
      if (selected !== id) return;
      output.textContent = String(error && error.message ? error.message : error);
    });
  }

  function refresh() {
    getJson("/dashboard/api/sessions").then(function (body) {
      render(body.sessions || []);
      setStatus("updated " + new Date().toLocaleTimeString() + " - " + (body.sessions || []).length + " session(s)");
    }).catch(function (error) {
      setStatus("refresh failed: " + (error && error.message ? error.message : error));
    });
  }

  var initial = tbody.querySelectorAll("tr[data-session]");
  for (var i = 0; i < initial.length; i++) {
    (function (tr) {
      tr.addEventListener("click", function () { select(tr.getAttribute("data-session")); });
    })(initial[i]);
  }

  refresh();
  setInterval(refresh, REFRESH_MS);
})();
`;

function renderPage(sessions: SessionSummary[], nonce: string): string {
  const body = sessions.length === 0
    ? `        <tr><td class="empty" colspan="9">No sessions.</td></tr>`
    : sessions.map((session) => `        <tr data-session="${escapeHtml(session.id)}">
          <td class="id">${escapeHtml(session.id)}</td>
          <td>${escapeHtml(session.name)}</td>
          <td>${escapeHtml(session.status)}</td>
          <td>${escapeHtml(session.purpose)}</td>
          <td>${escapeHtml(modelLabel(session))}</td>
          <td class="num">${escapeHtml(costLabel(session.cost))}</td>
          <td class="num">${escapeHtml(session.turns)}</td>
          <td class="id">${escapeHtml(session.branch)}</td>
          <td>${escapeHtml(proofLabel(session))}</td>
        </tr>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi-coffee - orchestrator console</title>
<style nonce="${escapeHtml(nonce)}">
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #101418; color: #e6edf3; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; }
  h1 { font-size: 18px; margin: 0; }
  .muted { color: #8b949e; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #212a33; vertical-align: top; }
  th { color: #8b949e; font-weight: 500; }
  td.num { text-align: right; }
  td.id { color: #9ecbff; }
  td.empty { text-align: center; color: #8b949e; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: #171e26; }
  #detail { margin-top: 24px; }
  pre { margin: 0; padding: 12px; overflow-x: auto; background: #0b0f13; border: 1px solid #212a33; border-radius: 6px; }
  footer { margin-top: 24px; color: #8b949e; }
</style>
</head>
<body>
<header>
  <h1>pi-coffee orchestrator console</h1>
  <span class="muted">read-only</span>
</header>
<table>
  <thead>
    <tr>
      <th>session</th><th>name</th><th>status</th><th>purpose</th><th>model</th>
      <th class="num">cost</th><th class="num">turns</th><th>branch</th><th>proof</th>
    </tr>
  </thead>
  <tbody id="sessions">
${body}
  </tbody>
</table>
<section id="detail" hidden>
  <h2 id="detail-title">Session detail</h2>
  <pre id="detail-body"></pre>
</section>
<footer>
  <span id="status">starting</span> - auto refresh every 5s. This console never mutates sessions.
</footer>
<script nonce="${escapeHtml(nonce)}">${CLIENT_SCRIPT}</script>
</body>
</html>
`;
}

function sendHtml(res: ServerResponse, html: string, nonce: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self'; connect-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`,
  });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Split a dashboard path into decoded segments. `undefined` means the path is
 * malformed (empty segment, encoded separator, bad percent-encoding).
 */
function pathSegments(pathname: string): string[] | undefined {
  const rest = pathname.slice("/dashboard".length);
  // `/dashboard` and the conventional `/dashboard/` are the same page.
  if (rest === "" || rest === "/") return [];
  const parts = rest.slice(1).split("/");
  const segments: string[] = [];
  for (const part of parts) {
    if (!part) return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return undefined;
    }
    // A %2F would let one segment address two resources; NUL is never valid here.
    if (decoded.includes("/") || decoded.includes("\0")) return undefined;
    segments.push(decoded);
  }
  return segments;
}

function findSession(coord: Coordinator, id: string): SessionMeta | undefined {
  try {
    return coord.snapshot(id);
  } catch (error) {
    // snapshot() only throws for an unknown id; anything else is a real failure.
    if (isUnknownSession(error)) return undefined;
    throw error;
  }
}

function tailLimit(url: URL): { ok: true; max?: number } | { ok: false } {
  const raw = url.searchParams.get("max");
  if (raw === null) return { ok: true };
  if (!/^\d+$/.test(raw)) return { ok: false };
  const max = Number(raw);
  if (!Number.isInteger(max) || max < 1 || max > MAX_TAIL_ENTRIES) return { ok: false };
  return { ok: true, max };
}

async function serve(coord: Coordinator, url: URL, res: ServerResponse): Promise<void> {
  const segments = pathSegments(url.pathname);
  if (!segments) return sendJson(res, 400, { error: "malformed path", path: url.pathname });

  if (segments.length === 0) {
    // Fresh CSP nonce per response; the shell carries no other dynamic value.
    const nonce = randomBytes(16).toString("hex");
    return sendHtml(res, renderPage(coord.list().map(summarize), nonce), nonce);
  }

  if (segments[0] !== "api" || segments.length < 2) {
    return sendJson(res, 404, { error: "not found", path: url.pathname });
  }

  const [, resource, ...rest] = segments;

  if (resource === "health") {
    if (rest.length !== 0) return sendJson(res, 400, { error: "malformed path", path: url.pathname });
    return sendJson(res, 200, {
      ok: true,
      service: "pi-coffee-dashboard",
      readOnly: true,
      sessions: coord.list().length,
      time: new Date().toISOString(),
    });
  }

  if (resource !== "sessions") {
    return sendJson(res, 404, { error: "not found", path: url.pathname });
  }

  if (rest.length === 0) {
    const sessions = coord.list().map(summarize);
    return sendJson(res, 200, { sessions, count: sessions.length, generatedAt: new Date().toISOString() });
  }

  const id = rest[0] as string;
  const action = rest.length > 1 ? rest[1] : undefined;

  if (rest.length > 2) return sendJson(res, 400, { error: "malformed path", path: url.pathname });
  if (action !== undefined && action !== "diff" && action !== "tail") {
    return sendJson(res, 400, { error: `unknown session view: ${action}`, path: url.pathname });
  }

  const meta = findSession(coord, id);
  if (!meta) return sendJson(res, 404, { error: "unknown session", session: id });

  if (action === undefined) return sendJson(res, 200, { session: detailOf(meta) });

  if (action === "diff") {
    try {
      return sendJson(res, 200, { session: id, diff: await coord.diff(id) });
    } catch (error) {
      if (isUnknownSession(error)) return sendJson(res, 404, { error: "unknown session", session: id });
      throw error;
    }
  }

  const limit = tailLimit(url);
  if (!limit.ok) return sendJson(res, 400, { error: `invalid max (1-${MAX_TAIL_ENTRIES})`, path: url.pathname });

  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw && sinceRaw.trim() ? sinceRaw : undefined;
  let tailed: { entries: unknown[]; leafId: string | null };
  try {
    tailed = limit.max === undefined ? await coord.tail(id, since) : await coord.tail(id, since, limit.max);
  } catch (error) {
    if (isUnknownSession(error)) return sendJson(res, 404, { error: "unknown session", session: id });
    throw error;
  }
  return sendJson(res, 200, { session: id, since: since ?? null, max: limit.max ?? null,
    entries: tailed.entries, leafId: tailed.leafId });
}

/**
 * Build the dashboard request handler. Returns `true` when the request belonged
 * to the dashboard (including error responses) and `false` when the caller must
 * keep routing it.
 */
export function createDashboardHandler(
  deps: DashboardDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const coord = deps.coord;
  const token = deps.token;
  if (!coord) throw new Error("createDashboardHandler requires a coordinator");

  return async function dashboardHandler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    let url: URL;
    try {
      // Fixed base: never trust the Host header.
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return false;
    }

    const path = url.pathname;
    if (path !== "/dashboard" && !path.startsWith("/dashboard/")) return false;

    // Authenticate before reading any state or parsing the path shape.
    if (!authorized(req, token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }

    // HEAD is a health-probe-friendly alias for GET: same status/headers, no body.
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end();
      return true;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" }, { allow: "GET" });
      return true;
    }

    try {
      await serve(coord, url, res);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: errorText(error) });
      else res.end();
    }
    return true;
  };
}
