import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { State } from '../src/state.js';
import { STATE_SCHEMA_VERSION, STATE_TABLES, StateDatabase, emptyStateRows, type StatePatch, type StateRows } from '../src/state-database.js';
import { larkPollCursorKey, larkPollReceiptKey, type LarkDelivery, type LarkPollCursor, type LarkPollReceipt, type SessionRecord } from '../src/types.js';
import type { ChatDelivery } from '../src/chat-transport.js';

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'nootify-state-db-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function inspect<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(path, 'state.sqlite'), { readOnly: true });
  try { return read(db); } finally { db.close(); }
}
function execute(path: string, sql: string): void {
  const db = new DatabaseSync(join(path, 'state.sqlite'));
  try { db.exec(sql); } finally { db.close(); }
}
const session = (session_id: string, session_name = session_id): SessionRecord => ({ session_id, session_name, host_id: 'previous-host', adapter: 'trae' });
function legacyState() {
  const delivery: LarkDelivery = { message_id: 'om_original', chat_id: 'oc_legacy', sender_open_id: 'ou_owner', thread_id: 'omt_legacy',
    session_id: 'legacy-session', session_name: 'Old task', adapter: 'trae', created_at: '2026-11-06T00:00:00.000Z',
    transport_status: 'inbox_queued', acknowledged_at: '2026-11-06T00:01:00.000Z',
    replies: [{ digest: 'reply-digest', message_id: 'om_reply', time: '2026-11-06T00:02:00.000Z' }] };
  const chat: ChatDelivery = { id: 'slack-delivery', channel: 'slack', identity: 'slack:bot:C123', adapter: 'workbuddy', session_id: 'chat-session',
    session_name: 'Chat task', chat_id: 'C123', thread_id: '123.4', sender_id: 'U123', message_id: '123.5', created_at: delivery.created_at,
    transport_status: 'inbox_queued', replies: [{ digest: 'chat-reply-digest', message_id: '123.6', time: delivery.created_at }] };
  const cursor: LarkPollCursor = { app_id: 'cli_legacy', chat_id: 'oc_legacy', container_id: 'omt_legacy', container_type: 'thread',
    root_message_id: 'om_root', started_at: 1_700_000_000_000, through: 1_700_000_100_000, recent: [['om_original', 1_700_000_099_000]] };
  return { version: 1, sessions: [{ ...session('legacy-session', 'Old task'), socket_path: '/private/old.sock', socket_token: 'fixture-inbox-token' }],
    lark_bindings: [{ chat_id: 'oc_legacy', session_id: 'legacy-session', sender_open_id: 'ou_owner', registration_message_id: 'om_binding', adapter: 'trae' }],
    backends: [['opencode', { url: 'http://127.0.0.1:4096', username: 'fixture', password: 'fixture-backend-secret' }]],
    lark_deliveries: [delivery], lark_poll_cursors: [cursor],
    chat_bindings: [{ ...chat, id: 'slack-binding' }], chat_deliveries: [chat],
    inbox_messages: [
      { id: 'inbox-feishu', text: 'Unconsumed Feishu reply', created_at: delivery.created_at, session_id: delivery.session_id, adapter: 'trae', source: { channel: 'feishu', delivery } },
      { id: 'inbox-slack', text: 'Unconsumed Slack reply', created_at: delivery.created_at, session_id: chat.session_id, adapter: 'workbuddy', source: { channel: 'slack', delivery: chat } },
      { id: 'inbox-retained', text: 'Context outlived its ledger entry', created_at: delivery.created_at, session_id: delivery.session_id, adapter: 'trae',
        source: { channel: 'feishu', delivery: { ...delivery, message_id: 'om_retained' } } },
    ],
    settings: { lark_app_id: 'cli_legacy', lark_app_secret: 'fixture-feishu-secret', lark_recipient_open_id: 'ou_owner', github_token: 'fixture-github-token',
      notification_channel: 'slack', tailscale_enabled: true,
      slack: { bot_token: 'xoxb-fixture', app_token: 'xapp-fixture', channel_id: 'C123', user_id: 'U123' },
      telegram: { bot_token: '123:fixture', chat_id: '-100123', user_id: '42' } },
  };
}
async function writeLegacy(path: string, data: unknown = legacyState()): Promise<string> {
  const content = JSON.stringify(data, null, 2) + '\n';
  await writeFile(join(path, 'state.json'), content, { mode: 0o600 });
  return content;
}
const cursor = (containerId: string, through = 1_000): LarkPollCursor => ({
  app_id: 'cli_test', chat_id: 'oc_test', container_id: containerId, container_type: 'thread', started_at: 1_000, through,
});
const receipt = (value: LarkPollCursor, messageId: string, createTime: number): LarkPollReceipt => ({
  cursor_id: larkPollCursorKey(value), message_id: messageId, create_time: createTime,
});
/** A real v1 fixture, independent of the current migration implementation. */
function writeVersionOne(path: string, rows: StateRows): void {
  const db = new DatabaseSync(join(path, 'state.sqlite'));
  try {
    db.exec('BEGIN');
    for (const table of ['sessions', 'lark_bindings', 'backends', 'lark_deliveries', 'lark_poll_cursors', 'chat_bindings', 'chat_deliveries', 'inbox_messages', 'settings']) {
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL CHECK (json_valid(value)), position INTEGER NOT NULL) STRICT;
        CREATE INDEX ${table}_position ON ${table} (position)`);
      const put = db.prepare(`INSERT INTO ${table} (id, value, position) VALUES (?, ?, ?)`);
      let position = 0;
      for (const [id, value] of rows[table as keyof StateRows]) put.run(id, value, position++ * 3);
    }
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
      CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations VALUES (1, 'original-v1-migration');
      INSERT INTO metadata VALUES ('legacy_state_json_imported_at', 'original-json-import');
      PRAGMA user_version = 1;
      COMMIT`);
  } finally { db.close(); }
}

