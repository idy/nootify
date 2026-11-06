import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { larkPollReceiptKey, type LarkPollReceipt } from './types.js';

// Migration one must retain its original nine tables when later tables are added.
const VERSION_ONE_TABLES = ['sessions', 'lark_bindings', 'backends', 'lark_deliveries', 'lark_poll_cursors', 'chat_bindings', 'chat_deliveries', 'inbox_messages', 'settings'] as const;
export const STATE_TABLES = [...VERSION_ONE_TABLES, 'lark_poll_receipts'] as const;
export type StateTable = typeof STATE_TABLES[number];
/** Separate keyed rows keep nested provider payloads extensible without rewriting unrelated entities. */
export type StateRows = Record<StateTable, Map<string, string>>;
export type StatePatch = Partial<Record<StateTable, ReadonlyMap<string, string | undefined>>>;
export interface LarkPollPrune { readonly cursor_id: string; readonly before: number }
type CachedRow = Readonly<{ value: string; position: number }>;
type CachedRows = Record<StateTable, Map<string, CachedRow>>;
const emptyCache = (): CachedRows => Object.fromEntries(STATE_TABLES.map(table => [table, new Map<string, CachedRow>()])) as CachedRows;
export const emptyStateRows = (): StateRows => Object.fromEntries(STATE_TABLES.map(table => [table, new Map<string, string>()])) as StateRows;

export function validateLarkPollReceipt(value: unknown): asserts value is LarkPollReceipt {
  const receipt = value as LarkPollReceipt | null;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
    typeof receipt.cursor_id !== 'string' || !receipt.cursor_id || typeof receipt.message_id !== 'string' || !receipt.message_id ||
    !Number.isSafeInteger(receipt.create_time)) throw new Error('Invalid service state poll receipt; the original data was not replaced');
}
/** Both old JSON imports and SQLite upgrades must reject malformed completion data. */
export function legacyLarkPollReceipts(cursorId: string, recent: unknown): LarkPollReceipt[] {
  if (recent === undefined) return [];
  if (!Array.isArray(recent)) throw new Error('Invalid service state poll receipts; the original data was not replaced');
  const receipts = new Map<string, LarkPollReceipt>();
  for (const entry of recent) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid service state poll receipt; the original data was not replaced');
    const receipt: LarkPollReceipt = { cursor_id: cursorId, message_id: entry[0], create_time: entry[1] };
    validateLarkPollReceipt(receipt);
    const previous = receipts.get(receipt.message_id);
    if (previous && previous.create_time !== receipt.create_time) throw new Error('Invalid service state conflicting poll receipts; the original data was not replaced');
    receipts.set(receipt.message_id, receipt);
  }
  return [...receipts.values()];
}

