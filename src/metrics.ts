import type { Coordinator } from "./manager.js";

/**
 * Prometheus text exposition (version 0.0.4) for the coordinator.
 *
 * Two halves, deliberately separate:
 *
 *  - `renderMetrics(snapshot)` is pure and deterministic: same snapshot in, same
 *    bytes out. Metric families are sorted by name and label sets by label
 *    value, so a diff of two scrapes only shows real changes.
 *  - `buildMetricsSnapshot(coord, startedAt)` reads live coordinator state. It
 *    only uses public coordinator methods and imports `Coordinator` as a type,
 *    so this module can never create an import cycle with the manager.
 *
 * The one rule that shapes the data model: an unknown value is *omitted*, never
 * reported as `0`. A dashboard that plots a zero it never measured is worse than
 * a dashboard with a gap. `costUsdTotal` is therefore optional, and its absence
 * is the signal that at least one session's cost was never reported.
 */

/** Content type for a Prometheus scrape response (`text/plain` 0.0.4 exposition). */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Metric name prefix; every family this module exposes starts with it. */
export const METRICS_PREFIX = "pi_coffee_";

/**
 * Everything the renderer needs, as plain data. Callers may construct this by
 * hand (tests, fixtures) or let `buildMetricsSnapshot` derive it.
 *
 * `sessionsTotal` maps a session status to the number of sessions in it; entries
 * with a count of `0` are not rendered (Prometheus treats a missing series as
 * zero, so emitting them would only add noise).
 *
 * `costUsdTotal` is undefined/null when the total is unknown. A real `0` is
 * still rendered, because "we measured zero" and "we never measured" are
 * different facts.
 */
export interface MetricsSnapshot {
  /** Seconds since the coordinator started. */
  uptimeSeconds: number;
  /** Workers currently occupying a concurrency slot. */
  activeWorkers: number;
  /** Configured concurrency cap. */
  maxSessions: number;
  /** True while the coordinator refuses new work (shutdown/drain). */
  draining: boolean;
  /** Session counts keyed by status. */
  sessionsTotal: Record<string, number>;
  /** Sessions created since the coordinator started (archived ones included). */
  spawnsTotal: number;
  /** Sessions that reached a verification candidate. */
  verificationsTotal: number;
  /** Sessions whose branch was merged into its target. */
  mergesTotal: number;
  /** Worker-reported session cost in USD; omitted when any session cost is unknown. */
  costUsdTotal?: number | null;
}

type MetricType = "gauge" | "counter";

interface Sample {
  labels?: Record<string, string>;
  value: number;
}

interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  samples: Sample[];
}

/** A finite number, or `fallback` when the input is NaN/Infinity/not a number. */
function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Gauges may legitimately be fractional; a non-finite gauge is a bug, so clamp to 0. */
function gauge(value: unknown): number {
  return finite(value, 0);
}

/** Counters are whole, non-negative, and monotonic; anything else is clamped. */
function counter(value: unknown): number {
  const n = finite(value, 0);
  return n > 0 ? Math.trunc(n) : 0;
}

/**
 * Format a sample value the way the text exposition format wants it: a plain
 * decimal number, never exponent notation for everyday magnitudes (Prometheus
 * parses exponents, but humans and diff tools prefer `12.5`).
 */
function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  // Three decimals is well below any timestamp/cost resolution we report.
  const rounded = Number(value.toFixed(3));
  return String(rounded);
}

