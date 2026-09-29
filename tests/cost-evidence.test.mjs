import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCostEvidence, validateCostRecord } from "../dist/cost-evidence.js";

const session = (id, cost, extra = {}) => ({ id, cost, ...extra });
const record = (id, amount, session_ids, extra = {}) => ({ id, amount, session_ids, currency: "USD", source: "provider", reference: `invoice:${id}`, ...extra });

test("active snapshot wins over history and latest active duplicate wins", () => {
  const result = summarizeCostEvidence({
    history: [session("pi-1", 100, { lastActivity: 100 }), session("pi-2", 3, { lastActivity: 2 }), session("pi-2", 2, { lastActivity: 1 })],
    active: [session("pi-1", 1, { lastActivity: 1 }), session("pi-1", 4, { lastActivity: 2 })],
  });
  assert.equal(result.worker.total, 7);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.orchestrator.total, null);
});

test("archived, abandoned, error and reworked sessions retain their cost", () => {
  const result = summarizeCostEvidence({ active: [], history: [
    session("archived", 1, { status: "stopped", outcome: "success_first" }),
    session("failure", 2, { status: "error", outcome: "abandoned" }),
    session("rework", 3, { outcome: "success_second" }),
  ], orchestrator_records: [record("all", 4, ["archived", "failure", "rework"])] });
  assert.equal(result.worker.total, 6);
  assert.equal(result.combined.total, 10);
  assert.equal(result.combined.complete, true);
  assert.equal("savings" in result, false);
});

test("unknown costs cannot become zero and zero reported costs are valid", () => {
  const result = summarizeCostEvidence({ active: [session("known", 0), session("unknown", undefined), session("invalid", NaN)], history: [], orchestrator_records: [record("all", 0, ["known", "unknown", "invalid"])] });
  assert.equal(result.worker.total, null);
  assert.equal(result.worker.known_subtotal, 0);
  assert.deepEqual(result.worker.missing_session_ids, ["unknown", "invalid"]);
  assert.equal(result.sessions[1].cost, null);
  assert.equal(result.combined.total, null);
  assert.equal(result.worker.complete, false);
});

test("multiple actual orchestrator usages covering the same session all count with sources", () => {
  const result = summarizeCostEvidence({ active: [session("a", 2)], history: [], orchestrator_records: [
    record("usage-1", 1, ["a"]), record("usage-2", 3, ["a"], { source: "manual" }), record("usage-3", 4, ["a"], { source: "estimate" }),
  ] });
  assert.equal(result.orchestrator.total, 8);
  assert.equal(result.combined.total, 10);
  assert.deepEqual(result.orchestrator.sources, ["provider", "manual", "estimate"]);
  assert.equal(result.orchestrator.records[1].reference, "invoice:usage-2");
});

test("currencies do not get silently summed or converted", () => {
  const input = { active: [session("a", 2), session("b", 3)], history: [] };
  const result = summarizeCostEvidence({ ...input, orchestrator_records: [record("a", 1, ["a"]), record("b", 10, ["b"], { currency: "CNY" })] });
  assert.equal(result.orchestrator.total, null);
  assert.deepEqual(result.orchestrator.known_subtotals, { USD: 1, CNY: 10 });
  assert.equal(result.combined.total, null);
  assert.match(result.combined.reasons.join(" "), /Currencies differ/);
  const otherCurrency = summarizeCostEvidence({ ...input, orchestrator_records: [record("both", 10, ["a", "b"], { currency: "CNY" })] });
  assert.equal(otherCurrency.orchestrator.total, 10);
  assert.equal(otherCurrency.combined.total, null);
});

test("filter scope excludes unrelated records and refuses to apportion shared amounts", () => {
  const input = { active: [session("a", 2), session("b", 3)], history: [], session_ids: ["a"] };
  const result = summarizeCostEvidence({ ...input, orchestrator_records: [record("shared", 10, ["a", "b"]), record("unrelated", 6, ["b"])] });
  assert.equal(result.worker.total, 2);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.orchestrator.total, null);
  assert.deepEqual(result.orchestrator.excluded_record_ids, ["shared"]);
  assert.deepEqual(result.orchestrator.missing_session_ids, ["a"]);
  const exact = summarizeCostEvidence({ ...input, orchestrator_records: [record("exact", 4, ["a"]), record("unrelated", 6, ["b"])] });
  assert.equal(exact.combined.total, 6);
});

test("missing requested session prevents completeness despite a cost record", () => {
  const result = summarizeCostEvidence({ active: [], history: [], session_ids: ["missing"], orchestrator_records: [record("unknown", 1, ["missing"])] });
  assert.deepEqual(result.unknown_session_ids, ["missing"]);
  assert.equal(result.worker.total, null);
  assert.equal(result.orchestrator.total, null);
  assert.equal(result.combined.total, null);
});

test("identical record id is idempotent while conflicting record id is rejected", () => {
  const same = record("same", 2, ["a", "b"]);
  const input = { active: [session("a", 1), session("b", 1)], history: [] };
  assert.equal(summarizeCostEvidence({ ...input, orchestrator_records: [same, { ...same, session_ids: ["b", "a"] }] }).orchestrator.total, 2);
  assert.throws(() => summarizeCostEvidence({ ...input, orchestrator_records: [same, { ...same, amount: 3 }] }), /Conflicting cost record id/);
});

test("record validation preserves source and rejects malformed amounts and provenance", () => {
  assert.equal(validateCostRecord(record("a", 0, ["a"], { currency: "usd" })).currency, "USD");
  for (const amount of [-1, NaN, Infinity, "3"]) assert.throws(() => validateCostRecord(record("a", amount, ["a"])), /finite and nonnegative/);
  for (const extra of [{ reference: "" }, { source: "auto" }, { currency: "" }, { id: "" }, { session_ids: [] }, { session_ids: ["a", "a"] }]) {
    assert.throws(() => validateCostRecord(record("a", 1, ["a"], extra)));
  }
});

test("token totals remain partial activity evidence when fields are missing", () => {
  const result = summarizeCostEvidence({ active: [session("a", 2, { tokens: { output: 10 } }), session("b", 1)], history: [] });
  assert.equal(result.activity.tokens.output.known_subtotal, 10);
  assert.equal(result.activity.tokens.output.complete, false);
  assert.deepEqual(result.activity.tokens.output.missing_session_ids, ["b"]);
  assert.match(result.note, /do not establish savings/);
});

test("finite individual amounts cannot overflow into a fabricated JSON null total", () => {
  const input = { active: [session("a", 1), session("b", 1)], history: [] };
  assert.throws(() => summarizeCostEvidence({ ...input, active: [session("a", Number.MAX_VALUE), session("b", Number.MAX_VALUE)] }), /Worker cost total/);
  assert.throws(() => summarizeCostEvidence({ ...input, orchestrator_records: [record("a", Number.MAX_VALUE, ["a"]), record("b", Number.MAX_VALUE, ["b"])] }), /Orchestrator cost total/);
  assert.throws(() => summarizeCostEvidence({ active: [session("a", Number.MAX_VALUE)], history: [], orchestrator_records: [record("a", Number.MAX_VALUE, ["a"])] }), /Combined cost total/);
});
