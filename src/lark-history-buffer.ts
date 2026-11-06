import { randomUUID } from 'node:crypto';
import { unlinkSync, type Dirent } from 'node:fs';
import { open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface LarkHistoryMessage {
  message_id: string; chat_id: string; create_time: string; msg_type?: string; deleted?: boolean; thread_id?: string; root_id?: string;
  sender?: { sender_type?: string; id_type?: string; id?: string };
  body?: { content?: string };
}
export interface LarkHistoryEntry { cursor_id: string; item: LarkHistoryMessage; dispatch: boolean }
export interface BufferedLarkHistory { item: LarkHistoryMessage; cursor_ids: string[]; dispatch: boolean; time: number; sequence: number }
const filename = /^\.poll-history-([1-9]\d*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sqlite$/;

/** Reconstructible scratch space for merging provider pages; durable receipts remain in State. */
export class LarkHistoryBuffer {
  private constructor(private readonly path: string, private database: DatabaseSync | undefined) {}
  static async open(directory: string): Promise<LarkHistoryBuffer> {
    const path = join(directory, `.poll-history-${process.pid}-${randomUUID()}.sqlite`);
    let database: DatabaseSync | undefined; let created = false;
    try {
      // Create privately before SQLite opens the file. No journal or payload escapes this file.
      const file = await open(path, 'wx', 0o600); created = true;
      try { await file.chmod(0o600); } finally { await file.close(); }
      database = new DatabaseSync(path);
      database.exec(`PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF; PRAGMA foreign_keys = ON;
        CREATE TABLE messages (
          sequence INTEGER PRIMARY KEY,
          message_id TEXT NOT NULL UNIQUE,
          time INTEGER NOT NULL,
          item TEXT NOT NULL CHECK (json_valid(item)),
          dispatch INTEGER NOT NULL CHECK (dispatch IN (0, 1))
        ) STRICT;
        CREATE INDEX messages_time_sequence ON messages (time, sequence);
        CREATE TABLE sources (
          sequence INTEGER PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(message_id),
          cursor_id TEXT NOT NULL,
          UNIQUE (message_id, cursor_id)
        ) STRICT;
        CREATE INDEX sources_message_sequence ON sources (message_id, sequence);`);
      return new LarkHistoryBuffer(path, database);
    } catch (error) {
      try { database?.close(); } catch { /* Preserve the initialization error. */ }
      if (created) { try { await unlink(path); } catch { /* Preserve the initialization error. */ } }
      throw error;
    }
  }
  /** A PID is sufficient only when the OS positively reports that it no longer exists. */
  static async cleanupOrphans(directory: string): Promise<void> {
    let files: Dirent[];
    try { files = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const file of files) {
      if (!file.isFile()) continue;
      const match = filename.exec(file.name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
        try { await unlink(join(directory, file.name)); }
        catch (removeError) { if ((removeError as NodeJS.ErrnoException).code !== 'ENOENT') throw removeError; }
      }
    }
  }
  /** One provider page, including all of its source associations, commits together. */
  append(entries: readonly LarkHistoryEntry[]): void {
    try {
      const database = this.connection();
      if (!entries.length) return;
      database.exec('BEGIN');
      const put = database.prepare(`INSERT INTO messages (message_id, time, item, dispatch) VALUES (?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          time = CASE WHEN excluded.dispatch = 1 AND messages.dispatch = 0 THEN excluded.time ELSE messages.time END,
          item = CASE WHEN excluded.dispatch = 1 AND messages.dispatch = 0 THEN excluded.item ELSE messages.item END,
          dispatch = max(messages.dispatch, excluded.dispatch)`);
      const source = database.prepare('INSERT INTO sources (message_id, cursor_id) VALUES (?, ?) ON CONFLICT(message_id, cursor_id) DO NOTHING');
      for (const { cursor_id, item, dispatch } of entries) {
        const time = Number(item.create_time);
        if (!Number.isSafeInteger(time) || !item.create_time.trim() || !item.message_id || !cursor_id) throw new Error('Invalid buffered history entry');
        put.run(item.message_id, time, JSON.stringify(item), dispatch ? 1 : 0);
        source.run(item.message_id, cursor_id);
      }
      database.exec('COMMIT');
    } catch (error) {
      try { this.database?.exec('ROLLBACK'); } catch { /* The failing operation may not have started a transaction. */ }
      this.discardAfterError(); throw error;
    }
  }
  /** Indexed keyset reads keep both JSON decoding and result arrays bounded by the requested page. */
  read(after?: { time: number; sequence: number }, limit = 50): BufferedLarkHistory[] {
    try {
      const database = this.connection();
      if (!Number.isSafeInteger(limit) || limit < 1 || (after && (!Number.isSafeInteger(after.time) || !Number.isSafeInteger(after.sequence)))) {
        throw new Error('Invalid buffered history page');
      }
      const rows = after
        ? database.prepare('SELECT message_id, time, sequence, item, dispatch FROM messages WHERE (time, sequence) > (?, ?) ORDER BY time, sequence LIMIT ?').all(after.time, after.sequence, limit)
        : database.prepare('SELECT message_id, time, sequence, item, dispatch FROM messages ORDER BY time, sequence LIMIT ?').all(limit);
      const sources = database.prepare('SELECT cursor_id FROM sources WHERE message_id = ? ORDER BY sequence');
      return rows.map(row => ({ item: JSON.parse(String(row.item)) as LarkHistoryMessage,
        cursor_ids: sources.all(row.message_id).map(source => String(source.cursor_id)),
        dispatch: row.dispatch === 1, time: Number(row.time), sequence: Number(row.sequence) }));
    } catch (error) { this.discardAfterError(); throw error; }
  }
  private connection(): DatabaseSync {
    if (!this.database) throw new Error('History buffer is closed');
    return this.database;
  }
  private discardAfterError(): void {
    try { this.dispose(); } catch { /* Preserve the page/read failure while still attempting deletion. */ }
  }
  private dispose(): void {
    const database = this.database; this.database = undefined;
    let failure: unknown;
    try { database?.close(); } catch (error) { failure = error; }
    try { unlinkSync(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure ??= error; }
    if (failure) throw failure;
  }
  async close(): Promise<void> { this.dispose(); }
}
