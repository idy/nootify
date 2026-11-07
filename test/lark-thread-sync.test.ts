import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { LarkThreadSync, type ThreadDiscovery } from '../src/lark-thread-sync.js';
import { LarkThreads, threadName } from '../src/lark-threads.js';
import type { LarkApi } from '../src/lark-metadata.js';
import { LarkService } from '../src/lark.js';
import { SessionsService } from '../src/sessions.js';
import { State } from '../src/state.js';
import type { ThreadRequest } from '../src/types.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
const session = (id: string): ThreadRequest => ({ adapter: 'codex', session_id: id, session_name: `Task ${id}` });
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-group-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await State.open(directory);
  state.settings.lark_recipient_open_id = 'ou_owner'; await state.save();
  const chats: { chat_id: string; name: string }[] = [];
  const announcements = new Map<string, string>();
  const reports: Record<string, unknown>[] = [];
  let creates = 0;
  const createdByKey = new Map<string, string>();
  let failAnnouncement = false;
  const api: LarkApi = { appId: 'cli_test', async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, 'https://open.feishu.cn');
    if (url.pathname === '/open-apis/im/v1/chats') {
      if (method === 'GET') return { items: chats, has_more: false } as T;
      const uuid = url.searchParams.get('uuid'); assert.ok(uuid, 'creation retries carry a stable provider idempotency key');
      const previous = createdByKey.get(uuid);
      if (previous) return { chat_id: previous } as T;
      const chat_id = `oc_${++creates}`;
      createdByKey.set(uuid, chat_id);
      chats.push({ chat_id, name: (body as { name: string }).name }); announcements.set(chat_id, '');
      return { chat_id } as T;
    }
    const id = /^\/open-apis\/im\/v1\/chats\/([^/]+)\/announcement$/.exec(url.pathname)?.[1];
    assert.ok(id, `Unexpected ${method} ${path}`);
    if (method === 'GET') return { revision: '1', content: announcements.get(id) ?? '' } as T;
    if (failAnnouncement) throw new Error('temporary announcement failure');
    const operation = JSON.parse((body as { requests: string[] }).requests[0]);
    announcements.set(id, JSON.parse(operation.insertBlocksRequest.payload).blocks[0].paragraph.elements[0].textRun.text);
    return {} as T;
  } };
  const candidates = [session('old-thread')];
  const discover: ThreadDiscovery = async function* () { yield* candidates; };
  const threads = new LarkThreads(state, api, record => reports.push(record));
  const options = { state, threads, discover, report: (record: Record<string, unknown>) => reports.push(record) };
  const sync = new LarkThreadSync(options);
  t.after(() => sync.stop());
  return { state, directory, api, chats, announcements, candidates, discover, threads, options, sync, reports,
    creates: () => creates, failAnnouncement: (fail: boolean) => { failAnnouncement = fail; } };
}

test('old threads get groups and SQLite bindings without running the notification CLI', async t => {
  const f = await fixture(t);
  f.candidates.push(session('second-thread'), session('old-thread'));
  await f.sync.reconcile();
  assert.equal(f.creates(), 2);
  const saved = await State.open(f.directory);
  const binding = [...saved.bindings.values()].find(value => value.session_id === 'old-thread')!;
  assert.equal(binding.app_id, 'cli_test'); assert.equal(binding.sender_open_id, 'ou_owner');
  assert.equal(binding.adapter, 'codex'); assert.equal(binding.announcement_pending, undefined);
  assert.equal(f.announcements.get(binding.chat_id), `agent-session:v1:${hostname()}:codex:old-thread`);
  const db = new DatabaseSync(join(f.directory, 'state.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lark_bindings').get()!.count, 2); }
  finally { db.close(); }
  await f.sync.reconcile();
  const restarted = new LarkThreadSync({ ...f.options, state: saved, threads: new LarkThreads(saved, f.api) });
  await restarted.reconcile();
  assert.equal(f.creates(), 2, 'repeated scans and a fresh SQLite-backed service do not recreate groups');
});

test('existing legacy groups are adopted and saved, and manual thread-open shares automatic creation', async t => {
  const f = await fixture(t);
  f.chats.push({ chat_id: 'oc_existing', name: threadName('Original', 'codex', 'old-thread') });
  f.announcements.set('oc_existing', `agent-session:v1:${hostname()}:codex:old-thread`);
  await Promise.all([f.sync.reconcile(), f.threads.open('codex', 'old-thread', 'Manual')]);
  assert.equal(f.creates(), 0);
  assert.equal((await State.open(f.directory)).bindings.get('oc_existing')?.session_id, 'old-thread');
  f.candidates.push(session('new-thread'));
  await Promise.all([f.sync.reconcile(), f.threads.open('codex', 'new-thread', 'Manual')]);
  assert.equal(f.creates(), 1);
});

