import test from "node:test";
import assert from "node:assert/strict";
import { LOG_FORMAT_ENV, REDACTED, isJsonLoggingEnabled, logLine, logStructured } from "../dist/log.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Run `fn` with console.error captured; returns every call's argument list. */
function capture(fn) {
  const calls = [];
  const original = console.error;
  console.error = (...args) => { calls.push(args); };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return calls;
}

/** Run `fn` with PI_COFFEE_LOG_FORMAT set to `value` (undefined deletes it). */
function withLogFormat(value, fn) {
  const previous = process.env[LOG_FORMAT_ENV];
  if (value === undefined) delete process.env[LOG_FORMAT_ENV];
  else process.env[LOG_FORMAT_ENV] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[LOG_FORMAT_ENV];
    else process.env[LOG_FORMAT_ENV] = previous;
  }
}

/** A JSON-mode call is exactly one stderr line carrying one parseable object. */
function parseJsonLine(calls) {
  assert.equal(calls.length, 1, "one log call per record");
  assert.equal(calls[0].length, 1, "one string argument per JSON line");
  const line = calls[0][0];
  assert.equal(typeof line, "string");
  assert.ok(!line.includes("\n"), "a record never spans lines");
  return JSON.parse(line);
}

const SECRET_HEX = "f".repeat(64);
const SECRET_BASE64 = "Q2hhbmdlTWVQbGVhc2VUaGlzSXNBVG9rZW5WYWx1ZTE";

// ---------------------------------------------------------------------------
// Default format is untouched
// ---------------------------------------------------------------------------

test("without PI_COFFEE_LOG_FORMAT, logLine keeps the bracketed text format", () => {
  const calls = withLogFormat(undefined, () => capture(() => logLine("pi-coffee", "listening on http://127.0.0.1:8787", 3)));
  assert.equal(calls.length, 1);
  const [prefix, ...rest] = calls[0];
  const match = prefix.match(/^\[(.+)\] \[pi-coffee\]$/);
  assert.ok(match, `unexpected prefix: ${prefix}`);
  assert.match(match[1], ISO, "timestamp prefix is ISO-8601");
  assert.deepEqual(rest, ["listening on http://127.0.0.1:8787", 3], "arguments are passed through unchanged");
  assert.throws(() => JSON.parse(prefix), "text output is not JSON");
});

test("a non-json PI_COFFEE_LOG_FORMAT value leaves the text format in place", () => {
  const calls = withLogFormat("text", () => capture(() => logLine("state", "recovered")));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2);
  assert.ok(calls[0][0].endsWith("[state]"));
  assert.equal(calls[0][1], "recovered");
});

test("isJsonLoggingEnabled only accepts json (case/space tolerant)", () => {
  assert.equal(withLogFormat(undefined, () => isJsonLoggingEnabled()), false);
  assert.equal(withLogFormat("text", () => isJsonLoggingEnabled()), false);
  assert.equal(withLogFormat("json", () => isJsonLoggingEnabled()), true);
  assert.equal(withLogFormat(" JSON ", () => isJsonLoggingEnabled()), true);
  assert.equal(withLogFormat(`json${SECRET_BASE64}`, () => isJsonLoggingEnabled()), false);
});

// ---------------------------------------------------------------------------
// JSON mode shape
// ---------------------------------------------------------------------------

test("PI_COFFEE_LOG_FORMAT=json turns logLine into one JSON object per line", () => {
  const calls = withLogFormat("json", () => capture(() => logLine("pi-coffee", "reclaimed 2 transcript(s)", { files: 2 })));
  const record = parseJsonLine(calls);
  assert.deepEqual(Object.keys(record).sort(), ["details", "event", "level", "message", "ts"]);
  assert.match(record.ts, ISO);
  assert.equal(record.level, "info");
  assert.equal(record.event, "pi-coffee");
  assert.equal(record.message, `reclaimed 2 transcript(s) {"files":2}`);
  assert.deepEqual(record.details, { args: ["reclaimed 2 transcript(s)", { files: 2 }] });
});

test("consecutive calls produce one independent object each", () => {
  const calls = withLogFormat("json", () => capture(() => {
    logLine("state", "first");
    logLine("state", "second");
  }));
  assert.equal(calls.length, 2);
  const records = calls.map((call) => JSON.parse(call[0]));
  assert.deepEqual(records.map((record) => record.message), ["first", "second"]);
  for (const record of records) assert.match(record.ts, ISO);
});

