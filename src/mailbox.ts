import { randomUUID } from "node:crypto";

export type MessageKind = "note" | "question" | "answer" | "broadcast";

export interface MailMessage {
  id: string;
  from: string;
  to: string; // session id, or "*" for broadcast
  kind: MessageKind;
  text: string;
  ts: number;
  /**
   * Legacy/global read flag. For direct messages it records that the recipient
   * acknowledged the message. For broadcasts it is set by legacy no-session acks
   * so older callers keep working. Prefer {@link readBy} for broadcasts.
   */
  read: boolean;
  /** Session ids that have acknowledged this message (used for broadcasts). */
  readBy?: string[];
}

/** How many messages we keep before trimming the oldest ones. */
const MAX_MESSAGES = 5000;
const TRIM_TO = 3000;

export class Mailbox {
  private messages: MailMessage[] = [];

  post(from: string, to: string, text: string, kind: MessageKind = "note"): MailMessage {
    const message: MailMessage = { id: randomUUID(), from, to, kind, text, ts: Date.now(), read: false };
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) this.messages = this.messages.slice(-TRIM_TO);
    return message;
  }

  /** Whether `sessionId` has acknowledged this message. */
  private isReadBy(message: MailMessage, sessionId: string): boolean {
    if (message.read) return true; // legacy global ack / direct recipient ack
    return Boolean(message.readBy && message.readBy.includes(sessionId));
  }

  inbox(sessionId: string, opts: { unreadOnly?: boolean; since?: number } = {}): MailMessage[] {
    const out: MailMessage[] = [];
    for (const message of this.messages) {
      if (message.to !== sessionId && message.to !== "*") continue;
      if (opts.since !== undefined && message.ts <= opts.since) continue;

      const read = this.isReadBy(message, sessionId);
      if (opts.unreadOnly && read) continue;

      // Return a per-recipient copy so callers never see another recipient's
      // read state on a shared broadcast object.
      out.push({ ...message, read, readBy: message.readBy ? [...message.readBy] : undefined });
    }
    return out;
  }

  /**
   * Acknowledge messages. With `sessionId`, only that recipient's state changes:
   * direct messages are acked only by their recipient, and broadcasts record the
   * session in `readBy` so other recipients still see them. Without `sessionId`,
   * the legacy global ack is preserved.
   */
  markRead(ids: string[], sessionId?: string): void {
    const wanted = new Set(ids);
    for (const message of this.messages) {
      if (!wanted.has(message.id)) continue;

      if (sessionId === undefined) {
        message.read = true; // legacy global ack
        continue;
      }
      if (message.to === "*") {
        const readBy = (message.readBy ??= []);
        if (!readBy.includes(sessionId)) readBy.push(sessionId);
      } else if (message.to === sessionId) {
        message.read = true;
      }
      // Direct message for another recipient: ignore this ack.
    }
  }

  markAllRead(sessionId: string): void {
    for (const message of this.messages) {
      if (message.to === sessionId) {
        message.read = true;
      } else if (message.to === "*") {
        const readBy = (message.readBy ??= []);
        if (!readBy.includes(sessionId)) readBy.push(sessionId);
      }
    }
  }

  export(): MailMessage[] {
    return this.messages;
  }

  import(messages: MailMessage[]): void {
    this.messages = messages;
  }
}

export interface BoardEntry {
  board: string;
  key: string;
  value: string;
  from: string;
  ts: number;
}

/** Append-only shared blackboard: latest-write-wins per (board, key). */
export class Board {
  private entries: BoardEntry[] = [];

  post(board: string, key: string, value: string, from: string): BoardEntry {
    const entry: BoardEntry = { board, key, value, from, ts: Date.now() };
    this.entries.push(entry);
    if (this.entries.length > MAX_MESSAGES) this.entries = this.entries.slice(-TRIM_TO);
    return entry;
  }

  read(board?: string, key?: string): BoardEntry[] {
    return this.entries.filter((e) => (!board || e.board === board) && (!key || e.key === key));
  }

  /** Latest entry per key for a board. */
  latest(board: string): BoardEntry[] {
    const latestByKey = new Map<string, BoardEntry>();
    for (const entry of this.entries) {
      if (entry.board === board) latestByKey.set(entry.key, entry);
    }
    return [...latestByKey.values()];
  }

  export(): BoardEntry[] {
    return this.entries;
  }

  import(entries: BoardEntry[]): void {
    this.entries = entries;
  }
}