test('a fresh install creates private, versioned SQLite tables and keeps the existing auth-token protocol', async t => {
  const path = await directory(t);
  const state = await State.open(path);
  const bytes = await readFile(join(path, 'state.sqlite'));
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.equal((await stat(join(path, 'state.sqlite'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(path, 'auth-token'))).mode & 0o777, 0o600);
  assert.equal((await State.open(path)).token, state.token);
  assert.ok(!(await readdir(path)).includes('state.json'));
  inspect(path, db => {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, STATE_SCHEMA_VERSION);
    assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name));
    assert.ok(STATE_TABLES.every(table => tables.has(table)));
    assert.equal(db.prepare('SELECT count(*) AS count FROM schema_migrations').get()!.count, STATE_SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT count(*) AS count FROM metadata').get()!.count, 0);
  });
});

test('legacy JSON migrates every collection, credentials, cursors, receipts and pending inbox context together', async t => {
  const path = await directory(t); const legacy = legacyState();
  const original = await writeLegacy(path, legacy);
  const token = 'a'.repeat(64); await writeFile(join(path, 'auth-token'), token + '\n', { mode: 0o600 });
  const state = await State.open(path);
  assert.equal(state.token, token);
  assert.deepEqual([...state.sessions.values()], legacy.sessions);
  assert.deepEqual([...state.bindings.values()], legacy.lark_bindings);
  assert.deepEqual([...state.backends], legacy.backends);
  assert.deepEqual([...state.deliveries.values()], legacy.lark_deliveries);
  assert.deepEqual([...state.larkPollCursors.values()], legacy.lark_poll_cursors.map(({ recent, ...cursor }) => cursor));
  const cursorId = larkPollCursorKey(legacy.lark_poll_cursors[0]);
  assert.deepEqual([...state.larkPollReceipts(cursorId)], legacy.lark_poll_cursors[0].recent);
  assert.equal(state.hasLarkPollReceipt(cursorId, 'om_original'), true);
  inspect(path, db => {
    assert.equal(db.prepare('SELECT count(*) AS count FROM lark_poll_receipts').get()!.count, 1);
    assert.equal(JSON.parse(String(db.prepare('SELECT value FROM lark_poll_cursors').get()!.value)).recent, undefined);
  });
  assert.deepEqual([...state.chatBindings.values()], legacy.chat_bindings);
  assert.deepEqual([...state.chatDeliveries.values()], legacy.chat_deliveries);
  assert.deepEqual([...state.inboxMessages.values()], legacy.inbox_messages);
  assert.deepEqual(state.settings, legacy.settings);
  assert.equal(state.inboxMessages.get('inbox-feishu')!.source!.delivery, state.larkDelivery('om_original'));
  assert.equal(state.inboxMessages.get('inbox-slack')!.source!.delivery, state.chatDelivery('slack-delivery'));
  assert.equal(state.larkDelivery('om_retained')?.replies[0].message_id, 'om_reply');
  assert.equal(await readFile(join(path, 'state.json'), 'utf8'), original, 'the pre-migration file is retained byte for byte');
  assert.equal(await readFile(join(path, 'auth-token'), 'utf8'), token + '\n');
  assert.ok(inspect(path, db => db.prepare("SELECT value FROM metadata WHERE key = 'legacy_state_json_imported_at'").get()?.value));
  const reopened = await State.open(path);
  assert.deepEqual(reopened.settings, legacy.settings);
  assert.equal(reopened.inboxMessages.get('inbox-feishu')!.source!.delivery, reopened.larkDelivery('om_original'));
});

test('SQLite remains authoritative after migration; stale or broken JSON never restores deleted settings or inbox items', async t => {
  const path = await directory(t); await writeLegacy(path);
  const state = await State.open(path);
  const importedAt = inspect(path, db => db.prepare("SELECT value FROM metadata WHERE key = 'legacy_state_json_imported_at'").get()!.value);
  delete state.settings.github_token; state.inboxMessages.delete('inbox-feishu'); state.bindings.delete('oc_legacy');
  state.sessions.get('legacy-session')!.session_name = 'Updated in SQLite'; await state.save();
  await writeFile(join(path, 'state.json'), '{broken legacy JSON');
  const reopened = await State.open(path);
  assert.equal(reopened.settings.github_token, undefined);
  assert.equal(reopened.inboxMessages.has('inbox-feishu'), false);
  assert.equal(reopened.bindings.has('oc_legacy'), false);
  assert.equal(reopened.session('legacy-session').session_name, 'Updated in SQLite');
  assert.equal(inspect(path, db => db.prepare("SELECT value FROM metadata WHERE key = 'legacy_state_json_imported_at'").get()!.value), importedAt);
});

test('the earliest version-one JSON with only sessions and bindings is supported', async t => {
  const path = await directory(t);
  await writeLegacy(path, { version: 1, sessions: [session('early')], lark_bindings: [] });
  const state = await State.open(path);
  assert.equal(state.session('early').session_name, 'early');
  assert.equal(state.deliveries.size, 0); assert.equal(state.larkPollCursors.size, 0); assert.deepEqual(state.settings, {});
});