test('a persisted pending announcement is repaired on a later scan, including after restart', async t => {
  const f = await fixture(t);
  f.failAnnouncement(true); await f.sync.reconcile();
  assert.equal(f.creates(), 1);
  const state = await State.open(f.directory);
  assert.equal(state.bindings.get('oc_1')?.announcement_pending, true);
  f.failAnnouncement(false);
  await new LarkThreadSync({ ...f.options, state, threads: new LarkThreads(state, f.api) }).reconcile();
  assert.equal(f.creates(), 1);
  assert.equal((await State.open(f.directory)).bindings.get('oc_1')?.announcement_pending, undefined);
  assert.ok(f.reports.some(record => record.status === 'thread_failed'));
});

test('failed SQLite insertion rolls back and retries the same provider group after restart', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(join(f.directory, 'state.sqlite'));
  db.exec("CREATE TRIGGER fail_binding BEFORE INSERT ON lark_bindings BEGIN SELECT RAISE(ABORT, 'injected binding failure'); END");
  try { await f.sync.reconcile(); assert.equal(f.state.bindings.size, 0); }
  finally { db.exec('DROP TRIGGER fail_binding'); db.close(); }
  assert.equal(f.creates(), 1);
  // Neither SQLite nor the announcement knows the group; provider idempotency also survives a fresh service.
  const state = await State.open(f.directory);
  await new LarkThreadSync({ ...f.options, state, threads: new LarkThreads(state, f.api) }).reconcile();
  assert.equal(f.creates(), 1);
  assert.equal((await State.open(f.directory)).bindings.get('oc_1')?.session_id, 'old-thread');
});

test('one thread failure does not prevent another old thread from receiving a group', async t => {
  const f = await fixture(t);
  f.candidates.push(session('other-thread'));
  f.chats.push({ chat_id: 'oc_conflict', name: threadName('Conflict', 'codex', 'old-thread') });
  const request = f.api.request.bind(f.api);
  t.mock.method(f.api, 'request', async (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, signal?: AbortSignal) => {
    if (path.includes('/oc_conflict/announcement')) throw new Error('unavailable old group');
    return request(method, path, body, signal);
  });
  await f.sync.reconcile();
  assert.equal(f.creates(), 1);
  assert.equal(f.state.bindings.get('oc_1')?.session_id, 'other-thread');
});

test('startup scans immediately and the next minute discovers newly added threads', async t => {
  const f = await fixture(t);
  const first = gate(); const tick = gate(); const second = gate();
  const delays: number[] = [];
  const sync = new LarkThreadSync({ ...f.options, wait: async (ms, signal) => {
    delays.push(ms);
    if (delays.length === 1) { first.resolve(); await tick.promise; return; }
    second.resolve();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  } });
  t.after(async () => { tick.resolve(); await sync.stop(); });
  sync.start(); sync.start(); await first.promise;
  assert.equal(f.creates(), 1);
  f.candidates.push(session('later-thread')); tick.resolve(); await second.promise;
  assert.equal(f.creates(), 2); assert.deepEqual(delays, [60_000, 60_000]);
  await sync.stop();
});

test('other notification channels and missing recipients do not create Feishu groups', async t => {
  const f = await fixture(t);
  f.state.settings.notification_channel = 'slack'; await f.sync.reconcile();
  f.state.settings.notification_channel = 'feishu'; delete f.state.settings.lark_recipient_open_id;
  await f.sync.reconcile(); assert.equal(f.creates(), 0);
  f.state.settings.lark_recipient_open_id = 'ou_owner'; await f.sync.reconcile(); assert.equal(f.creates(), 1);
});

test('the Feishu lifecycle starts backfilling and replies reach the old thread through its saved group', async t => {
  const f = await fixture(t); const created = gate(); const sessions = new SessionsService(f.state);
  const send = t.mock.method(sessions, 'send', async (..._args: Parameters<SessionsService['send']>) => ({ status: 'input_accepted' as const }));
  const lark = new LarkService(f.state, sessions, { appId: f.api.appId, appSecret: 'test-only' }, record => {
    if (record.status === 'thread_created') created.resolve();
  }, f.api, 9417, () => ({ start: async () => {}, stop: async () => {} }), f.discover);
  t.after(async () => { await lark.stop(); await sessions.stop(); });
  await lark.start(); await created.promise;
  assert.equal(f.creates(), 1);
  assert.equal(await lark.enqueue({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: { chat_id: 'oc_1', message_id: 'om_reply', message_type: 'text', content: JSON.stringify({ text: 'Continue the old task' }) } }), true);
  assert.equal(send.mock.calls.length, 1);
  assert.equal(send.mock.calls[0].arguments[0], 'old-thread');
  assert.equal((await State.open(f.directory)).deliveries.get('om_reply')?.transport_status, 'input_accepted');
  await lark.configure(undefined);
  assert.equal(lark.status(), 'disabled');
});

test('cancelling reconciliation aborts group lookup and never creates a group', async t => {
  const f = await fixture(t); const reading = gate(); const controller = new AbortController();
  t.mock.method(f.api, 'request', async () => { reading.resolve(); return new Promise<never>(() => {}); });
  const rejected = assert.rejects(f.sync.reconcile(controller.signal), { name: 'AbortError' });
  await reading.promise; controller.abort(); await rejected;
  assert.equal(f.state.bindings.size, 0);
});
