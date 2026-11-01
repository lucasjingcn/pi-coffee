import test from "node:test";
import assert from "node:assert/strict";
import { validateSnapshot } from "../dist/state-store.js";

test("legacy state (no schemaVersion) loads as v1 and v2 is accepted", () => {
  const legacy = validateSnapshot({ counter: 1, history: [] }, "fixture");
  assert.equal(legacy.schemaVersion, 1);
  const v2 = validateSnapshot({ schemaVersion: 2, counter: 1, history: [] }, "fixture");
  assert.equal(v2.schemaVersion, 2);
});

test("a newer state schema is refused instead of being silently misread", () => {
  assert.throws(() => validateSnapshot({ schemaVersion: 3, history: [] }, "fixture"), /newer than this daemon supports/);
});