/** Escape a label value: backslash, newline and double quote are the only escapes. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** HELP text is a bare string, so only backslash and newline need escaping. */
function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Render one sample line: `name{k="v",...} value`, labels sorted by key. */
function renderSample(name: string, sample: Sample): string {
  const entries = Object.entries(sample.labels ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const labels = entries.length
    ? `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`
    : "";
  return `${name}${labels} ${formatValue(sample.value)}`;
}

/** Render one family: HELP, TYPE, then its (already sorted) samples. */
function renderFamily(family: MetricFamily): string {
  return [
    `# HELP ${family.name} ${escapeHelp(family.help)}`,
    `# TYPE ${family.name} ${family.type}`,
    ...family.samples.map((sample) => renderSample(family.name, sample)),
  ].join("\n") + "\n";
}

/**
 * Render a snapshot as Prometheus text exposition.
 *
 * Pure: no clock, no I/O, no ambient state. Families are emitted in ascending
 * name order and labelled samples in ascending label order, so output is stable
 * across runs and machines. The result always ends with a newline.
 */
export function renderMetrics(snapshot: MetricsSnapshot): string {
  const families: MetricFamily[] = [
    {
      name: `${METRICS_PREFIX}uptime_seconds`,
      help: "Seconds since the coordinator daemon started.",
      type: "gauge",
      samples: [{ value: gauge(snapshot?.uptimeSeconds) }],
    },
    {
      name: `${METRICS_PREFIX}active_workers`,
      help: "Workers currently occupying a concurrency slot.",
      type: "gauge",
      samples: [{ value: gauge(snapshot?.activeWorkers) }],
    },
    {
      name: `${METRICS_PREFIX}max_sessions`,
      help: "Configured cap on concurrent worker sessions.",
      type: "gauge",
      samples: [{ value: gauge(snapshot?.maxSessions) }],
    },
    {
      name: `${METRICS_PREFIX}draining`,
      help: "1 while the coordinator refuses new work (shutdown/drain), 0 otherwise.",
      type: "gauge",
      samples: [{ value: snapshot?.draining === true ? 1 : 0 }],
    },
    {
      // A gauge, so no `_total` suffix: `_total` is reserved for counters, and
      // `spawns_total` already counts creations.
      name: `${METRICS_PREFIX}sessions`,
      help: "Sessions known to the coordinator, by lifecycle status (zero counts omitted).",
      type: "gauge",
      samples: renderStatusSamples(snapshot?.sessionsTotal),
    },
    {
      name: `${METRICS_PREFIX}spawns_total`,
      help: "Worker sessions spawned since the coordinator started.",
      type: "counter",
      samples: [{ value: counter(snapshot?.spawnsTotal) }],
    },
    {
      name: `${METRICS_PREFIX}verifications_total`,
      help: "Sessions that reached a verification candidate.",
      type: "counter",
      samples: [{ value: counter(snapshot?.verificationsTotal) }],
    },
    {
      name: `${METRICS_PREFIX}merges_total`,
      help: "Sessions whose branch was merged into its target branch.",
      type: "counter",
      samples: [{ value: counter(snapshot?.mergesTotal) }],
    },
  ];

  // Unknown cost is omitted rather than zero-filled: absence is the signal.
  const cost = snapshot?.costUsdTotal;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
    families.push({
      name: `${METRICS_PREFIX}cost_usd_total`,
      help: "Worker-reported session cost in USD; absent while any session cost is unknown.",
      type: "gauge",
      samples: [{ value: cost }],
    });
  }

  // A family with no series is not a measurement: emit nothing rather than an
  // empty HELP/TYPE pair, so "no sessions" and "no data" stay distinguishable.
  return families
    .filter((family) => family.samples.length > 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(renderFamily)
    .join("");
}

/** One sample per non-zero status count, sorted by status label value. */
function renderStatusSamples(totals: Record<string, number> | undefined): Sample[] {
  if (!totals || typeof totals !== "object") return [];
  return Object.entries(totals)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0)
    .map(([status, value]) => ({ labels: { status }, value: gauge(value) }))
    .sort((a, b) => {
      const left = a.labels?.status ?? "";
      const right = b.labels?.status ?? "";
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

// ---------------------------------------------------------------------------
// Live snapshot from coordinator state
// ---------------------------------------------------------------------------

/** Narrow an unknown to a plain record without asserting anything about its fields. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Build a snapshot from live coordinator state using only public methods:
 * `activeWorkers()`, `config.maxSessions` and `metrics()` (the existing cost- and
 * session-evidence report). Nothing private is read, and no session credential
 * (`controlKeyHash`/`scopeKeyHash`) ever reaches a metric.
 *
 * `metrics()` refreshes worker stats, so this is async; a scrape costs one such
 * refresh, not one per metric. `draining` has no daemon-side source of truth
 * yet, so a shutting-down caller passes it explicitly.
 */
export async function buildMetricsSnapshot(
  coord: Coordinator,
  startedAt: number,
  draining = false,
): Promise<MetricsSnapshot> {
  const evidence = asRecord(await coord.metrics()) ?? {};
  const sessions = asArray(evidence.sessions).map(asRecord).filter((entry): entry is Record<string, unknown> => !!entry);

  const sessionsTotal: Record<string, number> = {};
  let verificationsTotal = 0;
  let mergesTotal = 0;
  for (const session of sessions) {
    const status = asString(session.status);
    if (status) sessionsTotal[status] = (sessionsTotal[status] ?? 0) + 1;
    if (asRecord(session.verification)) verificationsTotal++;
    if (asRecord(session.integration)) mergesTotal++;
  }

  // Worker-reported cost is only meaningful when it is complete; a partial sum
  // would silently understate spend, so an incomplete total stays unknown.
  const worker = asRecord(evidence.worker);
  const currency = asString(worker?.currency) ?? "USD";
  const knownCost = asNumber(worker?.total);
  const costUsdTotal = knownCost !== undefined && currency === "USD" ? knownCost : undefined;

  const elapsedSeconds = (Date.now() - finite(startedAt, Date.now())) / 1000;

  return {
    uptimeSeconds: elapsedSeconds > 0 ? elapsedSeconds : 0,
    activeWorkers: gauge(coord.activeWorkers()),
    maxSessions: gauge(coord.config.maxSessions),
    draining: draining === true,
    sessionsTotal,
    spawnsTotal: counter(typeof coord.spawnsSinceStart === "function" ? coord.spawnsSinceStart() : sessions.length),
    verificationsTotal: counter(verificationsTotal),
    mergesTotal: counter(mergesTotal),
    costUsdTotal,
  };
}
