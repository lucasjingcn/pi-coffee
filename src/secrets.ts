/**
 * Secret detection for coordination surfaces.
 *
 * Plain transcripts are not modified: the filter runs on values that leave the
 * daemon's process boundary or become durable evidence — mailbox text, board
 * values, outcome notes, handoff reasons and evidence logs. Rejection names the
 * pattern class only; the matched value is never echoed back.
 */

export type SecretPolicy = "reject" | "redact";

export type SecretKind =
  | "openai-key"
  | "aws-access-key"
  | "github-token"
  | "slack-token"
  | "jwt"
  | "private-key"
  | "credential-assignment"
  | "credential-url"
  | "bearer-token";

interface SecretFinding {
  kind: SecretKind;
  start: number;
  end: number;
}

interface Rule {
  kind: SecretKind;
  pattern: RegExp;
}

/**
 * Ordered by specificity. Patterns are anchored on recognizable prefixes rather
 * than bare entropy so ordinary prose, hashes and base64 blobs are not flagged.
 */
const RULES: Rule[] = [
  {
    kind: "private-key",
    // A pasted/shared key is usually truncated: requiring the matching END line
    // let `-----BEGIN RSA PRIVATE KEY-----` plus a few body lines through, which
    // is exactly the shape people paste into chat. A header alone is proof
    // enough; without END the span runs to the end of the value.
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { kind: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { kind: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    kind: "credential-assignment",
    // Case-insensitive: `password:` and `api_key=` are the common spellings, and
    // an uppercase-only rule matched the least likely of them. The value is a
    // quoted string or an unquoted non-space run: restricting it to
    // `[A-Za-z0-9_-./+=]` silently accepted passwords containing `!@#$%^&*` and
    // DSNs, which are the ones a user actually pastes.
    pattern:
      /\b[A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|ACCESS[_-]?KEY)[A-Za-z0-9_]*\s*[:=]\s*(?:"[^"\n]{6,}"|'[^'\n]{6,}'|[^\s"'`,;()\[\]{}<>]{8,})/gi,
  },
  {
    kind: "credential-url",
    // `scheme://user:password@host` (database DSNs, broker URLs). The host part
    // must follow the `@`, so ordinary URLs and mail addresses stay clean.
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:[^\s/@]+@[^\s/@]+/gi,
  },
  {
    kind: "bearer-token",
    // `Authorization: Bearer <credential>` — the shape of a pasted HTTP header,
    // which the name=value rule cannot see because "Bearer" is not a name.
    pattern: /\bauthorization\b\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  },
];

/** All secret-shaped spans in `text`, merged and ordered by position. */
export function findSecrets(text: string): SecretFinding[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const found: SecretFinding[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      found.push({ kind: rule.kind, start, end });
      // Zero-length matches cannot happen with these patterns, but guard anyway.
      if (end === start) rule.pattern.lastIndex += 1;
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretFinding[] = [];
  for (const finding of found) {
    const last = merged[merged.length - 1];
    if (last && finding.start <= last.end) {
      last.end = Math.max(last.end, finding.end);
      continue;
    }
    merged.push({ ...finding });
  }
  return merged;
}

/** Unique kinds present in `text`, without any matched bytes. */
export function secretKinds(text: string): SecretKind[] {
  return [...new Set(findSecrets(text).map((finding) => finding.kind))];
}

export function containsSecret(text: string): boolean {
  return findSecrets(text).length > 0;
}

interface RedactionResult {
  text: string;
  redactions: number;
  kinds: SecretKind[];
}

/** Replace every detected span with a stable marker. Safe to call repeatedly. */
export function redactSecrets(text: string): RedactionResult {
  const findings = findSecrets(text);
  if (findings.length === 0) return { text, redactions: 0, kinds: [] };
  const kinds = [...new Set(findings.map((finding) => finding.kind))];
  let out = "";
  let cursor = 0;
  for (const finding of findings) {
    out += text.slice(cursor, finding.start);
    out += `[REDACTED:${finding.kind}]`;
    cursor = finding.end;
  }
  out += text.slice(cursor);
  return { text: out, redactions: findings.length, kinds };
}

export class SecretDetectedError extends Error {
  readonly kinds: SecretKind[];
  readonly context: string;

  constructor(context: string, kinds: SecretKind[]) {
    // Only the pattern classes are part of the message: never the value.
    super(`secret detected in ${context}: ${kinds.join(", ")}`);
    this.name = "SecretDetectedError";
    this.context = context;
    this.kinds = kinds;
  }
}

/**
 * Enforce the configured policy on one value.
 *
 * `reject` throws a {@link SecretDetectedError}; `redact` returns the scrubbed
 * text and a count so callers can record that a redaction happened.
 */
export function applySecretPolicy(
  text: string,
  policy: SecretPolicy,
  context = "value",
): RedactionResult {
  if (policy !== "reject" && policy !== "redact") {
    throw new Error(`unknown secret policy: ${String(policy)}`);
  }
  const kinds = secretKinds(text);
  if (kinds.length === 0) return { text, redactions: 0, kinds: [] };
  if (policy === "reject") throw new SecretDetectedError(context, kinds);
  return redactSecrets(text);
}

