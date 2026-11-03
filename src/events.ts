import { randomUUID } from 'node:crypto';
import { open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface LogEntry {
  id: string;
  time: string;
  status: string;
  source?: string;
  session_id?: string;
  session_name?: string;
  chat_id?: string;
  message_id?: string;
  reply_id?: string;
  sender_open_id?: string;
  reason?: string;
  error?: string;
  preview?: string;
}
const fields = ['status', 'source', 'session_id', 'session_name', 'chat_id', 'message_id', 'reply_id', 'sender_open_id', 'reason', 'error', 'preview'] as const;
const limit = 1000;
export class EventLog {
  private entries: LogEntry[] = [];
  private writes = Promise.resolve();
  private constructor(private readonly directory: string) {}
  static async open(directory: string): Promise<EventLog> {
    const log = new EventLog(directory);
    for (const name of ['events.ndjson', 'stdout.log']) {
      let file;
      try {
        file = await open(join(directory, name), 'r');
        const size = (await file.stat()).size;
        const start = Math.max(0, size - 1024 * 1024);
        const buffer = Buffer.alloc(size - start);
        await file.read(buffer, 0, buffer.length, start);
        const lines = buffer.toString('utf8').split('\n');
        if (start) lines.shift();
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (typeof entry.status === 'string') log.entries.push(log.sanitize(entry));
          } catch { /* Old stdout can contain non-JSON SDK notices. */ }
        }
        log.entries = log.entries.slice(-limit);
        break;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      finally { await file?.close(); }
    }
    return log;
  }
  private sanitize(record: Record<string, unknown>): LogEntry {
    const result: LogEntry = {
      id: typeof record.id === 'string' ? record.id.slice(0, 100) : randomUUID(),
      time: typeof record.time === 'string' && Number.isFinite(Date.parse(record.time)) ? record.time : new Date().toISOString(),
      status: 'event',
    };
    for (const field of fields) {
      if (typeof record[field] === 'string') result[field] = record[field].slice(0, field === 'preview' ? 240 : 700)
        .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
    }
    return result;
  }
  report(record: Record<string, unknown>): LogEntry {
    const entry = this.sanitize(record);
    this.entries.push(entry);
    if (this.entries.length > limit) this.entries.shift();
    const snapshot = this.entries.map(item => JSON.stringify(item)).join('\n') + '\n';
    this.writes = this.writes.then(async () => {
      const temporary = join(this.directory, 'events.ndjson.tmp');
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, join(this.directory, 'events.ndjson'));
    }).catch(() => { console.error('nootify: unable to persist event log'); });
    console.log(JSON.stringify(entry));
    return entry;
  }
  recent(): LogEntry[] { return this.entries.slice().reverse(); }
  flush(): Promise<void> { return this.writes; }
}