for (const [name, content] of [
  ['truncated JSON', '{"version":1,"secret":"fixture-secret'],
  ['unsupported JSON version', JSON.stringify({ version: 2, sessions: [], lark_bindings: [] })],
  ['malformed collection', JSON.stringify({ version: 1, sessions: [], lark_bindings: [], inbox_messages: {} })],
  ['missing record identity', JSON.stringify({ version: 1, sessions: [{}], lark_bindings: [] })],
] as const) {
  test(`${name} is preserved and cannot leave a partially migrated database`, async t => {
    const path = await directory(t); await writeFile(join(path, 'state.json'), content);
    await assert.rejects(State.open(path), /Invalid (legacy state JSON|service state)/);
    assert.equal(await readFile(join(path, 'state.json'), 'utf8'), content);
    inspect(path, db => {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 0);
      assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table'").get()!.count, 0);
    });
    await writeLegacy(path, { version: 1, sessions: [session('repaired')], lark_bindings: [] });
    assert.equal((await State.open(path)).session('repaired').session_id, 'repaired');
  });
}

test('an interrupted migration rolls back schema, imported rows and version markers; retry imports cleanly', async t => {
  const path = await directory(t); const original = await writeLegacy(path);
  const exec = DatabaseSync.prototype.exec;
  let interrupted = false;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT' && !interrupted) { interrupted = true; throw new Error('Injected migration interruption'); }
    return exec.call(this, sql);
  });
  await assert.rejects(State.open(path), /Injected migration interruption/);
  mock.mock.restore();
  inspect(path, db => {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table'").get()!.count, 0);
  });
  assert.equal(await readFile(join(path, 'state.json'), 'utf8'), original);
  const restored = await State.open(path);
  assert.equal(restored.inboxMessages.size, 3);
  assert.equal(inspect(path, db => db.prepare('SELECT count(*) AS count FROM schema_migrations').get()!.count), STATE_SCHEMA_VERSION);
});

test('a failed SQL transaction rolls back changes across tables and a later save can retry', async t => {
  const path = await directory(t); const state = await State.open(path);
  state.sessions.set('existing', session('existing', 'Before')); state.settings.github_token = 'old-token'; await state.save();
  execute(path, "CREATE TRIGGER refuse_setting BEFORE UPDATE ON settings WHEN NEW.id = 'github_token' BEGIN SELECT RAISE(ABORT, 'Injected SQL failure'); END");
  await assert.rejects(state.save({
    apply() { state.sessions.get('existing')!.session_name = 'After'; state.sessions.set('new', session('new')); state.settings.github_token = 'new-token'; },
    rollback() { state.sessions.get('existing')!.session_name = 'Before'; state.sessions.delete('new'); state.settings.github_token = 'old-token'; },
  }), /Injected SQL failure/);
  const restored = await State.open(path);
  assert.equal(restored.session('existing').session_name, 'Before'); assert.equal(restored.sessions.has('new'), false);
  assert.equal(restored.settings.github_token, 'old-token'); assert.equal(state.settings.github_token, 'old-token');
  await state.save();
  execute(path, 'DROP TRIGGER refuse_setting');
  state.sessions.get('existing')!.session_name = 'After'; state.settings.github_token = 'new-token'; await state.save();
  assert.equal((await State.open(path)).session('existing').session_name, 'After');
  assert.equal((await State.open(path)).settings.github_token, 'new-token');
});

test('unchanged rows are not rewritten, and Map order survives updates, removal and reinsertion', async t => {
  const path = await directory(t); const state = await State.open(path);
  for (const id of ['one', 'two', 'three']) state.sessions.set(id, session(id));
  await state.save();
  execute(path, `CREATE TABLE audit (operation TEXT NOT NULL);
    CREATE TRIGGER count_session_updates AFTER UPDATE ON sessions BEGIN INSERT INTO audit VALUES ('update'); END;`);
  await state.save(); state.settings.github_token = 'token'; await state.save();
  assert.equal(inspect(path, db => db.prepare('SELECT count(*) AS count FROM audit').get()!.count), 0);
  state.sessions.get('two')!.session_name = 'Renamed'; await state.save();
  assert.equal(inspect(path, db => db.prepare('SELECT count(*) AS count FROM audit').get()!.count), 1);
  const second = state.sessions.get('two')!; state.sessions.delete('two'); state.sessions.set('two', second); await state.save();
  assert.deepEqual([...(await State.open(path)).sessions.keys()], ['one', 'three', 'two']);
  assert.equal((await State.open(path)).session('two').session_name, 'Renamed');
});

test('evicting the oldest record and appending one leaves all surviving rows untouched', async t => {
  const path = await directory(t); const state = await State.open(path);
  for (const id of ['one', 'two', 'three']) state.sessions.set(id, session(id));
  await state.save();
  execute(path, `CREATE TABLE audit (id TEXT NOT NULL);
    CREATE TRIGGER count_eviction_updates AFTER UPDATE ON sessions BEGIN INSERT INTO audit VALUES (NEW.id); END;`);
  state.sessions.delete('one'); state.sessions.set('four', session('four')); await state.save();
  assert.equal(inspect(path, db => db.prepare('SELECT count(*) AS count FROM audit').get()!.count), 0);
  const restarted = await State.open(path);
  assert.deepEqual([...restarted.sessions.keys()], ['two', 'three', 'four']);
  restarted.sessions.delete('two'); restarted.sessions.set('five', session('five')); await restarted.save();
  assert.equal(inspect(path, db => db.prepare('SELECT count(*) AS count FROM audit').get()!.count), 0);
  assert.deepEqual([...(await State.open(path)).sessions.keys()], ['three', 'four', 'five']);
});

