import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile } from "../scripts/lib/env.mjs";

test("parseEnvFile drops inline comments without harming quoted or comment-bearing values", () => {
  const env = parseEnvFile(
    [
      "PI_COFFEE_THINKING=max", // no comment
      "PI_COFFEE_MODEL='glm-5.3'  # note with spaces",
      "PI_COFFEE_WORKER=deepseek-flash # ok",
      'FLAG="a b" # keep the inner space',
      "HASH=abc#def", // no whitespace before # -> # is literal
      "QUOTED='a#b'", // # inside single quotes -> preserved
      'DQ="# inside double quotes"',
      "# a full-line comment",
      "EMPTY=",
    ].join("\n"),
  );
  assert.equal(env.PI_COFFEE_THINKING, "max");
  assert.equal(env.PI_COFFEE_MODEL, "glm-5.3");
  assert.equal(env.PI_COFFEE_WORKER, "deepseek-flash");
  assert.equal(env.FLAG, "a b");
  assert.equal(env.HASH, "abc#def");
  assert.equal(env.QUOTED, "a#b");
  assert.equal(env.DQ, "# inside double quotes");
  assert.equal(env.EMPTY, "");
  assert.equal(Object.keys(env).length, 8);
});