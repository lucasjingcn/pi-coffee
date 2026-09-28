import { randomUUID } from "node:crypto";

export type MessageKind = "note" | "question" | "answer" | "broadcast";

export interface MailMessage {
  id: string;
  from: string;
  to: string; // session id, or "*" for broadcast
  kind: MessageKind;
  text: string;
  ts: number;
  read: boolean;
}

export class Mailbox {
  private messages: MailMessage[] = [];

  post(from: string, to: string, text: string, kind: MessageKind = "note"): MailMessage {
    const m: MailMessage = { id: randomUUID(), from, to, kind, text, ts: Date.now(), read: false };
    this.messages.push(m);
    if (this.messages.length > 5000) this.messages = this.messages.slice(-3000);
    return m;
  }

  inbox(sessionId: string, opts: { unreadOnly?: boolean; since?: number } = {}): MailMessage[] {
    return this.messages.filter(
      (m) =>
        (m.to === sessionId || m.to === "*") &&
        (!opts.unreadOnly || !m.read) &&
        (opts.since === undefined || m.ts > opts.since),
    );
  }

  markRead(ids: string[]): void {
    const set = new Set(ids);
    for (const m of this.messages) if (set.has(m.id)) m.read = true;
  }

  markAllRead(sessionId: string): void {
    for (const m of this.messages) if (m.to === sessionId || m.to === "*") m.read = true;
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