test('concurrent openers migrate once, and unrelated updates from a stale instance do not erase newer rows', async t => {
  const path = await directory(t); await writeLegacy(path, { version: 1, sessions: [], lark_bindings: [], settings: { github_token: 'old' } });
  const [first, second] = await Promise.all([State.open(path), State.open(path)]);
  first.settings.github_token = 'new'; first.sessions.set('first', session('first')); await first.save();
  second.sessions.set('second', session('second')); await second.save();
  const restored = await State.open(path);
  assert.equal(restored.settings.github_token, 'new');
  assert.ok(restored.sessions.has('first')); assert.ok(restored.sessions.has('second'));
  assert.equal(inspect(path, db => db.prepare('SELECT count(*) AS count FROM schema_migrations').get()!.count), STATE_SCHEMA_VERSION);
});

test('a newer database is refused without falling back to JSON or changing its version', async t => {
  const path = await directory(t); const state = await State.open(path);
  state.settings.github_token = 'kept'; await state.save();
  await writeLegacy(path); execute(path, `PRAGMA user_version = ${STATE_SCHEMA_VERSION + 1}`);
  await assert.rejects(State.open(path), /newer Nootify version/);
  assert.equal(inspect(path, db => db.prepare('PRAGMA user_version').get()!.user_version), STATE_SCHEMA_VERSION + 1);
  assert.equal(inspect(path, db => db.prepare("SELECT value FROM settings WHERE id = 'github_token'").get()!.value), '"kept"');
});

test('a corrupt database is not replaced by an older JSON snapshot', async t => {
  const path = await directory(t); const corrupted = 'This is not a SQLite database';
  await writeFile(join(path, 'state.sqlite'), corrupted); await writeLegacy(path);
  await assert.rejects(State.open(path));
  assert.equal(await readFile(join(path, 'state.sqlite'), 'utf8'), corrupted);
});

test('an initialized empty database never imports JSON that appears on a later launch', async t => {
  const path = await directory(t); await State.open(path); await writeLegacy(path);
  const restored = await State.open(path);
  assert.equal(restored.sessions.size, 0); assert.deepEqual(restored.settings, {});
});

test('WAL and shared-memory files keep private permissions while another reader is open', async t => {
  const path = await directory(t); const state = await State.open(path);
  const reader = new DatabaseSync(join(path, 'state.sqlite'), { readOnly: true });
  try {
    reader.exec('BEGIN'); reader.prepare('SELECT count(*) FROM settings').get();
    state.settings.github_token = 'private-token'; await state.save();
    for (const suffix of ['', '-wal', '-shm']) assert.equal((await stat(join(path, 'state.sqlite' + suffix))).mode & 0o777, 0o600);
  } finally { reader.close(); }
});

test('SQLite v1 converts legacy completion arrays without changing cursor order, opaque data or import authority', async t => {
  const path = await directory(t); const rows = emptyStateRows();
  const first = { ...cursor('omt_first'), root_message_id: 'om_root', recent: [['same-id', 1_001], ['other-id', 1_001]], opaque: { future: ['retained'] } };
  const second = { ...cursor('omt_second'), recent: [['same-id', 1_002]] };
  rows.lark_poll_cursors.set(larkPollCursorKey(first), JSON.stringify(first));
  rows.lark_poll_cursors.set(larkPollCursorKey(second), JSON.stringify(second));
  rows.sessions.set('opaque', JSON.stringify({ ...session('opaque'), future: { nested: 42 } }));
  rows.settings.set('github_token', JSON.stringify('sqlite-v1-token'));
  writeVersionOne(path, rows);
  await writeFile(join(path, 'state.json'), '{broken stale JSON');
  const state = await State.open(path);
  const { recent: firstRecent, ...firstCurrent } = first; const { recent: secondRecent, ...secondCurrent } = second;
  assert.deepEqual([...state.larkPollCursors.values()], [firstCurrent, secondCurrent]);
  assert.deepEqual([...state.larkPollReceipts(larkPollCursorKey(first))], firstRecent);
  assert.deepEqual([...state.larkPollReceipts(larkPollCursorKey(second))], secondRecent);
  assert.deepEqual(state.session('opaque'), { ...session('opaque'), future: { nested: 42 } });
  assert.equal(state.settings.github_token, 'sqlite-v1-token');
  inspect(path, db => {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, STATE_SCHEMA_VERSION);
    assert.deepEqual({ ...db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all()[0] }, { version: 1, applied_at: 'original-v1-migration' });
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key = 'legacy_state_json_imported_at'").get()!.value, 'original-json-import');
    assert.deepEqual(db.prepare('SELECT position FROM lark_poll_cursors ORDER BY position').all().map(row => row.position), [0, 3]);
    assert.equal(db.prepare('SELECT count(*) AS count FROM lark_poll_receipts').get()!.count, 3);
    assert.ok(db.prepare("EXPLAIN QUERY PLAN SELECT id FROM lark_poll_receipts WHERE json_extract(value, '$.cursor_id') = ? AND json_extract(value, '$.create_time') < ?")
      .all(larkPollCursorKey(first), 1_002).some(row => String(row.detail).includes('lark_poll_receipts_cursor_time')));
    assert.equal(db.prepare('SELECT value FROM sessions').get()!.value, rows.sessions.get('opaque'));
  });
  await state.save();
  const reopened = await State.open(path);
  assert.deepEqual([...reopened.larkPollReceipts(larkPollCursorKey(first))], firstRecent);
  assert.equal(await readFile(join(path, 'state.json'), 'utf8'), '{broken stale JSON');
});

