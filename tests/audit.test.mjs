import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditLog,
  GENESIS_HASH,
  auditEntryHash,
  auditPayloadSha256,
  buildAuditEntry,
  canonicalJson,
  verifyAuditEntries,
} from "../dist/audit.js";

async function withLog(fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-coffee-audit-"));
  try {
    await fn(dir, new AuditLog({ dir, ...options }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("canonical json sorts keys and drops undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: undefined } }), '{"a":{"d":2},"b":1}');
  assert.equal(canonicalJson([{ z: 1, y: 2 }]), '[{"y":2,"z":1}]');
});

test("entries chain and verify", async () => {
  await withLog(async (_dir, log) => {
    let clock = 1_000;
    const fixed = new AuditLog({ dir: log.dir, now: () => (clock += 1) });
    const a = await fixed.append("orchestrator", "spawn", "s1", { scope: 2 });
    const b = await fixed.append("worker:s1", "commit", "s1", { sha: "abc" });
    const c = await fixed.append("orchestrator", "merge", "s1");
    assert.equal(a.seq, 1);
    assert.equal(a.prevHash, GENESIS_HASH);
    assert.equal(b.prevHash, a.hash);
    assert.equal(c.prevHash, b.hash);
    const result = await fixed.verify();
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.entries, 3);
    const tail = await fixed.tail(2);
    assert.deepEqual(tail.map((entry) => entry.action), ["commit", "merge"]);
    assert.ok((await fixed.sizeBytes()) > 0);
  });
});

test("tampering with a payload is detected", async () => {
  await withLog(async (dir) => {
    const log = new AuditLog({ dir });
    await log.append("orchestrator", "spawn", "s1");
    await log.append("orchestrator", "merge", "s1");
    const file = join(dir, "audit-0001.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const entry = JSON.parse(lines[0]);
    entry.target = "s2";
    lines[0] = JSON.stringify(entry);
    await writeFile(file, lines.join("\n") + "\n");
    const result = await log.verify();
    assert.equal(result.ok, false);
    assert.equal(result.firstBrokenSeq, 1);
    assert.match(result.reason, /payload hash mismatch/);
  });
});

test("truncating the tail is detected through the head sidecar", async () => {
  await withLog(async (dir, log) => {
    await log.append("orchestrator", "spawn", "s1");
    await log.append("orchestrator", "merge", "s1");
    const file = join(dir, "audit-0001.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    await writeFile(file, lines[0] + "\n");
    const result = await log.verify();
    assert.equal(result.ok, false);
    assert.match(result.reason, /audit head claims seq 2 but log ends at 1/);
  });
});

test("deleting the head sidecar fails closed until the next append repairs it", async () => {
  await withLog(async (dir, log) => {
    await log.append("orchestrator", "spawn", "s1");
    await rm(join(dir, "audit.head.json"));
    const broken = await log.verify();
    assert.equal(broken.ok, false);
    assert.match(broken.reason, /head sidecar is missing/);
    const appended = await new AuditLog({ dir }).append("orchestrator", "merge", "s1");
    assert.equal(appended.seq, 2);
    const repaired = await new AuditLog({ dir }).verify();
    assert.equal(repaired.ok, true, repaired.reason);
  });
});

test("a failed head-sidecar write does not make the next append reuse its seq", async () => {
  await withLog(async (dir, log) => {
    await log.append("orchestrator", "spawn", "s1");
    // Make the sidecar write fail once: replace the head file with a directory so
    // the atomic rename cannot land, then restore it.
    const head = join(dir, "audit.head.json");
    const saved = await readFile(head, "utf8");
    await rm(head);
    await mkdir(head, { recursive: true });
    await assert.rejects(log.append("orchestrator", "verify", "s1"));
    await rm(head, { recursive: true, force: true });
    await writeFile(head, saved);
    const next = await log.append("orchestrator", "merge", "s1");
    assert.equal(next.seq, 3, "the durable entry from the failed append still owns seq 2");
    const verified = await log.verify();
    assert.equal(verified.ok, true, verified.reason);
  });
});

test("reordering entries is detected", async () => {
  await withLog(async (dir, log) => {
    await log.append("orchestrator", "spawn", "s1");
    await log.append("orchestrator", "commit", "s1");
    await log.append("orchestrator", "merge", "s1");
    const file = join(dir, "audit-0001.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const swapped = [lines[0], lines[2], lines[1]].join("\n") + "\n";
    await writeFile(file, swapped);
    const result = await log.verify();
    assert.equal(result.ok, false);
    assert.equal(result.firstBrokenSeq, 3);
  });
});

test("rotation keeps the chain continuous across files", async () => {
  await withLog(async (dir) => {
    const log = new AuditLog({ dir, maxBytes: 300, now: (() => { let t = 1; return () => (t += 1); })() });
    for (let i = 0; i < 8; i += 1) await log.append("orchestrator", "spawn", `s${i}`);
    const result = await log.verify();
    assert.equal(result.ok, true, result.reason);
    assert.ok(result.files.length >= 2, `expected rotation, got ${result.files.join(",")}`);
    const entries = (await log.entries()).entries;
    assert.equal(entries.length, 8);
    for (let i = 1; i < entries.length; i += 1) assert.equal(entries[i].prevHash, entries[i - 1].hash);
  });
});

test("pure verification catches duplicate seqs and bad payload hashes", () => {
  const first = buildAuditEntry(GENESIS_HASH, 1, 10, "a", "spawn", "s1");
  const second = buildAuditEntry(first.hash, 2, 11, "a", "merge", "s1");
  assert.equal(verifyAuditEntries([first, second]).ok, true);
  const duplicate = [first, { ...second, seq: 2, prevHash: first.prevHash }];
  assert.equal(verifyAuditEntries(duplicate).ok, false);
  const forged = { ...second, hash: auditEntryHash(second.prevHash, 2, 11, "deadbeef") };
  assert.equal(verifyAuditEntries([first, forged]).ok, false);
  assert.notEqual(auditPayloadSha256("a", "spawn", "s1"), auditPayloadSha256("a", "spawn", "s2"));
});
