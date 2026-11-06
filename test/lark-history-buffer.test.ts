import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { LarkHistoryBuffer, type LarkHistoryEntry, type LarkHistoryMessage } from '../src/lark-history-buffer.js';

const START = 1_700_000_000_000;
async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'nootify-history-buffer-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const message = (id: string, time: number, content = id): LarkHistoryMessage => ({
  message_id: id, chat_id: 'oc_fixture', create_time: String(time), msg_type: 'text',
  sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_fixture' }, body: { content },
});
const entry = (id: string, time: number, cursorId = 'chat', dispatch = true): LarkHistoryEntry => ({ cursor_id: cursorId, item: message(id, time), dispatch });
async function open(t: TestContext): Promise<{ path: string; buffer: LarkHistoryBuffer; file: string }> {
  const path = await directory(t); const buffer = await LarkHistoryBuffer.open(path);
  t.after(() => buffer.close());
  const files = await readdir(path); assert.equal(files.length, 1);
  return { path, buffer, file: join(path, files[0]) };
}

test('history messages merge across roots and threads in provider-time order with stable equal-time insertion order', async t => {
  const { buffer } = await open(t);
  buffer.append([entry('later-root', START + 30, 'chat'), entry('same-time-first', START + 20, 'chat')]);
  buffer.append([entry('earliest-reply', START + 10, 'thread-a'), entry('same-time-second', START + 20, 'thread-b'), entry('last', START + 40, 'thread-a')]);
  const records = buffer.read();
  assert.deepEqual(records.map(record => record.item.message_id), ['earliest-reply', 'same-time-first', 'same-time-second', 'later-root', 'last']);
  assert.deepEqual(records.map(record => record.time), [START + 10, START + 20, START + 20, START + 30, START + 40]);
  assert.ok(records[1].sequence < records[2].sequence);
  assert.deepEqual(records.map(record => record.cursor_ids), [['thread-a'], ['chat'], ['thread-b'], ['chat'], ['thread-a']]);
  assert.ok(records.every(record => record.dispatch));
});

test('cross-container duplicates collect unique sources and eligible payloads survive metadata-only duplicates', async t => {
  const { buffer } = await open(t);
  const metadata: LarkHistoryMessage = { message_id: 'shared', chat_id: 'oc_fixture', create_time: String(START), thread_id: 'omt_fixture' };
  buffer.append([{ cursor_id: 'chat', item: metadata, dispatch: false }, entry('same-time-peer', START)]);
  const originalSequence = buffer.read()[0].sequence;
  const eligible = { ...message('shared', START, 'the eligible command'), thread_id: 'omt_fixture', root_id: 'om_root' };
  buffer.append([{ cursor_id: 'thread', item: eligible, dispatch: true }, { cursor_id: 'thread', item: eligible, dispatch: true }]);
  buffer.append([{ cursor_id: 'late-metadata', item: { ...metadata, body: { content: 'must not replace the eligible body' } }, dispatch: false },
    { cursor_id: 'another-eligible-source', item: message('shared', START, 'a later duplicate body'), dispatch: true }]);
  const records = buffer.read();
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].item, eligible);
  assert.equal(records[0].dispatch, true); assert.equal(records[0].sequence, originalSequence);
  assert.deepEqual(records[0].cursor_ids, ['chat', 'thread', 'late-metadata', 'another-eligible-source']);
  assert.equal(records[1].item.message_id, 'same-time-peer');
});

test('metadata cannot replace an already eligible first payload and metadata-only messages remain available for receipts', async t => {
  const { buffer } = await open(t); const eligible = message('eligible-first', START, 'keep this body');
  buffer.append([{ cursor_id: 'thread', item: eligible, dispatch: true }, entry('ignored', START + 1, 'chat', false)]);
  buffer.append([{ cursor_id: 'chat', item: { message_id: 'eligible-first', chat_id: 'oc_fixture', create_time: String(START) }, dispatch: false }]);
  const [first, second] = buffer.read();
  assert.deepEqual(first.item, eligible); assert.deepEqual(first.cursor_ids, ['thread', 'chat']); assert.equal(first.dispatch, true);
  assert.equal(second.item.message_id, 'ignored'); assert.equal(second.dispatch, false);
});

test('the retained eligible payload and its provider time stay consistent when it upgrades metadata', async t => {
  const { buffer } = await open(t);
  buffer.append([entry('upgraded', START, 'metadata', false), entry('middle', START + 1)]);
  buffer.append([entry('upgraded', START + 2, 'eligible', true)]);
  const result = buffer.read();
  assert.deepEqual(result.map(record => record.item.message_id), ['middle', 'upgraded']);
  assert.equal(result[1].time, Number(result[1].item.create_time)); assert.deepEqual(result[1].cursor_ids, ['metadata', 'eligible']);
});