function version(db: DatabaseSync): number { return Number(db.prepare('PRAGMA user_version').get()!.user_version); }
function connect(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;'); return db; }
  catch (error) { db.close(); throw error; }
}
function createTable(db: DatabaseSync, table: StateTable): void {
  db.exec(`CREATE TABLE ${table} (
    id TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value)),
    position INTEGER NOT NULL
  ) STRICT`);
  db.exec(`CREATE INDEX ${table}_position ON ${table} (position)`);
}
function createSchema(db: DatabaseSync): void {
  for (const table of VERSION_ONE_TABLES) createTable(db, table);
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
    CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;
    CREATE INDEX lark_bindings_session ON lark_bindings (json_extract(value, '$.session_id'));
    CREATE INDEX lark_deliveries_chat ON lark_deliveries (json_extract(value, '$.chat_id'), json_extract(value, '$.created_at'));
    CREATE INDEX lark_poll_cursors_chat ON lark_poll_cursors (json_extract(value, '$.app_id'), json_extract(value, '$.chat_id'), json_extract(value, '$.container_type'));
    CREATE INDEX chat_bindings_session ON chat_bindings (json_extract(value, '$.adapter'), json_extract(value, '$.session_id'));
    CREATE INDEX inbox_messages_session ON inbox_messages (json_extract(value, '$.adapter'), json_extract(value, '$.session_id'));
  `);
}
function createPollReceipts(db: DatabaseSync): void {
  createTable(db, 'lark_poll_receipts');
  db.exec("CREATE INDEX lark_poll_receipts_cursor_time ON lark_poll_receipts (json_extract(value, '$.cursor_id'), json_extract(value, '$.create_time'))");
  const put = db.prepare('INSERT INTO lark_poll_receipts (id, value, position) VALUES (?, ?, ?)');
  const update = db.prepare('UPDATE lark_poll_cursors SET value = ? WHERE id = ?');
  let position = 0;
  for (const row of db.prepare('SELECT id, value FROM lark_poll_cursors ORDER BY position, id').all()) {
    const cursor = JSON.parse(String(row.value)) as Record<string, unknown> | null;
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error('Invalid service state poll cursor; the original data was not replaced');
    if (!Object.hasOwn(cursor, 'recent')) continue;
    const receipts = legacyLarkPollReceipts(String(row.id), cursor.recent);
    delete cursor.recent;
    update.run(JSON.stringify(cursor), row.id);
    for (const receipt of receipts) put.run(larkPollReceiptKey(receipt.cursor_id, receipt.message_id), JSON.stringify(receipt), position++);
  }
}
/** Ordered, append-only migration steps run in one transaction. */
const migrations = [{ version: 1, apply: createSchema }, { version: 2, apply: createPollReceipts }] as const;
export const STATE_SCHEMA_VERSION = migrations.at(-1)!.version;
function readRows(db: DatabaseSync): CachedRows {
  const rows = emptyCache();
  for (const table of STATE_TABLES) {
    for (const row of db.prepare(`SELECT id, value, position FROM ${table} ORDER BY position, id`).all()) {
      rows[table].set(String(row.id), { value: String(row.value), position: Number(row.position) });
    }
  }
  return rows;
}
function updateRows(db: DatabaseSync, rows: StateRows, previous: CachedRows): CachedRows {
  const result = emptyCache();
  for (const table of STATE_TABLES) {
    let remove: ReturnType<DatabaseSync['prepare']> | undefined;
    for (const id of previous[table].keys()) if (!rows[table].has(id)) {
      remove ??= db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      remove.run(id);
    }
    let put: ReturnType<DatabaseSync['prepare']> | undefined;
    let preceding = -Infinity; let nextPosition: number | undefined;
    for (const [id, value] of rows[table]) {
      const old = previous[table].get(id);
      let position = old?.position;
      if (position === undefined || position <= preceding) {
        // Stable ordinals avoid rewriting a bounded ledger when its oldest record is evicted.
        nextPosition ??= Number(db.prepare(`SELECT coalesce(max(position), -1) AS last FROM ${table}`).get()!.last) + 1;
        position = nextPosition++;
      }
      if (old?.value !== value || old?.position !== position) {
        put ??= db.prepare(`INSERT INTO ${table} (id, value, position) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET value = excluded.value, position = excluded.position`);
        put.run(id, value, position);
      }
      result[table].set(id, { value, position }); preceding = position;
    }
  }
  return result;
}

/** Short-lived connections avoid leaked handles in one-shot installers and callers that reopen state. */
export class StateDatabase {
  private constructor(readonly path: string, private persisted: CachedRows) {}
  static async open(directory: string, legacy: () => Promise<StateRows | undefined>): Promise<StateDatabase> {
    const path = join(directory, 'state.sqlite');
    // Create privately before SQLite opens it; SQLite journals inherit the database's permissions.
    const file = await open(path, 'a', 0o600);
    try { await file.chmod(0o600); } finally { await file.close(); }
    const db = connect(path);
    let transaction = false;
    try {
      let current = version(db);
      if (current > STATE_SCHEMA_VERSION) throw new Error('The state database requires a newer Nootify version');
      if (db.prepare('PRAGMA journal_mode').get()!.journal_mode !== 'wal') db.exec('PRAGMA journal_mode = WAL');
      if (current < STATE_SCHEMA_VERSION) {
        // Read and validate JSON before holding a write transaction across any asynchronous work.
        const imported = current === 0 ? await legacy() : undefined;
        db.exec('BEGIN IMMEDIATE'); transaction = true;
        current = version(db); // Another opener may have completed migration while JSON was read.
        if (current > STATE_SCHEMA_VERSION) throw new Error('The state database requires a newer Nootify version');
        const initializing = current === 0;
        if (initializing && db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
          throw new Error('The state database has an unrecognized schema');
        }
        for (const migration of migrations) {
          if (migration.version <= current) continue;
          migration.apply(db);
          db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
          db.exec(`PRAGMA user_version = ${migration.version}`);
        }
        // Imports can include rows introduced by later migrations, so insert only after all tables exist.
        if (initializing && imported) {
          updateRows(db, imported, emptyCache());
          db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('legacy_state_json_imported_at', new Date().toISOString());
        }
        db.exec('COMMIT'); transaction = false;
      }
      db.exec('BEGIN'); transaction = true;
      const rows = readRows(db);
      db.exec('COMMIT'); transaction = false;
      return new StateDatabase(path, rows);
    } catch (error) {
      if (transaction) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original migration/read failure. */ } }
      throw error;
    } finally { db.close(); }
  }
  load(): StateRows {
    return Object.fromEntries(STATE_TABLES.map(table => [table, new Map([...this.persisted[table]].map(([id, row]) => [id, row.value]))])) as StateRows;
  }
  /** The caller serializes writes with in-memory changes and rollback; SQLite makes all tables atomic. */
  async write(rows: StateRows): Promise<void> {
    const db = connect(this.path);
    let transaction = false;
    try {
      db.exec('BEGIN IMMEDIATE'); transaction = true;
      if (version(db) !== STATE_SCHEMA_VERSION) throw new Error('The state database schema changed; restart Nootify before saving');
      const persisted = updateRows(db, rows, this.persisted);
      db.exec('COMMIT'); transaction = false;
      this.persisted = persisted;
    } catch (error) {
      if (transaction) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original save failure. */ } }
      throw error;
    } finally { db.close(); }
  }
  /** Apply only explicit keys; neither copy nor traverse unrelated cached rows. */
  async patch(rows: StatePatch, prune: readonly LarkPollPrune[] = []): Promise<void> {
    const changed: StatePatch = {};
    for (const table of STATE_TABLES) {
      const entries = rows[table];
      if (!entries) continue;
      const changes = new Map<string, string | undefined>();
      for (const [id, value] of entries) if (this.persisted[table].get(id)?.value !== value) changes.set(id, value);
      if (changes.size) changed[table] = changes;
    }
    const tables = STATE_TABLES.filter(table => changed[table]);
    if (!tables.length && !prune.length) return;
    const db = connect(this.path);
    let transaction = false;
    try {
      db.exec('BEGIN IMMEDIATE'); transaction = true;
      if (version(db) !== STATE_SCHEMA_VERSION) throw new Error('The state database schema changed; restart Nootify before saving');
      const pending = new Map<StateTable, Map<string, CachedRow | undefined>>();
      for (const table of tables) {
        const updates = new Map<string, CachedRow | undefined>(); pending.set(table, updates);
        let nextPosition: number | undefined;
        let put: ReturnType<DatabaseSync['prepare']> | undefined; let remove: ReturnType<DatabaseSync['prepare']> | undefined;
        for (const [id, value] of changed[table]!) {
          if (value === undefined) {
            remove ??= db.prepare(`DELETE FROM ${table} WHERE id = ?`);
            remove.run(id); updates.set(id, undefined); continue;
          }
          let position = this.persisted[table].get(id)?.position;
          if (position === undefined) {
            nextPosition ??= Number(db.prepare(`SELECT coalesce(max(position), -1) AS last FROM ${table}`).get()!.last) + 1;
            position = nextPosition++;
          }
          put ??= db.prepare(`INSERT INTO ${table} (id, value, position) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET value = excluded.value, position = excluded.position`);
          put.run(id, value, position); updates.set(id, { value, position });
        }
      }
      if (prune.length) {
        const remove = db.prepare("DELETE FROM lark_poll_receipts WHERE json_extract(value, '$.cursor_id') = ? AND json_extract(value, '$.create_time') < ? RETURNING id");
        const updates = pending.get('lark_poll_receipts') ?? new Map<string, CachedRow | undefined>();
        for (const { cursor_id, before } of prune) for (const row of remove.all(cursor_id, before)) updates.set(String(row.id), undefined);
        if (updates.size) pending.set('lark_poll_receipts', updates);
      }
      // A prune with no matching rows should not add an otherwise empty durable checkpoint.
      db.exec(pending.size ? 'COMMIT' : 'ROLLBACK'); transaction = false;
      for (const [table, updates] of pending) for (const [id, row] of updates) {
        if (row) this.persisted[table].set(id, row); else this.persisted[table].delete(id);
      }
    } catch (error) {
      if (transaction) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original patch failure. */ } }
      throw error;
    } finally { db.close(); }
  }
}
