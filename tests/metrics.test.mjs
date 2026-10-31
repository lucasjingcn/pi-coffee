import test from "node:test";
import assert from "node:assert/strict";
import { METRICS_CONTENT_TYPE, buildMetricsSnapshot, renderMetrics } from "../dist/metrics.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const SAMPLE_LINE = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9]+(\.[0-9]+)?$/;

function snapshot(overrides = {}) {
  return {
    uptimeSeconds: 0,
    activeWorkers: 0,
    maxSessions: 0,
    draining: false,
    sessionsTotal: {},
    spawnsTotal: 0,
    verificationsTotal: 0,
    mergesTotal: 0,
    ...overrides,
  };
}

/**
 * Minimal but strict exposition parser: it accepts exactly the line shapes the
 * format allows (HELP, TYPE, sample) and rejects everything else, so a rendering
 * bug fails here instead of in Prometheus.
 */
function parseExposition(text) {
  assert.ok(text.endsWith("\n"), "exposition ends with a newline");
  const lines = text.split("\n");
  assert.equal(lines.pop(), "", "no content after the final newline");
  const families = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("# HELP ")) {
      const [name, ...help] = line.slice("# HELP ".length).split(" ");
      assert.match(name, METRIC_NAME);
      assert.equal(families.filter((family) => family.name === name).length, 0, `${name} appears once`);
      current = { name, help: help.join(" "), type: null, samples: [] };
      families.push(current);
      continue;
    }
    if (line.startsWith("# TYPE ")) {
      assert.ok(current, "TYPE belongs to a family");
      assert.equal(current.type, null, "one TYPE per family");
      const [name, type] = line.slice("# TYPE ".length).split(" ");
      assert.equal(name, current.name);
      assert.ok(type === "gauge" || type === "counter", `unknown metric type: ${type}`);
      current.type = type;
      continue;
    }
    assert.ok(!line.startsWith("#"), `unexpected comment line: ${line}`);
    assert.match(line, SAMPLE_LINE, `malformed sample line: ${line}`);
    assert.ok(current && current.type, "sample lines follow HELP and TYPE");
    const [metric, value] = line.split(" ");
    const base = metric.replace(/\{.*$/, "");
    assert.equal(base, current.name, "sample name matches its family");
    current.samples.push({ labels: parseLabels(metric), value: Number(value) });
  }
  for (const family of families) assert.ok(family.type, `family ${family.name} has a TYPE`);
  return families;
}

function parseLabels(metric) {
  const inner = metric.match(/\{(.*)\}$/)?.[1];
  if (!inner) return {};
  const labels = {};
  for (const pair of inner.split(",")) {
    const match = pair.match(/^([a-zA-Z_][a-zA-Z0-9_]*)="(.*)"$/);
    assert.ok(match, `malformed label: ${pair}`);
    labels[match[1]] = match[2];
  }
  return labels;
}

function byName(families) {
  return new Map(families.map((family) => [family.name, family]));
}

const FULL = snapshot({
  uptimeSeconds: 12.5,
  activeWorkers: 2,
  maxSessions: 8,
  draining: true,
  sessionsTotal: { idle: 1, working: 2, stopped: 0, error: 1 },
  spawnsTotal: 5,
  verificationsTotal: 3,
  mergesTotal: 1,
  costUsdTotal: 1.25,
});

// ---------------------------------------------------------------------------
// Exposition validity, sorting, determinism
// ---------------------------------------------------------------------------