for (const [label, recent] of [
  ['non-array', {}], ['null', null], ['short tuple', [['om', 1_000], ['broken']]],
  ['non-string ID', [[42, 1_000]]], ['empty ID', [['', 1_000]]],
  ['non-number time', [['om', '1000']]], ['fractional time', [['om', 1.5]]],
  ['unsafe time', [['om', Number.MAX_SAFE_INTEGER + 1]]], ['conflicting duplicates', [['om', 1_000], ['om', 1_001]]],
] as const) {
  test(`malformed ${label} completion data rolls back SQLite v1 and JSON imports`, async t => {
    const oldCursor = { ...cursor('omt_broken'), recent };
    const sqlitePath = await directory(t); const rows = emptyStateRows();
    rows.lark_poll_cursors.set(larkPollCursorKey(oldCursor), JSON.stringify(oldCursor));
    writeVersionOne(sqlitePath, rows);
    await assert.rejects(State.open(sqlitePath), /Invalid service state/);
    inspect(sqlitePath, db => {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1);
      assert.equal(db.prepare('SELECT count(*) AS count FROM schema_migrations').get()!.count, 1);
      assert.equal(db.prepare('SELECT value FROM lark_poll_cursors').get()!.value, rows.lark_poll_cursors.get(larkPollCursorKey(oldCursor)));
      assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'lark_poll_receipts'").get(), undefined);
    });
    const jsonPath = await directory(t);
    const original = await writeLegacy(jsonPath, { version: 1, sessions: [], lark_bindings: [], lark_poll_cursors: [oldCursor] });
    await assert.rejects(State.open(jsonPath), /Invalid service state/);
    assert.equal(await readFile(join(jsonPath, 'state.json'), 'utf8'), original);
    assert.equal(inspect(jsonPath, db => db.prepare('PRAGMA user_version').get()!.user_version), 0);
  });
}

test('an interrupted SQLite v1 upgrade leaves its cursor arrays intact and retries cleanly', async t => {
  const path = await directory(t); const rows = emptyStateRows(); const oldCursor = { ...cursor('omt_upgrade'), recent: [['om', 1_000]] };
  rows.lark_poll_cursors.set(larkPollCursorKey(oldCursor), JSON.stringify(oldCursor)); writeVersionOne(path, rows);
  const exec = DatabaseSync.prototype.exec; let interrupted = false;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT' && !interrupted) { interrupted = true; throw new Error('Interrupted receipt migration'); }
    return exec.call(this, sql);
  });
  await assert.rejects(State.open(path), /Interrupted receipt migration/); mock.mock.restore();
  inspect(path, db => {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1);
    assert.equal(db.prepare('SELECT value FROM lark_poll_cursors').get()!.value, rows.lark_poll_cursors.get(larkPollCursorKey(oldCursor)));
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'lark_poll_receipts'").get(), undefined);
  });
  assert.equal((await State.open(path)).hasLarkPollReceipt(larkPollCursorKey(oldCursor), 'om'), true);
});

test('batched checkpoints append keyed receipts and prune only strictly older IDs for the requested cursor', async t => {
  const path = await directory(t); const state = await State.open(path); const first = cursor('omt_first'); const second = cursor('omt_second');
  const firstId = larkPollCursorKey(first); const secondId = larkPollCursorKey(second);
  await state.saveLarkPollProgress([first, second], [receipt(first, 'same-id', 1_049), receipt(first, 'at-boundary', 1_050), receipt(second, 'same-id', 1_049)]);
  await state.saveLarkPollProgress([{ ...first, through: 1_100 }], [receipt(first, 'new-id', 1_051), receipt(first, 'old-in-same-batch', 1_048)], [{ cursor_id: firstId, before: 1_050 }]);
  assert.deepEqual([...state.larkPollReceipts(firstId)], [['at-boundary', 1_050], ['new-id', 1_051]]);
  assert.equal(state.hasLarkPollReceipt(firstId, 'same-id'), false);
  assert.equal(state.hasLarkPollReceipt(secondId, 'same-id'), true);
  assert.equal(state.larkPollReceipts('missing').size, 0);
  state.settings.github_token = 'ordinary-save'; await state.save();
  const reopened = await State.open(path);
  assert.deepEqual([...reopened.larkPollReceipts(firstId)], [...state.larkPollReceipts(firstId)]);
  assert.equal(reopened.larkPollCursors.get(firstId)!.through, 1_100);
  assert.equal(reopened.hasLarkPollReceipt(secondId, 'same-id'), true);
  inspect(path, db => {
    assert.equal(db.prepare('SELECT count(*) AS count FROM lark_poll_receipts').get()!.count, 3);
    const saved = JSON.parse(String(db.prepare('SELECT value FROM lark_poll_cursors WHERE id = ?').get(firstId)!.value));
    assert.equal(saved.recent, undefined);
    assert.ok(db.prepare('SELECT id FROM lark_poll_receipts').all().some(row => row.id === larkPollReceiptKey(secondId, 'same-id')));
  });
});