test('large paged histories use bounded keyset reads, stable ties and indexed queries', async t => {
  const { buffer, file } = await open(t); const count = 5_000;
  for (let offset = 0; offset < count; offset += 50) {
    buffer.append(Array.from({ length: 50 }, (_, index) => entry(`message-${offset + index}`, START + Math.floor((count - 1 - offset - index) / 7), `thread-${index % 3}`)));
  }
  const first = buffer.read(); assert.equal(first.length, 50);
  const last = first.at(-1)!;
  const parse = JSON.parse; let decodings = 0;
  const mock = t.mock.method(JSON, 'parse', (text: string) => { decodings++; return parse(text); });
  const second = buffer.read({ time: last.time, sequence: last.sequence }, 37);
  assert.equal(second.length, 37); assert.equal(decodings, 37, 'only the requested page should decode message payloads');
  mock.mock.restore();
  const seen = new Set<string>(); let after: { time: number; sequence: number } | undefined;
  let pages = 0;
  for (;;) {
    const page = buffer.read(after, 37); if (!page.length) break;
    pages++; assert.ok(page.length <= 37);
    for (const record of page) {
      assert.equal(seen.has(record.item.message_id), false); seen.add(record.item.message_id);
      if (after) assert.ok(record.time > after.time || (record.time === after.time && record.sequence > after.sequence));
      assert.equal(record.item.body!.content, record.item.message_id);
      after = { time: record.time, sequence: record.sequence };
    }
  }
  assert.equal(seen.size, count); assert.equal(pages, Math.ceil(count / 37));
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const plan = database.prepare('EXPLAIN QUERY PLAN SELECT message_id, time, sequence, item, dispatch FROM messages WHERE (time, sequence) > (?, ?) ORDER BY time, sequence LIMIT ?')
      .all(START + 300, 1, 37).map(row => String(row.detail));
    assert.ok(plan.some(detail => detail.includes('SEARCH messages USING INDEX messages_time_sequence')));
    assert.ok(plan.every(detail => !detail.includes('TEMP B-TREE')), 'a batch should not sort the whole history');
    const sourcePlan = database.prepare('EXPLAIN QUERY PLAN SELECT cursor_id FROM sources WHERE message_id = ? ORDER BY sequence').all('message-1').map(row => String(row.detail));
    assert.ok(sourcePlan.some(detail => detail.includes('sources_message_sequence')));
  } finally { database.close(); }
});

test('keyset reads remain incremental when later provider pages append newer messages', async t => {
  const { buffer } = await open(t);
  buffer.append([entry('one', START), entry('two', START + 1)]);
  const initial = buffer.read(undefined, 1); assert.equal(initial.length, 1);
  buffer.append([entry('three', START + 2), entry('two', START + 1, 'thread')]);
  const next = buffer.read({ time: initial[0].time, sequence: initial[0].sequence });
  assert.deepEqual(next.map(record => record.item.message_id), ['two', 'three']);
  assert.deepEqual(next[0].cursor_ids, ['chat', 'thread']);
  assert.deepEqual(buffer.read({ time: next[1].time, sequence: next[1].sequence }), []);
});

test('spools use unique private files, in-memory journals and idempotent close removes only its own file', async t => {
  const path = await directory(t); const first = await LarkHistoryBuffer.open(path); const second = await LarkHistoryBuffer.open(path);
  t.after(() => first.close()); t.after(() => second.close());
  const files = await readdir(path); assert.equal(files.length, 2);
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  for (const file of files) {
    assert.match(file, new RegExp(`^\\.poll-history-${process.pid}-[0-9a-f-]{36}\\.sqlite$`));
    assert.equal((await stat(join(path, file))).mode & 0o777, 0o600);
  }
  first.append([entry('first', START)]); second.append([entry('second', START)]);
  assert.deepEqual((await readdir(path)).sort(), files.sort(), 'scratch operations should not leave WAL or journal files');
  await first.close(); await first.close();
  assert.equal((await readdir(path)).length, 1); assert.equal(second.read()[0].item.message_id, 'second');
  await second.close(); assert.deepEqual(await readdir(path), []);
  assert.throws(() => first.read(), /closed/); assert.throws(() => first.append([]), /closed/);
});

test('opaque IDs and JSON payloads are bound parameters and preserve their original bytes', async t => {
  const { buffer } = await open(t);
  const item = { ...message("om_'\"); DROP TABLE messages; --", START, 'Unicode 雪\nquotes " and apostrophe \' remain payload'), root_id: 'om_root' };
  buffer.append([{ cursor_id: "cursor'\"; DROP TABLE sources; --", item, dispatch: true }]);
  const [record] = buffer.read(); assert.deepEqual(record.item, item); assert.deepEqual(record.cursor_ids, ["cursor'\"; DROP TABLE sources; --"]);
  buffer.append([entry('still-working', START + 1)]); assert.equal(buffer.read().length, 2);
});

test('a failed append closes the connection and removes even a partially populated spool', async t => {
  const { buffer, path, file } = await open(t);
  const circular = message('circular', START); Object.assign(circular, { circular });
  assert.throws(() => buffer.append([entry('valid-before-failure', START), { cursor_id: 'chat', item: circular, dispatch: true }]), /circular/i);
  assert.deepEqual(await readdir(path), []); await assert.rejects(readFile(file), { code: 'ENOENT' });
  assert.throws(() => buffer.append([entry('later', START)]), /closed/); await buffer.close();
});

