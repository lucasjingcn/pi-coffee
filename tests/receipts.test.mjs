import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Coordinator } from "../dist/manager.js";
import { loadConfig } from "../dist/config.js";
import { buildServer } from "../dist/mcp-server.js";
import { boardSha256, mailboxSha256 } from "../dist/mailbox.js";

const HEX64 = /^[a-f0-9]{64}$/;

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-receipts-"));
  const coord = new Coordinator(loadConfig({ dataDir: dir, workspaceRoot: join(dir, "w"), autoClean: false }));
  await coord.init();
  try {
    await fn({ coord, dir });
  } finally {
    await coord.stopAll();
    await rm(dir, { recursive: true, force: true });
  }
}

async function persisted(dir) {
  return JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
}

test("mailbox message is hash-stamped, persisted and read back", async () => {
  await fixture(async ({ coord, dir }) => {
    const posted = coord.postMessage("codex", "*", "hello workers", "note", false);
    assert.match(posted.sha256, HEX64);
    const receipt = await coord.messageReceipt(posted.id);
    assert.equal(receipt.readBack, true);
    assert.equal(receipt.sha256, posted.sha256);
    const state = await persisted(dir);
    const entry = state.mailbox.find((message) => message.id === posted.id);
    assert.equal(entry.sha256, posted.sha256);
    assert.equal(mailboxSha256(entry), posted.sha256);
  });
});

test("board entry is hash-stamped, persisted and read back", async () => {
  await fixture(async ({ coord, dir }) => {
    const entry = coord.boardPost("shared", "api", "v1", "codex");
    assert.match(entry.sha256, HEX64);
    const receipt = await coord.boardReceipt("shared", "api");
    assert.equal(receipt.readBack, true);
    assert.equal(receipt.sha256, entry.sha256);
    const state = await persisted(dir);
    const stored = state.board.find((candidate) => candidate.board === "shared" && candidate.key === "api");
    assert.equal(stored.sha256, entry.sha256);
    assert.equal(boardSha256(stored), entry.sha256);
  });
});

test("a tampered persisted message fails read-back verification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-receipts-tamper-"));
  try {
    const first = new Coordinator(loadConfig({ dataDir: dir, workspaceRoot: join(dir, "w"), autoClean: false }));
    await first.init();
    const posted = first.postMessage("codex", "*", "original text", "note", false);
    await first.messageReceipt(posted.id); // persists
    await first.stopAll();

    const file = join(dir, "state.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    const entry = state.mailbox.find((message) => message.id === posted.id);
    entry.text = "tampered after the fact";
    await writeFile(file, JSON.stringify(state, null, 2));

    const second = new Coordinator(loadConfig({ dataDir: dir, workspaceRoot: join(dir, "w"), autoClean: false }));
    await second.init();
    try {
      await assert.rejects(second.messageReceipt(posted.id), /not read back: persisted message hash mismatch/);
    } finally {
      await second.stopAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tampered persisted board entry fails read-back verification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-receipts-board-tamper-"));
  try {
    const first = new Coordinator(loadConfig({ dataDir: dir, workspaceRoot: join(dir, "w"), autoClean: false }));
    await first.init();
    first.boardPost("shared", "api", "v1", "codex");
    await first.boardReceipt("shared", "api");
    await first.stopAll();

    const file = join(dir, "state.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.board[0].value = "v2-rewritten";
    await writeFile(file, JSON.stringify(state, null, 2));

    const second = new Coordinator(loadConfig({ dataDir: dir, workspaceRoot: join(dir, "w"), autoClean: false }));
    await second.init();
    try {
      await assert.rejects(second.boardReceipt("shared", "api"), /not read back: persisted board entry hash mismatch/);
    } finally {
      await second.stopAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy persisted entries without a stored hash still verify", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-receipts-legacy-"));
  try {
    const legacy = {
      counter: 0,
      mailbox: [{ id: "m-legacy", from: "a", to: "b", kind: "note", text: "old message", ts: 1, read: false }],
      board: [{ board: "shared", key: "api", value: "v0", from: "a", ts: 2 }],
      history: [],
      orchestratorCosts: [],
    };
    await writeFile(join(dir, "state.json"), JSON.stringify(legacy, null, 2));
    const coord = new Coordinator(loadConfig({ dataDir: dir, workspaceRoot: join(dir, "w"), autoClean: false }));
    await coord.init();
    try {
      const message = await coord.messageReceipt("m-legacy");
      assert.equal(message.readBack, true);
      assert.match(message.sha256, HEX64);
      const board = await coord.boardReceipt("shared", "api");
      assert.equal(board.readBack, true);
      assert.match(board.sha256, HEX64);
    } finally {
      await coord.stopAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing coordination entries are rejected, never reported as delivered", async () => {
  await fixture(async ({ coord }) => {
    await assert.rejects(coord.messageReceipt("no-such-message"), /not read back/);
    await assert.rejects(coord.boardReceipt("no-such-board", "no-such-key"), /not read back/);
  });
});

test("MCP pi_message and pi_board_post return read-back receipts", async () => {
  await fixture(async ({ coord, dir }) => {
    const server = buildServer(coord);
    const client = new Client({ name: "receipts-test", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const sent = JSON.parse((await client.callTool({
        name: "pi_message",
        arguments: { session_id: "*", message: "hello", kind: "note", deliver: false },
      })).content[0].text);
      assert.equal(sent.readBack, true);
      assert.match(sent.sha256, HEX64);

      const posted = JSON.parse((await client.callTool({
        name: "pi_board_post",
        arguments: { board: "integration", key: "contract", value: "v1" },
      })).content[0].text);
      assert.equal(posted.readBack, true);
      assert.match(posted.sha256, HEX64);

      const state = await persisted(dir);
      assert.equal(mailboxSha256(state.mailbox.find((message) => message.id === sent.id)), sent.sha256);
      assert.equal(
        boardSha256(state.board.find((entry) => entry.board === "integration" && entry.key === "contract")),
        posted.sha256,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