test("logStructured carries level, event, message and details as data", () => {
  const calls = withLogFormat("json", () => capture(() => logStructured({
    level: "error",
    event: "shutdown_failed",
    message: "worker shutdown unconfirmed",
    details: { session: "pi-7", attempts: 2, ok: false, absent: null },
  })));
  const record = parseJsonLine(calls);
  assert.equal(record.level, "error");
  assert.equal(record.event, "shutdown_failed");
  assert.equal(record.message, "worker shutdown unconfirmed");
  assert.deepEqual(record.details, { session: "pi-7", attempts: 2, ok: false, absent: null });
});

test("logStructured defaults missing details to an object and keeps the text format otherwise", () => {
  const json = withLogFormat("json", () => capture(() => logStructured({ event: "probe" })));
  const record = parseJsonLine(json);
  assert.equal(record.level, "info");
  assert.deepEqual(record.details, {});
  assert.equal(record.message, "");

  const text = withLogFormat(undefined, () => capture(() => logStructured({
    event: "probe",
    message: "hello",
    details: { a: 1 },
  })));
  assert.equal(text.length, 1);
  assert.match(text[0][0], /^\[.+\.\d{3}Z\] \[probe\]$/);
  assert.equal(text[0].length, 2, "no JSON envelope in text mode");
  assert.equal(text[0][1], 'hello {"a":1}');
});

// ---------------------------------------------------------------------------
// No secrets, ever
// ---------------------------------------------------------------------------

test("credentials in messages are redacted in JSON mode", () => {
  const calls = withLogFormat("json", () => capture(() => logLine(
    "pi-coffee",
    `control_key=${SECRET_BASE64}`,
    "x-pi-coord-token: anotherSekret",
    "Authorization: Bearer abcdefghijklmnop",
    `digest ${SECRET_HEX}`,
  )));
  const record = parseJsonLine(calls);
  const line = calls[0][0];
  for (const secret of [SECRET_BASE64, "anotherSekret", "abcdefghijklmnop", SECRET_HEX]) {
    assert.equal(line.includes(secret), false, `secret leaked: ${secret}`);
  }
  assert.ok(record.message.includes(REDACTED), "redaction marker present");
  assert.ok(record.message.includes("control_key=[redacted]"));
  assert.ok(record.message.includes("Bearer [redacted]"));
});

test("secret-shaped details keys are never serialized with their value", () => {
  const calls = withLogFormat("json", () => capture(() => logStructured({
    event: "spawn",
    message: "spawned",
    details: {
      session: "pi-1",
      token: SECRET_BASE64,
      apiKey: "sk-live-should-not-appear",
      nested: { controlKey: "nested-secret", scope_key: "another-secret", visible: 1 },
    },
  })));
  const record = parseJsonLine(calls);
  assert.equal(record.details.token, REDACTED);
  assert.equal(record.details.apiKey, REDACTED);
  assert.equal(record.details.nested.controlKey, REDACTED);
  assert.equal(record.details.nested.scope_key, REDACTED);
  assert.equal(record.details.nested.visible, 1);
  assert.equal(calls[0][0].includes("sk-live-should-not-appear"), false);
  assert.equal(calls[0][0].includes("nested-secret"), false);
  assert.equal(record.details.session, "pi-1");
});

test("error objects log their name and message, with credentials scrubbed", () => {
  const calls = withLogFormat("json", () => capture(() => logStructured({
    level: "warn",
    event: "state",
    message: "load failed",
    details: Object.assign(new Error(`bad token=${SECRET_BASE64}`), { code: "ENOENT" }),
  })));
  const record = parseJsonLine(calls);
  assert.deepEqual(record.details, { name: "Error", message: `bad token=${REDACTED}`, code: "ENOENT" });
  assert.equal(calls[0][0].includes(SECRET_BASE64), false);
  assert.equal(calls[0][0].includes(`${REDACTED}]`), false, "redaction is applied once, not twice");
});

test("cyclic and oversized details stay serializable and bounded", () => {
  const cyclic = { name: "loop" };
  cyclic.self = cyclic;
  const calls = withLogFormat("json", () => capture(() => logStructured({
    event: "probe",
    details: { cyclic, big: "x".repeat(10_000), many: Array.from({ length: 500 }, (_, i) => i) },
  })));
  const record = parseJsonLine(calls);
  assert.equal(record.details.cyclic.self, "[circular]");
  assert.ok(record.details.big.length < 2_100, "long strings are truncated");
  assert.equal(record.details.many.length, 101);
  assert.equal(record.details.many.at(-1), "[truncated]");
});

test("text mode still prints raw arguments so existing greps keep matching", () => {
  // The text format is what supervisors and grep-based tooling already read; it
  // must not start redacting or reshaping its payload.
  const calls = withLogFormat(undefined, () => capture(() => logLine("state", `control_key=${SECRET_BASE64}`)));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], `control_key=${SECRET_BASE64}`);
});