test('a failed append commit rolls back and deletes the scratch database', async t => {
  const { buffer, path } = await open(t); const exec = DatabaseSync.prototype.exec;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT') throw new Error('Injected history commit failure');
    return exec.call(this, sql);
  });
  assert.throws(() => buffer.append([entry('not-committed', START)]), /Injected history commit failure/);
  mock.mock.restore(); assert.deepEqual(await readdir(path), []); await buffer.close();
});

test('read errors discard the connection and file and allow repeated close', async t => {
  const { buffer, path } = await open(t); buffer.append([entry('one', START)]);
  const prepare = DatabaseSync.prototype.prepare;
  const mock = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('SELECT message_id')) throw new Error('Injected history read failure');
    return prepare.call(this, sql);
  });
  assert.throws(() => buffer.read(), /Injected history read failure/); mock.mock.restore();
  assert.deepEqual(await readdir(path), []); await buffer.close(); await buffer.close();
});

test('failed spool initialization cleans up its newly created file', async t => {
  const path = await directory(t); const exec = DatabaseSync.prototype.exec;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql.includes('CREATE TABLE messages')) throw new Error('Injected history schema failure');
    return exec.call(this, sql);
  });
  await assert.rejects(LarkHistoryBuffer.open(path), /Injected history schema failure/); mock.mock.restore();
  assert.deepEqual(await readdir(path), []);
});

test('invalid page limits, cursors and provider times fail with scratch cleanup', async t => {
  for (const limit of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const { buffer, path } = await open(t); assert.throws(() => buffer.read(undefined, limit), /Invalid buffered history page/);
    assert.deepEqual(await readdir(path), []);
  }
  const invalidCursor = await open(t);
  assert.throws(() => invalidCursor.buffer.read({ time: NaN, sequence: 1 }), /Invalid buffered history page/);
  assert.deepEqual(await readdir(invalidCursor.path), []);
  for (const time of ['', 'not-a-time', '1.5', String(Number.MAX_SAFE_INTEGER + 1)]) {
    const { buffer, path } = await open(t);
    assert.throws(() => buffer.append([{ cursor_id: 'chat', item: { ...message('bad-time', START), create_time: time }, dispatch: true }]), /Invalid buffered history entry/);
    assert.deepEqual(await readdir(path), []);
  }
});

test('orphan cleanup removes only strict regular spool files owned by provably dead processes', async t => {
  const path = await directory(t);
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { cwd: path, env: {}, stdio: 'ignore' });
  const [exitCode] = await once(dead, 'close'); assert.equal(exitCode, 0); assert.ok(dead.pid);
  assert.throws(() => process.kill(dead.pid!, 0), { code: 'ESRCH' });
  const live = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { cwd: path, env: {}, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => { if (live.exitCode === null && live.signalCode === null) { const closed = once(live, 'close'); live.kill('SIGKILL'); await closed; } });
  await once(live.stdout!, 'data'); assert.ok(live.pid);
  const deadName = `.poll-history-${dead.pid}-${randomUUID()}.sqlite`;
  const liveName = `.poll-history-${live.pid}-${randomUUID()}.sqlite`;
  const currentName = `.poll-history-${process.pid}-${randomUUID()}.sqlite`;
  const unrelated = ['state.sqlite', '.poll-history-not-a-pid.sqlite', `.poll-history-${dead.pid}-not-a-uuid.sqlite`, `${deadName}-wal`, `.poll-history-0-${randomUUID()}.sqlite`];
  for (const name of [deadName, liveName, currentName, ...unrelated]) await writeFile(join(path, name), 'fixture scratch data', { mode: 0o600 });
  await utimes(join(path, liveName), new Date(0), new Date(0)); await utimes(join(path, currentName), new Date(0), new Date(0));
  const linkName = `.poll-history-${dead.pid}-${randomUUID()}.sqlite`; await symlink(join(path, 'state.sqlite'), join(path, linkName));
  const folderName = `.poll-history-${dead.pid}-${randomUUID()}.sqlite`;
  await mkdir(join(path, folderName));
  await LarkHistoryBuffer.cleanupOrphans(path);
  assert.deepEqual((await readdir(path)).sort(), [liveName, currentName, ...unrelated, linkName, folderName].sort());
  assert.equal(await readFile(join(path, 'state.sqlite'), 'utf8'), 'fixture scratch data');
  process.kill(live.pid!, 0);
});

test('orphan cleanup preserves files when process ownership cannot be disproved', async t => {
  const path = await directory(t); const otherPid = process.pid + 1_000_000;
  const name = `.poll-history-${otherPid}-${randomUUID()}.sqlite`; await writeFile(join(path, name), 'keep');
  const kill = process.kill;
  const mock = t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === otherPid) throw Object.assign(new Error('Owner cannot be inspected'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  await LarkHistoryBuffer.cleanupOrphans(path); mock.mock.restore();
  assert.deepEqual(await readdir(path), [name]);
  await LarkHistoryBuffer.cleanupOrphans(join(path, 'already-removed-directory'));
});
