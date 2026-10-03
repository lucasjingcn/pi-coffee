import test from "node:test";
import assert from "node:assert/strict";
import { PiRpcClient } from "../dist/rpc-client.js";

const duck = (streaming, isStreaming, withProc = true) => ({
  proc: withProc ? {} : undefined,
  disposed: false,
  exited: false,
  streaming,
  getState: async () => ({ isStreaming }),
});

test("refreshStreaming reconciles a stale streaming flag against authoritative state", async () => {
  const stale = duck(true, false);
  await PiRpcClient.prototype.refreshStreaming.call(stale);
  assert.equal(stale.streaming, false);

  const busy = duck(false, true);
  await PiRpcClient.prototype.refreshStreaming.call(busy);
  assert.equal(busy.streaming, true);
});

test("refreshStreaming is a no-op when the process is gone", async () => {
  const gone = duck(true, false, false);
  await PiRpcClient.prototype.refreshStreaming.call(gone);
  assert.equal(gone.streaming, true);
});

test("refreshStreaming keeps the flag when the authoritative probe fails", async () => {
  const failing = { proc: {}, disposed: false, exited: false, streaming: true, getState: async () => { throw new Error("offline"); } };
  await PiRpcClient.prototype.refreshStreaming.call(failing);
  assert.equal(failing.streaming, true);
});