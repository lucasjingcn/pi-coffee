import test from "node:test";
import assert from "node:assert/strict";
import {
  applySecretPolicy,
  containsSecret,
  findSecrets,
  redactSecrets,
  secretKinds,
  SecretDetectedError,
} from "../dist/secrets.js";

const OPENAI = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2";
const GITHUB = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const AWS = "AKIA" + "IOSFODNN7EXAMPLE";
const SLACK = "xoxb-" + "123456789012-123456789012-abcdefghijklmnop";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N-Xax8ZlaFLABWI4K3Jv0";
const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

test("detects each supported secret class", () => {
  assert.deepEqual(secretKinds(OPENAI), ["openai-key"]);
  assert.deepEqual(secretKinds(GITHUB), ["github-token"]);
  assert.deepEqual(secretKinds(AWS), ["aws-access-key"]);
  assert.deepEqual(secretKinds(SLACK), ["slack-token"]);
  assert.deepEqual(secretKinds(JWT), ["jwt"]);
  assert.deepEqual(secretKinds(PRIVATE_KEY), ["private-key"]);
  assert.deepEqual(secretKinds("DEEPSEEK_API_KEY=abcdefghijklmnop"), ["credential-assignment"]);
});

test("does not flag hashes, prose, uuids or short values", () => {
  const clean = [
    "commit 7f70ece9e02db0f5cf644aef0362e8c892b6d0d",
    "sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "the token must be rotated before the release",
    "call the api key endpoint with a bearer header",
    "id 01a19354-338c-70f5-b250-dbe29410c790",
    "password: short",
    "mode=redact",
  ];
  for (const text of clean) assert.equal(containsSecret(text), false, text);
});

test("detects lower-case assignments and Authorization headers", () => {
  // The default policy is `reject`, so a case-sensitive rule silently let the
  // most common spellings through to mailbox/board/outcome text.
  for (const text of [
    "password: hunter2hunter2",
    "api_key=abcdefghijklmnop",
    "mysql_password=correcthorsebattery",
    "Authorization: Bearer abcdefghijklmnopqrst",
    "authorization=Bearer abcdefghijklmnopqrst",
  ]) {
    assert.equal(containsSecret(text), true, text);
  }
  assert.deepEqual(secretKinds("Authorization: Bearer abcdefghijklmnopqrst"), ["bearer-token"]);
  // Prose that merely mentions the words stays clean.
  assert.equal(containsSecret("rotate the bearer token before release"), false);
});

test("redaction replaces spans and is idempotent", () => {
  const text = `use ${OPENAI} then ${GITHUB} now`;
  const result = redactSecrets(text);
  assert.equal(result.redactions, 2);
  assert.ok(result.text.includes("[REDACTED:openai-key]"));
  assert.ok(result.text.includes("[REDACTED:github-token]"));
  assert.equal(containsSecret(result.text), false);
  assert.equal(redactSecrets(result.text).redactions, 0);
});

test("overlapping findings are merged once", () => {
  const findings = findSecrets(`export OPENAI_API_KEY=${OPENAI}`);
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.ok(finding.start >= 0 && finding.end <= `export OPENAI_API_KEY=${OPENAI}`.length);
});

test("reject policy throws with the class, never the value", () => {
  let error;
  try {
    applySecretPolicy(`here it is: ${OPENAI}`, "reject", "mailbox text");
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof SecretDetectedError);
  assert.match(error.message, /secret detected in mailbox text: openai-key/);
  assert.ok(!error.message.includes(OPENAI));
  assert.deepEqual(error.kinds, ["openai-key"]);
});

test("redact policy returns scrubbed text and counts", () => {
  const result = applySecretPolicy(`key ${AWS}`, "redact", "board value");
  assert.equal(result.redactions, 1);
  assert.ok(result.text.includes("[REDACTED:aws-access-key]"));
  assert.deepEqual(result.kinds, ["aws-access-key"]);
});

test("unknown policies are rejected", () => {
  assert.throws(() => applySecretPolicy("plain", "ignore"), /unknown secret policy/);
});