test('one progress call batches multiple cursor and receipt changes into one commit; unchanged calls do not commit', async t => {
  const path = await directory(t); const state = await State.open(path); const first = cursor('omt_one'); const second = cursor('omt_two');
  const exec = DatabaseSync.prototype.exec; let commits = 0;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT') commits++;
    return exec.call(this, sql);
  });
  await state.saveLarkPollProgress([first, second], [receipt(first, 'one', 1_001), receipt(second, 'two', 1_002)]);
  assert.equal(commits, 1);
  await state.saveLarkPollProgress([]);
  await state.saveLarkPollProgress([first, second], [receipt(first, 'one', 1_001)], [{ cursor_id: larkPollCursorKey(first), before: 1_001 }]);
  assert.equal(commits, 1);
  await state.saveLarkPollProgress([], [], [{ cursor_id: larkPollCursorKey(first), before: 1_002 }]);
  assert.equal(commits, 2); mock.mock.restore();
  assert.equal((await State.open(path)).hasLarkPollReceipt(larkPollCursorKey(first), 'one'), false);
});

test('checkpoint pages encode only new receipts and cursors, without serializing unrelated inbox or delivery payloads', async t => {
  const path = await directory(t); await writeLegacy(path); const state = await State.open(path); const progress = cursor('omt_catchup');
  await state.saveLarkPollProgress([progress]);
  const failSerialization = () => { throw new Error('Unrelated payload was serialized'); };
  for (const record of [...state.sessions.values(), ...state.deliveries.values(), ...state.chatDeliveries.values(), ...state.inboxMessages.values()]) {
    Object.defineProperty(record, 'toJSON', { value: failSerialization, configurable: true });
  }
  execute(path, `CREATE TABLE receipt_audit (id TEXT NOT NULL);
    CREATE TRIGGER count_receipt_inserts AFTER INSERT ON lark_poll_receipts BEGIN INSERT INTO receipt_audit VALUES (NEW.id); END;
    CREATE TRIGGER reject_receipt_rewrites BEFORE UPDATE ON lark_poll_receipts BEGIN SELECT RAISE(ABORT, 'Completed receipt was rewritten'); END;`);
  let encodings = 0; const stringify = JSON.stringify;
  const mock = t.mock.method(JSON, 'stringify', (value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'cursor_id' in value && 'message_id' in value) encodings++;
    return stringify(value);
  });
  for (let page = 0; page < 4; page++) {
    const completed = Array.from({ length: 50 }, (_, index) => receipt(progress, `message-${page * 50 + index}`, 1_001 + page * 50 + index));
    await state.saveLarkPollProgress([progress], completed);
  }
  assert.equal(encodings, 200); mock.mock.restore();
  assert.equal(state.larkPollReceipts(larkPollCursorKey(progress)).size, 200);
  assert.equal(inspect(path, db => db.prepare('SELECT count(*) AS count FROM receipt_audit').get()!.count), 200);
  assert.equal((await State.open(path)).larkPollReceipts(larkPollCursorKey(progress)).size, 200);
});

test('receipt insertion or pruning failures atomically roll back all cursor and receipt changes and can retry', async t => {
  const path = await directory(t); const state = await State.open(path); const first = cursor('omt_atomic'); const other = cursor('omt_new');
  const firstId = larkPollCursorKey(first); const otherId = larkPollCursorKey(other);
  await state.saveLarkPollProgress([first], [receipt(first, 'old', 1_001)]);
  const previous = state.larkPollCursors.get(firstId);
  execute(path, `CREATE TRIGGER reject_bad_receipt BEFORE INSERT ON lark_poll_receipts WHEN json_extract(NEW.value, '$.message_id') = 'bad'
    BEGIN SELECT RAISE(ABORT, 'Injected receipt insert failure'); END;`);
  const updates = [{ ...first, through: 1_100 }, other];
  const completions = [receipt(first, 'new', 1_050), receipt(other, 'bad', 1_050)];
  const prune = [{ cursor_id: firstId, before: 1_050 }];
  await assert.rejects(state.saveLarkPollProgress(updates, completions, prune), /Injected receipt insert failure/);
  assert.equal(state.larkPollCursors.get(firstId), previous); assert.equal(state.larkPollCursors.has(otherId), false);
  assert.deepEqual([...state.larkPollReceipts(firstId)], [['old', 1_001]]); assert.equal(state.hasLarkPollReceipt(otherId, 'bad'), false);
  assert.equal((await State.open(path)).larkPollCursors.get(firstId)!.through, 1_000);
  execute(path, `DROP TRIGGER reject_bad_receipt;
    CREATE TRIGGER reject_receipt_prune BEFORE DELETE ON lark_poll_receipts BEGIN SELECT RAISE(ABORT, 'Injected receipt prune failure'); END;`);
  await assert.rejects(state.saveLarkPollProgress(updates, completions, prune), /Injected receipt prune failure/);
  assert.equal(state.larkPollCursors.get(firstId), previous);
  assert.deepEqual([...(await State.open(path)).larkPollReceipts(firstId)], [['old', 1_001]]);
  execute(path, 'DROP TRIGGER reject_receipt_prune');
  await state.saveLarkPollProgress(updates, completions, prune);
  const reopened = await State.open(path);
  assert.equal(reopened.larkPollCursors.get(firstId)!.through, 1_100); assert.equal(reopened.larkPollCursors.has(otherId), true);
  assert.deepEqual([...reopened.larkPollReceipts(firstId)], [['new', 1_050]]);
  assert.equal(reopened.hasLarkPollReceipt(otherId, 'bad'), true);
});