test("renders valid Prometheus text with HELP/TYPE before every family's samples", () => {
  const text = renderMetrics(FULL);
  const families = parseExposition(text);
  assert.equal(METRICS_CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8");
  const names = families.map((family) => family.name);
  assert.deepEqual(names, [
    "pi_coffee_active_workers",
    "pi_coffee_cost_usd_total",
    "pi_coffee_draining",
    "pi_coffee_max_sessions",
    "pi_coffee_merges_total",
    "pi_coffee_sessions",
    "pi_coffee_spawns_total",
    "pi_coffee_uptime_seconds",
    "pi_coffee_verifications_total",
  ]);
  assert.deepEqual(names, [...names].sort(), "metric families are sorted by name");
  for (const family of families) {
    assert.ok(family.help.length > 0, `${family.name} has HELP text`);
    assert.ok(family.samples.length > 0, `${family.name} has at least one sample`);
  }
  const metrics = byName(families);
  assert.equal(metrics.get("pi_coffee_uptime_seconds").samples[0].value, 12.5);
  assert.equal(metrics.get("pi_coffee_active_workers").samples[0].value, 2);
  assert.equal(metrics.get("pi_coffee_max_sessions").samples[0].value, 8);
  assert.equal(metrics.get("pi_coffee_draining").samples[0].value, 1);
  assert.equal(metrics.get("pi_coffee_draining").type, "gauge");
  assert.equal(metrics.get("pi_coffee_spawns_total").samples[0].value, 5);
  assert.equal(metrics.get("pi_coffee_spawns_total").type, "counter");
  assert.equal(metrics.get("pi_coffee_verifications_total").samples[0].value, 3);
  assert.equal(metrics.get("pi_coffee_merges_total").samples[0].value, 1);
  assert.equal(metrics.get("pi_coffee_cost_usd_total").samples[0].value, 1.25);
});

test("session statuses are labelled, sorted by status, and zero counts are omitted", () => {
  const metrics = byName(parseExposition(renderMetrics(FULL)));
  const samples = metrics.get("pi_coffee_sessions").samples;
  assert.deepEqual(samples.map((sample) => sample.labels.status), ["error", "idle", "working"]);
  assert.deepEqual(samples.map((sample) => sample.value), [1, 1, 2]);
  assert.ok(!samples.some((sample) => sample.labels.status === "stopped"), "a zero count is not rendered");
});

test("rendering is deterministic and independent of key insertion order", () => {
  const reordered = snapshot({ ...FULL, sessionsTotal: { error: 1, working: 2, idle: 1 } });
  assert.equal(renderMetrics(FULL), renderMetrics(FULL));
  assert.equal(renderMetrics(FULL), renderMetrics(reordered));
});

test("an empty snapshot still renders every unconditional family", () => {
  const metrics = byName(parseExposition(renderMetrics(snapshot())));
  assert.equal(metrics.get("pi_coffee_uptime_seconds").samples[0].value, 0);
  assert.equal(metrics.get("pi_coffee_active_workers").samples[0].value, 0);
  assert.equal(metrics.get("pi_coffee_draining").samples[0].value, 0);
  assert.ok(!metrics.has("pi_coffee_sessions"), "no statuses means no series");
});

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

test("label values escape backslash, newline and quote so the line stays parseable", () => {
  const text = renderMetrics(snapshot({
    sessionsTotal: { 'we"ird\\status\nsecond': 1 },
    uptimeSeconds: 1,
    maxSessions: 1,
  }));
  assert.ok(text.includes('status="we\\"ird\\\\status\\nsecond"'), `escaped label in:\n${text}`);
  const samples = byName(parseExposition(text)).get("pi_coffee_sessions").samples;
  assert.equal(samples.length, 1);
  assert.equal(samples[0].labels.status, 'we\\"ird\\\\status\\nsecond');
  const raw = text.split("\n").find((line) => line.startsWith("pi_coffee_sessions"));
  assert.equal(raw.split("\n").length, 1, "the escaped newline does not break the sample line");
});

// ---------------------------------------------------------------------------
// Unknown cost: omitted, never zero-filled
// ---------------------------------------------------------------------------

test("unknown cost is omitted rather than reported as zero", () => {
  const unknown = renderMetrics(snapshot({ maxSessions: 4 }));
  assert.ok(!unknown.includes("pi_coffee_cost_usd_total"), "no cost series while cost is unknown");
  const explicitUnknown = renderMetrics(snapshot({ maxSessions: 4, costUsdTotal: null }));
  assert.ok(!explicitUnknown.includes("pi_coffee_cost_usd_total"), "null cost is unknown too");
  const nan = renderMetrics(snapshot({ maxSessions: 4, costUsdTotal: Number.NaN }));
  assert.ok(!nan.includes("pi_coffee_cost_usd_total"), "a non-finite cost is not a measurement");
});

test("a measured zero cost is still rendered", () => {
  const metrics = byName(parseExposition(renderMetrics(snapshot({ maxSessions: 4, costUsdTotal: 0 }))));
  assert.equal(metrics.get("pi_coffee_cost_usd_total").samples[0].value, 0);
});

// ---------------------------------------------------------------------------
// Sanitising bad numbers
// ---------------------------------------------------------------------------

test("non-finite gauges clamp to zero and counters never go negative", () => {
  const metrics = byName(parseExposition(renderMetrics(snapshot({
    uptimeSeconds: Number.NaN,
    activeWorkers: Number.POSITIVE_INFINITY,
    maxSessions: -3,
    spawnsTotal: -7,
    verificationsTotal: 2.9,
  }))));
  assert.equal(metrics.get("pi_coffee_uptime_seconds").samples[0].value, 0);
  assert.equal(metrics.get("pi_coffee_active_workers").samples[0].value, 0);
  assert.equal(metrics.get("pi_coffee_spawns_total").samples[0].value, 0);
  assert.equal(metrics.get("pi_coffee_verifications_total").samples[0].value, 2);
  assert.equal(metrics.get("pi_coffee_merges_total").samples[0].value, 0);
});

// ---------------------------------------------------------------------------
// buildMetricsSnapshot: public coordinator state only
// ---------------------------------------------------------------------------

function fakeCoordinator({ sessions = [], worker = { currency: "USD", total: null }, activeWorkers = 0, maxSessions = 4 } = {}) {
  return {
    config: { maxSessions },
    activeWorkers: () => activeWorkers,
    metrics: async () => ({ sessions, worker }),
  };
}

test("buildMetricsSnapshot maps coordinator state onto the snapshot", async () => {
  const coord = fakeCoordinator({
    activeWorkers: 2,
    maxSessions: 6,
    worker: { currency: "USD", total: 12.5 },
    sessions: [
      { id: "pi-1", status: "working", verification: { id: "v1", passed: true }, integration: { workerSha: "abc" } },
      { id: "pi-2", status: "idle" },
      { id: "pi-3", status: "stopped", verification: { id: "v2", passed: false } },
    ],
  });
  const built = await buildMetricsSnapshot(coord, Date.now() - 5_000);
  assert.equal(built.activeWorkers, 2);
  assert.equal(built.maxSessions, 6);
  assert.equal(built.draining, false);
  assert.deepEqual(built.sessionsTotal, { working: 1, idle: 1, stopped: 1 });
  assert.equal(built.spawnsTotal, 3);
  assert.equal(built.verificationsTotal, 2);
  assert.equal(built.mergesTotal, 1);
  assert.equal(built.costUsdTotal, 12.5);
  assert.ok(built.uptimeSeconds >= 5 && built.uptimeSeconds < 600, `uptime ${built.uptimeSeconds}`);
});

test("buildMetricsSnapshot leaves cost unknown when the worker total is incomplete", async () => {
  const sessions = [{ id: "pi-1", status: "working" }, { id: "pi-2", status: "working" }];
  const unknown = await buildMetricsSnapshot(fakeCoordinator({ sessions, worker: { currency: "USD", total: null } }), Date.now());
  assert.equal(unknown.costUsdTotal, undefined);
  assert.ok(!renderMetrics(unknown).includes("pi_coffee_cost_usd_total"));

  const otherCurrency = await buildMetricsSnapshot(
    fakeCoordinator({ sessions, worker: { currency: "EUR", total: 4 } }),
    Date.now(),
  );
  assert.equal(otherCurrency.costUsdTotal, undefined, "non-USD totals are not reported as USD");

  const known = await buildMetricsSnapshot(fakeCoordinator({ sessions, worker: { currency: "USD", total: 0 } }), Date.now());
  assert.equal(known.costUsdTotal, 0, "a complete total of zero is a measurement");
});

test("buildMetricsSnapshot never leaks session credentials and honours draining", async () => {
  const coord = fakeCoordinator({
    sessions: [{ id: "pi-1", status: "working", controlKeyHash: "a".repeat(64), scopeKeyHash: "b".repeat(64) }],
  });
  const built = await buildMetricsSnapshot(coord, Date.now(), true);
  assert.equal(built.draining, true);
  const text = renderMetrics(built);
  assert.equal(JSON.stringify(built).includes("a".repeat(64)), false, "no control key hash in the snapshot");
  assert.equal(text.includes("a".repeat(64)), false, "no control key hash in the exposition");
  assert.equal(text.includes("b".repeat(64)), false, "no scope key hash in the exposition");
  assert.ok(text.includes("pi_coffee_draining 1"));
});

test("buildMetricsSnapshot tolerates a coordinator without evidence yet", async () => {
  const built = await buildMetricsSnapshot({ config: { maxSessions: 2 }, activeWorkers: () => 0, metrics: async () => ({}) }, Date.now());
  assert.deepEqual(built.sessionsTotal, {});
  assert.equal(built.spawnsTotal, 0);
  assert.equal(built.costUsdTotal, undefined);
  parseExposition(renderMetrics(built));
});
