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
   * acknowledged the message. For broadcasts it is set by legacy no-session
   * acks so older callers keep working. Prefer {@link readBy} for broadcasts.
   */
  read: boolean;
  /** Session ids that have acknowledged this message (used for broadcasts). */
  readBy?: string[];
}

export class Mailbox {
  private messages: MailMessage[] = [];

  post(from: string, to: string, text: string, kind: MessageKind = "note"): MailMessage {
    const m: MailMessage = { id: randomUUID(), from, to, kind, text, ts: Date.now(), read: false };
    this.messages.push(m);
    if (this.messages.length > 5000) this.messages = this.messages.slice(-3000);
    return m;
  }

  /** Whether `sessionId` has acknowledged this message. */
  private isReadBy(m: MailMessage, sessionId: string): boolean {
    if (m.read) return true; // legacy global ack / direct recipient ack
    return Boolean(m.readBy && m.readBy.includes(sessionId));
  }

  inbox(sessionId: string, opts: { unreadOnly?: boolean; since?: number } = {}): MailMessage[] {
    const out: MailMessage[] = [];
    for (const m of this.messages) {
      if (m.to !== sessionId && m.to !== "*") continue;
      if (opts.since !== undefined && m.ts <= opts.since) continue;
      const read = this.isReadBy(m, sessionId);
      if (opts.unreadOnly && read) continue;
      // Return a per-recipient view so callers never observe another
      // recipient's read state on a shared broadcast object.
      out.push({ ...m, read, readBy: m.readBy ? [...m.readBy] : undefined });
    }
    return out;
  }

  /**
   * Acknowledge messages. When `sessionId` is supplied only that recipient's
   * state changes: direct messages are only acked by their recipient and
   * broadcasts record the session in `readBy` so other recipients still see
   * them. Without `sessionId` the legacy global ack is preserved.
   */
  markRead(ids: string[], sessionId?: string): void {
    const set = new Set(ids);
    for (const m of this.messages) {
      if (!set.has(m.id)) continue;
      if (sessionId === undefined) {
        m.read = true; // legacy global ack
        continue;
      }
      if (m.to === "*") {
        const readBy = (m.readBy ??= []);
        if (!readBy.includes(sessionId)) readBy.push(sessionId);
      } else if (m.to === sessionId) {
        m.read = true;
      }
      // Direct message for another recipient: ignore this ack.
    }
  }

  markAllRead(sessionId: string): void {
    for (const m of this.messages) {
      if (m.to === sessionId) {
        m.read = true;
      } else if (m.to === "*") {
        const readBy = (m.readBy ??= []);
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

export class Board {
  private entries: BoardEntry[] = [];

  post(board: string, key: string, value: string, from: string): BoardEntry {
    const e: BoardEntry = { board, key, value, from, ts: Date.now() };
    this.entries.push(e);
    if (this.entries.length > 5000) this.entries = this.entries.slice(-3000);
    return e;
  }

  read(board?: string, key?: string): BoardEntry[] {
    return this.entries.filter((e) => (!board || e.board === board) && (!key || e.key === key));
  }

  /** Latest entry per key for a board. */
  latest(board: string): BoardEntry[] {
    const map = new Map<string, BoardEntry>();
    for (const e of this.entries) if (e.board === board) map.set(e.key, e);
    return [...map.values()];
  }

  export(): BoardEntry[] {
    return this.entries;
  }

  import(entries: BoardEntry[]): void {
    this.entries = entries;
  }
}