test('an interrupted checkpoint commit publishes neither cursor state nor cached receipt rows', async t => {
  const path = await directory(t); const state = await State.open(path); const original = cursor('omt_commit'); const id = larkPollCursorKey(original);
  await state.saveLarkPollProgress([original]); const previous = state.larkPollCursors.get(id);
  const exec = DatabaseSync.prototype.exec; let interrupted = false;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT' && !interrupted) { interrupted = true; throw new Error('Injected checkpoint commit failure'); }
    return exec.call(this, sql);
  });
  const next = { ...original, through: 1_100 }; const completed = receipt(next, 'new', 1_050);
  await assert.rejects(state.saveLarkPollProgress([next], [completed]), /Injected checkpoint commit failure/);
  mock.mock.restore();
  assert.equal(state.larkPollCursors.get(id), previous); assert.equal(state.hasLarkPollReceipt(id, 'new'), false);
  assert.equal((await State.open(path)).larkPollCursors.get(id)!.through, 1_000);
  await state.saveLarkPollProgress([next], [completed]);
  assert.equal((await State.open(path)).hasLarkPollReceipt(id, 'new'), true);
});

test('a failed ordinary save rolls back before a queued checkpoint or later snapshot runs', async t => {
  const path = await directory(t); const state = await State.open(path); const original = cursor('omt_queue'); const id = larkPollCursorKey(original);
  state.settings.github_token = 'before'; await state.save(); await state.saveLarkPollProgress([original]);
  let entered!: () => void; let release!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const write = StateDatabase.prototype.write; let fail = true;
  t.mock.method(StateDatabase.prototype, 'write', async function (this: StateDatabase, rows: StateRows) {
    if (this.path === join(path, 'state.sqlite') && fail) { fail = false; entered(); await gate; throw new Error('Queued ordinary save failure'); }
    return write.call(this, rows);
  });
  const failing = assert.rejects(state.save({
    apply() { state.settings.github_token = 'failed'; }, rollback() { state.settings.github_token = 'before'; },
  }), /Queued ordinary save failure/);
  await blocked;
  const checkpoint = state.saveLarkPollProgress([{ ...original, through: 1_100 }], [receipt(original, 'done', 1_050)]);
  const later = state.save(); release(); await Promise.all([failing, checkpoint, later]);
  const reopened = await State.open(path);
  assert.equal(reopened.settings.github_token, 'before'); assert.equal(reopened.larkPollCursors.get(id)!.through, 1_100);
  assert.equal(reopened.hasLarkPollReceipt(id, 'done'), true);
});

test('a failed checkpoint cannot leak through a queued ordinary snapshot', async t => {
  const path = await directory(t); const state = await State.open(path); const original = cursor('omt_failed_queue'); const id = larkPollCursorKey(original);
  await state.saveLarkPollProgress([original]); const previous = state.larkPollCursors.get(id);
  let entered!: () => void; let release!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const patch = StateDatabase.prototype.patch; let fail = true;
  t.mock.method(StateDatabase.prototype, 'patch', async function (this: StateDatabase, rows: StatePatch, prune?: Parameters<StateDatabase['patch']>[1]) {
    if (this.path === join(path, 'state.sqlite') && fail) { fail = false; entered(); await gate; throw new Error('Queued checkpoint failure'); }
    return patch.call(this, rows, prune);
  });
  const failing = assert.rejects(state.saveLarkPollProgress([{ ...original, through: 1_100 }], [receipt(original, 'failed', 1_050)]), /Queued checkpoint failure/);
  await blocked;
  const later = state.save({ apply() { state.settings.github_token = 'later'; }, rollback() { delete state.settings.github_token; } });
  assert.equal(state.larkPollCursors.get(id), previous); assert.equal(state.hasLarkPollReceipt(id, 'failed'), false);
  release(); await Promise.all([failing, later]);
  const reopened = await State.open(path);
  assert.equal(reopened.settings.github_token, 'later'); assert.equal(reopened.larkPollCursors.get(id)!.through, 1_000);
  assert.equal(reopened.hasLarkPollReceipt(id, 'failed'), false);
});

test('ordinary saves still persist shared source mutations after checkpointing and ledger eviction', async t => {
  const path = await directory(t); await writeLegacy(path); const state = await State.open(path);
  const feishu = state.larkDelivery('om_original')!; const slack = state.chatDelivery('slack-delivery')!;
  await state.saveLarkPollProgress([cursor('omt_source')], [receipt(cursor('omt_source'), 'completed', 1_001)]);
  feishu.acknowledged_at = '2026-11-06T01:00:00.000Z';
  feishu.replies.push({ digest: 'new-feishu-digest', message_id: 'new-feishu-reply', time: feishu.acknowledged_at });
  slack.acknowledged_at = feishu.acknowledged_at;
  slack.replies.push({ digest: 'new-slack-digest', message_id: 'new-slack-reply', time: feishu.acknowledged_at });
  state.deliveries.delete(feishu.message_id); state.chatDeliveries.delete(slack.id); await state.save();
  const reopened = await State.open(path);
  assert.equal(reopened.larkDelivery(feishu.message_id), reopened.inboxMessages.get('inbox-feishu')!.source!.delivery);
  assert.equal(reopened.chatDelivery(slack.id), reopened.inboxMessages.get('inbox-slack')!.source!.delivery);
  assert.equal(reopened.larkDelivery(feishu.message_id)!.acknowledged_at, feishu.acknowledged_at);
  assert.equal(reopened.larkDelivery(feishu.message_id)!.replies.at(-1)!.digest, 'new-feishu-digest');
  assert.equal(reopened.chatDelivery(slack.id)!.replies.at(-1)!.digest, 'new-slack-digest');
});

