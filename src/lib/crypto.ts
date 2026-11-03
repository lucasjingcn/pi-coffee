import { createHash, timingSafeEqual } from "node:crypto";

/** Hex SHA-256 of a string or buffer. */
export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Compare two secrets without leaking their length or a prefix through timing. */
export function constantTimeEquals(presented: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(presented).digest(), createHash("sha256").update(expected).digest());
}