test('load returns defensive string maps and key patches preserve unseen rows and live maximum ordinals', async t => {
  const path = await directory(t); const first = await StateDatabase.open(path, async () => undefined);
  const initial = emptyStateRows();
  initial.sessions.set('one', JSON.stringify(session('one'))); initial.sessions.set('two', JSON.stringify(session('two')));
  await first.write(initial);
  const stale = await StateDatabase.open(path, async () => { throw new Error('Unexpected legacy import'); });
  const loaded = first.load(); loaded.sessions.clear(); loaded.settings.set('github_token', '"mutated-copy"');
  assert.equal(first.load().sessions.size, 2); assert.equal(first.load().settings.size, 0);
  execute(path, `CREATE TABLE ordinal_audit (id TEXT NOT NULL);
    CREATE TRIGGER count_ordinal_updates AFTER UPDATE ON sessions BEGIN INSERT INTO ordinal_audit VALUES (NEW.id); END;`);
  await first.patch({ sessions: new Map([['one', undefined], ['three', JSON.stringify(session('three'))]]) });
  await stale.patch({ sessions: new Map([['four', JSON.stringify(session('four'))]]), settings: new Map([['github_token', '"latest"']]) });
  assert.deepEqual(inspect(path, db => db.prepare('SELECT id, position FROM sessions ORDER BY position').all().map(row => [row.id, row.position])), [['two', 1], ['three', 2], ['four', 3]]);
  assert.equal(inspect(path, db => db.prepare('SELECT count(*) AS count FROM ordinal_audit').get()!.count), 0);
  const changed = first.load(); changed.sessions.set('two', JSON.stringify(session('two', 'Renamed')));
  await first.write(changed);
  const reopened = await State.open(path);
  assert.deepEqual([...reopened.sessions.keys()], ['two', 'three', 'four']); assert.equal(reopened.session('two').session_name, 'Renamed');
  assert.equal(reopened.settings.github_token, 'latest');
});

test('stale checkpoints preserve foreign receipts and pruning also removes unseen rows in the requested range', async t => {
  const path = await directory(t); const first = await State.open(path); const value = cursor('omt_stale'); const other = cursor('omt_foreign');
  await first.saveLarkPollProgress([value, other]); const stale = await State.open(path);
  const id = larkPollCursorKey(value); const otherId = larkPollCursorKey(other);
  await first.saveLarkPollProgress([], [receipt(value, 'unseen-old', 1_001), receipt(value, 'unseen-new', 1_099), receipt(other, 'foreign-old', 1_001)]);
  await stale.saveLarkPollProgress([{ ...value, through: 1_100 }], [receipt(value, 'own', 1_050)], [{ cursor_id: id, before: 1_050 }]);
  stale.settings.github_token = 'stale-save'; await stale.save();
  const reopened = await State.open(path);
  assert.deepEqual([...reopened.larkPollReceipts(id)], [['unseen-new', 1_099], ['own', 1_050]]);
  assert.equal(reopened.hasLarkPollReceipt(otherId, 'foreign-old'), true);
  assert.equal(reopened.larkPollCursors.get(id)!.through, 1_100);
});

test('receipt keys distinguish opaque cursor and message IDs containing delimiters', async t => {
  const path = await directory(t); const state = await State.open(path);
  const first = { cursor_id: 'cursor:x', message_id: 'y', create_time: 1_001 };
  const second = { cursor_id: 'cursor', message_id: 'x:y', create_time: 1_002 };
  const third = { cursor_id: 'cursor:["quoted"]', message_id: 'id,with]delimiters', create_time: 1_003 };
  await state.saveLarkPollProgress([], [first, second, third]);
  const reopened = await State.open(path);
  for (const entry of [first, second, third]) assert.equal(reopened.larkPollReceipts(entry.cursor_id).get(entry.message_id), entry.create_time);
  assert.equal(inspect(path, db => db.prepare('SELECT count(*) AS count FROM lark_poll_receipts').get()!.count), 3);
});

test('a live schema change prevents checkpoint writes without publishing progress', async t => {
  const path = await directory(t); const state = await State.open(path); const original = cursor('omt_schema'); const id = larkPollCursorKey(original);
  await state.saveLarkPollProgress([original]); const previous = state.larkPollCursors.get(id);
  execute(path, `PRAGMA user_version = ${STATE_SCHEMA_VERSION + 1}`);
  await assert.rejects(state.saveLarkPollProgress([{ ...original, through: 1_100 }], [receipt(original, 'blocked', 1_050)]), /schema changed/);
  assert.equal(state.larkPollCursors.get(id), previous); assert.equal(state.hasLarkPollReceipt(id, 'blocked'), false);
  assert.equal(inspect(path, db => db.prepare('SELECT count(*) AS count FROM lark_poll_receipts').get()!.count), 0);
});
