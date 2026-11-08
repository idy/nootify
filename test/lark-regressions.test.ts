import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { ExternalResolver } from '../src/external-sessions.js';
import type { LarkHistoryMessage } from '../src/lark-history-buffer.js';
import { LarkPoller, type LarkPollingOptions } from '../src/lark-polling.js';
import { LarkService } from '../src/lark.js';
import type { LarkApi } from '../src/lark-metadata.js';
import { SessionsService } from '../src/sessions.js';
import { State } from '../src/state.js';
import { HttpError, RetryableDeliveryError, UnconfirmedDeliveryError, larkPollCursorKey, type DeliveryResult, type LarkPollCursor } from '../src/types.js';

const START = 1_700_000_000_000;
const APP = 'cli_regression_fixture';
const OWNER = 'ou_fixture_owner';
const ROUTE = `agent-session:v1:${hostname()}:codex:fixture-session`;
function message(id: string, time: number, chatId = 'oc_bound', extra: Partial<LarkHistoryMessage> = {}): LarkHistoryMessage {
  return { message_id: id, chat_id: chatId, create_time: String(time), msg_type: 'text',
    sender: { sender_type: 'user', id_type: 'open_id', id: OWNER }, body: { content: JSON.stringify({ text: id }) }, ...extra };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function fixture(t: TestContext, bindings = ['oc_bound'], providerClock = false) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-lark-regressions-'));
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => { try { for (const cleanup of cleanups.reverse()) await cleanup(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const state = await State.open(directory);
  for (const chatId of bindings) state.bindings.set(chatId, { chat_id: chatId, session_id: 'fixture-session', sender_open_id: OWNER, adapter: 'codex' });
  await state.save();
  const clock = { epoch: START, mono: 0 };
  const model = { rows: new Map<string, LarkHistoryMessage[]>(), roots: new Map<string, LarkHistoryMessage[]>(), chats: [] as string[], groupPageSize: 100,
    announcements: new Map<string, string>(), hook: undefined as ((url: URL) => unknown | Promise<unknown>) | undefined };
  const calls: { url: URL; mono: number; epoch: number }[] = []; const waits: number[] = [];
  const received: { message: { message_id: string; thread_id?: string } }[] = []; const reports: Record<string, unknown>[] = [];
  const api: LarkApi = { appId: APP, ...(providerClock ? { serverTime: () => START + clock.mono } : {}),
    async request<T>(_method: string, path: string): Promise<T> {
      const url = new URL(path, 'https://provider.invalid'); const query = url.searchParams;
      calls.push({ url, mono: clock.mono, epoch: clock.epoch });
      const override = await model.hook?.(url); if (override !== undefined) return override as T;
      if (url.pathname === '/open-apis/bot/v3/info') return {} as T;
      if (url.pathname.endsWith('/reactions')) return { reaction_id: 'reaction-received' } as T;
      if (url.pathname === '/open-apis/im/v1/chats') {
        const offset = Number(query.get('page_token') ?? 0); const size = model.groupPageSize;
        return { items: model.chats.slice(offset, offset + size).map(chat_id => ({ chat_id })), has_more: model.chats.length > offset + size,
          ...(model.chats.length > offset + size ? { page_token: String(offset + size) } : {}) } as T;
      }
      if (url.pathname.endsWith('/announcement')) {
        const chatId = decodeURIComponent(url.pathname.split('/').at(-2)!);
        return { revision: '1', content: model.announcements.get(chatId) ?? ROUTE } as T;
      }
      assert.equal(url.pathname, '/open-apis/im/v1/messages', `Unexpected fake API call: ${path}`);
      const type = query.get('container_id_type'); const id = query.get('container_id')!;
      if (type === 'thread') {
        assert.equal(query.get('sort_type'), 'ByCreateTimeDesc', 'thread pages follow the documented newest-first provider order');
        assert.equal(query.has('start_time') || query.has('end_time'), false, 'thread history does not support chat time filters');
      }
      const rootIndex = type === 'chat' && query.get('sort_type') === 'ByCreateTimeDesc';
      let rows = [...((rootIndex ? model.roots.get(id) : undefined) ?? model.rows.get(`${type}:${id}`) ?? [])];
      if (query.has('start_time')) rows = rows.filter(item => Number(item.create_time) >= Number(query.get('start_time')) * 1_000);
      if (query.has('end_time')) rows = rows.filter(item => Number(item.create_time) <= Number(query.get('end_time')) * 1_000);
      rows.sort((a, b) => Number(a.create_time) - Number(b.create_time));
      if (query.get('sort_type') === 'ByCreateTimeDesc') rows.reverse();
      const offset = Number(query.get('page_token') ?? 0); const size = Number(query.get('page_size') ?? 50);
      return { items: rows.slice(offset, offset + size), has_more: rows.length > offset + size,
        ...(rows.length > offset + size ? { page_token: String(offset + size) } : {}) } as T;
    } };
  const options: LarkPollingOptions = { state, api, now: () => clock.epoch, monotonic: () => clock.mono,
    wait: async (ms, signal) => { signal.throwIfAborted(); waits.push(ms); clock.mono += ms; clock.epoch += ms; },
    receive: async payload => { received.push(payload as typeof received[number]); return true; }, report: value => reports.push(value), status() {} };
  const receiver = new LarkPoller(options);
  const advance = (ms: number) => { clock.mono += ms; clock.epoch += ms; };
  const history = (from = 0, chatId?: string) => calls.slice(from).filter(call => call.url.pathname === '/open-apis/im/v1/messages' && (!chatId || call.url.searchParams.get('container_id') === chatId));
  const rootPages = (from = 0, chatId?: string) => history(from, chatId).filter(call => call.url.searchParams.get('container_id_type') === 'chat' && call.url.searchParams.get('sort_type') === 'ByCreateTimeDesc');
  const ids = () => received.map(item => item.message.message_id);
  return { directory, state, clock, model, calls, waits, received, reports, api, options, receiver, advance, history, rootPages, ids, cleanups };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function realDelivery(f: Fixture, state: State, send: (content: string) => Promise<DeliveryResult>) {
  const external: ExternalResolver = { async resolve(id, adapter) {
    return { info: { session_id: id, adapter, host_id: hostname(), session_name: 'Fixture target', availability: 'active' }, send };
  }, close() {} };
  const sessions = new SessionsService(state, { async inspect() { return undefined; } }, record => f.reports.push(record), external);
  const service = new LarkService(state, sessions, { appId: APP, appSecret: 'fake-unused-secret' }, record => f.reports.push(record), f.api);
  f.cleanups.push(async () => { await service.stop(); await sessions.stop(); });
  return { service, sessions, receiver: new LarkPoller({ ...f.options, state, receive: payload => service.enqueue(payload) }) };
}
const chatKey = (chatId: string) => larkPollCursorKey({ app_id: APP, container_type: 'chat', container_id: chatId });
const topic = (chatId: string, threadId: string, rootId = `root-${threadId}`, appId = APP): LarkPollCursor => ({
  app_id: appId, chat_id: chatId, container_type: 'thread', container_id: threadId, root_message_id: rootId, started_at: START, through: START,
});

test('same-app bot messages from another computer are skipped in chats and topics across restart', async t => {
  const f = await fixture(t); const sent: string[] = [];
  const send = async (content: string) => { sent.push(content); return { status: 'input_accepted' as const }; };
  const delivery = realDelivery(f, f.state, send);
  // These messages exist only in provider history; this computer has never sent them.
  const sender = { sender_type: 'app', id_type: 'app_id', id: APP };
  const root = message('om_remote_bot_root', START + 1_000, 'oc_bound', { sender, thread_id: 'omt_shared_app' });
  const reply = message('om_remote_bot_reply', START + 2_000, 'oc_bound', { sender, thread_id: 'omt_shared_app', root_id: root.message_id });
  const chat = message('om_remote_bot_chat', START + 3_000, 'oc_bound', { sender });
  f.model.rows.set('chat:oc_bound', [root, chat]); f.model.rows.set('thread:omt_shared_app', [root, reply]);
  f.advance(5_000);
  assert.equal(await delivery.receiver.pollOnce(), true);
  assert.deepEqual(sent, []); assert.equal(f.state.deliveries.size, 0);
  assert.ok(!f.calls.some(call => /\/(announcement|reactions)$/.test(call.url.pathname)));

  const reopened = await State.open(f.directory);
  const threadKey = larkPollCursorKey(topic('oc_bound', 'omt_shared_app', root.message_id));
  for (const item of [root, chat]) assert.equal(reopened.hasLarkPollReceipt(chatKey('oc_bound'), item.message_id), true);
  for (const item of [root, reply]) assert.equal(reopened.hasLarkPollReceipt(threadKey, item.message_id), true);
  assert.equal(reopened.larkPollCursors.get(chatKey('oc_bound'))?.through, START + 3_000);
  assert.equal(reopened.larkPollCursors.get(threadKey)?.through, START + 3_000);

  const restarted = realDelivery(f, reopened, send);
  f.model.rows.get('chat:oc_bound')!.push(message('om_user_chat', START + 7_000));
  f.model.rows.get('thread:omt_shared_app')!.push(message('om_user_reply', START + 8_000, 'oc_bound', {
    thread_id: 'omt_shared_app', root_id: root.message_id,
  }), message('om_later_bot_reply', START + 9_000, 'oc_bound', { sender, thread_id: 'omt_shared_app', root_id: root.message_id }));
  f.advance(5_000);
  assert.equal(await restarted.receiver.pollOnce(), true);
  assert.equal(await restarted.receiver.pollOnce(), true);
  assert.equal(sent.length, 2);
  assert.match(sent[0], /om_user_chat/); assert.match(sent[1], /om_user_reply/);
  assert.deepEqual([...reopened.deliveries.keys()], ['om_user_chat', 'om_user_reply']);
  assert.deepEqual(f.calls.filter(call => call.url.pathname.endsWith('/reactions')).map(call => call.url.pathname), [
    '/open-apis/im/v1/messages/om_user_chat/reactions', '/open-apis/im/v1/messages/om_user_reply/reactions',
  ]);
});

test('a failing announcement head cannot starve later groups or later membership pages', async t => {
  const f = await fixture(t); f.model.chats = ['oc_bad', 'oc_good', 'oc_paged']; f.model.groupPageSize = 2;
  f.model.hook = url => { if (url.pathname === '/open-apis/im/v1/chats/oc_bad/announcement') throw new Error('Generic announcement read failure'); };
  for (const id of ['oc_good', 'oc_paged']) f.model.rows.set(`chat:${id}`, [message(`message-${id}`, START + 1_000, id)]);
  f.advance(5_000);
  assert.equal(await f.receiver.pollOnce(), true); assert.deepEqual(f.ids(), ['message-oc_good']);
  assert.equal(await f.receiver.pollOnce(), true); assert.deepEqual(f.ids(), ['message-oc_good', 'message-oc_paged']);
  assert.ok(f.calls.some(call => call.url.pathname === '/open-apis/im/v1/chats' && call.url.searchParams.get('page_token') === '2'));
  assert.ok(f.reports.some(report => report.chat_id === 'oc_bad' && report.status === 'lark_discovery_failed'));
  f.advance(61_000); await f.receiver.pollOnce();
  assert.equal(f.calls.filter(call => call.url.pathname === '/open-apis/im/v1/chats/oc_bad/announcement').length, 2, 'the failed group remains retryable on a later sweep');
});

test('membership removal requires a complete successful sweep; partial and failed pages retain monitored groups', async t => {
  const f = await fixture(t); f.model.chats = ['oc_old', 'oc_kept']; f.advance(5_000); await f.receiver.pollOnce();
  f.model.chats = ['oc_kept', 'oc_new']; f.model.groupPageSize = 1; f.advance(61_000);
  let from = f.calls.length; await f.receiver.pollOnce();
  assert.ok(f.history(from, 'oc_old').length, 'a partial member list must not remove an unseen monitored group');
  f.model.hook = url => { if (url.pathname === '/open-apis/im/v1/chats' && url.searchParams.has('page_token')) throw new Error('Transient listing failure'); };
  from = f.calls.length; await f.receiver.pollOnce(); assert.ok(f.history(from, 'oc_old').length);
  f.model.hook = undefined; f.advance(61_000); from = f.calls.length; await f.receiver.pollOnce();
  assert.equal(f.history(from, 'oc_old').length, 0, 'a successful complete sweep removes groups no longer listed');
  assert.ok(f.history(from, 'oc_kept').length); assert.ok(f.history(from, 'oc_new').length);
  assert.ok((await State.open(f.directory)).larkPollCursors.has(chatKey('oc_old')), 'membership pruning preserves durable history');
});

test('three generic continuation failures restart membership traversal without requiring a provider error code', async t => {
  const f = await fixture(t); f.model.chats = ['oc_first', 'oc_later']; f.model.groupPageSize = 1;
  f.model.hook = url => { if (url.pathname === '/open-apis/im/v1/chats' && url.searchParams.has('page_token')) throw new Error('Rejected opaque continuation'); };
  f.advance(5_000); await f.receiver.pollOnce();
  for (let attempt = 0; attempt < 3; attempt++) { f.advance(61_000); await f.receiver.pollOnce(); }
  f.advance(61_000); await f.receiver.pollOnce();
  const tokens = f.calls.filter(call => call.url.pathname === '/open-apis/im/v1/chats').map(call => call.url.searchParams.get('page_token'));
  assert.deepEqual(tokens, [null, '1', '1', '1', null]);
});

test('three generic root-index continuation failures restart its fixed-window traversal', async t => {
  const f = await fixture(t);
  f.model.roots.set('oc_bound', Array.from({ length: 60 }, (_, index) => message(`old-${index}`, START - 60_000 + index, 'oc_bound', { thread_id: `omt_old_${index}` })));
  f.model.hook = url => { if (url.searchParams.get('sort_type') === 'ByCreateTimeDesc' && url.searchParams.get('container_id_type') === 'chat' && url.searchParams.has('page_token')) throw new Error('Expired root continuation'); };
  f.advance(5_000); await f.receiver.pollOnce();
  for (let attempt = 0; attempt < 3; attempt++) { f.advance(61_000); await f.receiver.pollOnce(); }
  f.advance(61_000); await f.receiver.pollOnce();
  assert.deepEqual(f.rootPages().map(call => call.url.searchParams.get('page_token')), [null, '50', '50', '50', null]);
});

test('late explicit activation excludes pre-binding messages while startup-known groups retain their constructor baseline', async t => {
  const f = await fixture(t); f.model.rows.set('chat:oc_bound', [message('startup-gap', START + 1_000)]);
  f.advance(3_600_000); const activated = START + 3_600_000;
  f.state.bindings.set('oc_late', { chat_id: 'oc_late', session_id: 'fixture-session', sender_open_id: OWNER, adapter: 'codex', activated_at: activated });
  await f.state.save();
  f.model.rows.set('chat:oc_late', [message('much-too-early', START + 1_000, 'oc_late'), message('just-before-bind', activated - 1, 'oc_late'),
    message('at-bind', activated, 'oc_late'), message('after-bind', activated + 1, 'oc_late')]);
  f.advance(5_000); await f.receiver.pollOnce();
  assert.deepEqual(f.ids(), ['startup-gap', 'at-bind', 'after-bind']);
  assert.equal(f.state.larkPollCursors.get(chatKey('oc_bound'))!.started_at, START);
  assert.equal((await State.open(f.directory)).larkPollCursors.get(chatKey('oc_late'))!.started_at, activated);
});

test('bounded root metadata pages yield to a hot second group instead of draining all old roots', async t => {
  const f = await fixture(t, ['oc_slow', 'oc_hot']);
  f.model.roots.set('oc_slow', Array.from({ length: 125 }, (_, index) => message(`old-root-${index}`, START - 60_000 + index, 'oc_slow', { thread_id: `omt_${index}` })));
  f.model.rows.set('chat:oc_hot', [message('hot-first', START + 1_000, 'oc_hot')]); f.advance(5_000);
  let from = f.calls.length; await f.receiver.pollOnce();
  assert.deepEqual(f.ids(), ['hot-first']); assert.equal(f.rootPages(from, 'oc_slow').length, 1);
  assert.equal(f.history(from).filter(call => call.url.searchParams.get('container_id_type') === 'thread').length, 50);
  f.model.rows.get('chat:oc_hot')!.push(message('hot-second', START + f.clock.mono, 'oc_hot')); f.advance(1_000);
  from = f.calls.length; await f.receiver.pollOnce();
  assert.deepEqual(f.ids(), ['hot-first', 'hot-second']); assert.equal(f.rootPages(from, 'oc_slow').length, 1);
  assert.equal(f.rootPages(from, 'oc_slow')[0].url.searchParams.get('page_token'), '50');
});

function orderedChat(f: Fixture) {
  const root = message('A', START + 1_000, 'oc_bound', { thread_id: 'omt_ordered' });
  const reply = message('B', START + 2_000, 'oc_bound', { thread_id: 'omt_ordered', root_id: 'A' });
  f.model.rows.set('chat:oc_bound', [root, message('C', START + 3_000)]);
  f.model.rows.set('thread:omt_ordered', [root, reply]);
}
test('same-chat root and topic histories merge as A,B,C with explicit root filters and cross-container deduplication', async t => {
  const f = await fixture(t); orderedChat(f); f.advance(5_000); await f.receiver.pollOnce();
  assert.deepEqual(f.ids(), ['A', 'B', 'C']);
  const chatRequests = f.history().filter(call => call.url.searchParams.get('container_id_type') === 'chat');
  assert.ok(chatRequests.length >= 2); assert.ok(chatRequests.every(call => call.url.searchParams.get('only_thread_root_messages') === 'true'));
  const threadId = larkPollCursorKey(topic('oc_bound', 'omt_ordered', 'A'));
  assert.equal(f.state.hasLarkPollReceipt(chatKey('oc_bound'), 'A'), true); assert.equal(f.state.hasLarkPollReceipt(threadId, 'A'), true);
  const reopened = await State.open(f.directory); await new LarkPoller({ ...f.options, state: reopened }).pollOnce();
  assert.deepEqual(f.ids(), ['A', 'B', 'C']);
});

test('a failed root forms a barrier for its following topic reply and chat command while another chat progresses', async t => {
  const f = await fixture(t, ['oc_bound', 'oc_other']); orderedChat(f);
  f.model.rows.set('chat:oc_other', [message('other-chat', START + 1_000, 'oc_other')]);
  let rejectRoot = true;
  const receiver = new LarkPoller({ ...f.options, receive: payload => {
    if ((payload as { message: { message_id: string } }).message.message_id === 'A' && rejectRoot) return Promise.resolve(false);
    return f.options.receive(payload);
  } });
  f.advance(5_000); assert.equal(await receiver.pollOnce(), false); assert.deepEqual(f.ids(), ['other-chat']);
  assert.equal(f.state.larkPollCursors.get(chatKey('oc_bound'))!.through, START);
  assert.equal(f.state.larkPollReceipts(chatKey('oc_bound')).size, 0);
  rejectRoot = false; f.advance(6_000); assert.equal(await receiver.pollOnce(), true);
  assert.deepEqual(f.ids(), ['other-chat', 'A', 'B', 'C']);
});

test('request pacing follows monotonic elapsed time through forward and backward host-clock steps', async t => {
  const f = await fixture(t); f.model.rows.set('chat:oc_bound', [message('before-clock-step', START + 1_000)]);
  f.clock.epoch += 86_400_000; f.clock.mono += 5_000; await f.receiver.pollOnce();
  f.clock.epoch -= 3 * 86_400_000; f.clock.mono += 3_000; await f.receiver.pollOnce();
  assert.deepEqual(f.ids(), ['before-clock-step']);
  for (let index = 1; index < f.calls.length; index++) assert.ok(f.calls[index].mono - f.calls[index - 1].mono >= 200);
  assert.ok(f.waits.every(delay => delay > 0 && delay <= 200), 'wall-clock changes must not produce day-long pacing waits');
  for (const call of f.history()) if (call.url.searchParams.has('end_time')) {
    const end = Number(call.url.searchParams.get('end_time')) * 1_000;
    assert.ok(end >= START && end < START + 60_000, 'history bounds use the constructor epoch plus monotonic elapsed time');
  }
});

test('empty scans without a provider clock cannot poison the frontier with host time or hide late-indexed commands', async t => {
  const f = await fixture(t); f.advance(3_600_000); await f.receiver.pollOnce();
  assert.equal((await State.open(f.directory)).larkPollCursors.get(chatKey('oc_bound'))!.through, START);
  f.model.rows.set('chat:oc_bound', [message('late-indexed-provider-command', START + 1_000)]); f.advance(3_000); await f.receiver.pollOnce();
  assert.deepEqual(f.ids(), ['late-indexed-provider-command']);
  assert.equal(f.state.larkPollCursors.get(chatKey('oc_bound'))!.through, START + 1_000);
});

test('one per-pass thread index traverses the global cursor map once and ignores other application cursors', async t => {
  const groups = Array.from({ length: 16 }, (_, index) => `oc_${index}`); const f = await fixture(t, groups);
  const cursors = groups.flatMap(chatId => Array.from({ length: 3 }, (_, index) => topic(chatId, `omt_${chatId}_${index}`)));
  cursors.push(...groups.map(chatId => topic(chatId, `foreign_${chatId}`, undefined, 'cli_other')));
  await f.state.saveLarkPollProgress(cursors);
  const iterate = f.state.larkPollCursors[Symbol.iterator]; const values = f.state.larkPollCursors.values;
  let iterations = 0; let yielded = 0;
  function count<T>(iterator: MapIterator<T>): MapIterator<T> {
    iterations++; const next = iterator.next.bind(iterator);
    iterator.next = () => { const result = next(); if (!result.done) yielded++; return result; };
    return iterator;
  }
  t.mock.method(f.state.larkPollCursors, Symbol.iterator, function (this: typeof f.state.larkPollCursors) { return count(iterate.call(this)); });
  t.mock.method(f.state.larkPollCursors, 'values', function (this: typeof f.state.larkPollCursors) { return count(values.call(this)); });
  f.advance(5_000); await f.receiver.pollOnce();
  assert.equal(iterations, 1); assert.equal(yielded, cursors.length + groups.length);
  const threads = f.history().filter(call => call.url.searchParams.get('container_id_type') === 'thread');
  assert.equal(threads.length, groups.length * 3); assert.ok(threads.every(call => !call.url.searchParams.get('container_id')!.startsWith('foreign_')));
});

test('idle provider-clock progress batches all containers once and never serializes unrelated inbox payloads', async t => {
  const groups = Array.from({ length: 20 }, (_, index) => `oc_idle_${index}`); const f = await fixture(t, groups, true);
  const cursors: LarkPollCursor[] = groups.flatMap(chatId => [
    { app_id: APP, chat_id: chatId, container_type: 'chat', container_id: chatId, started_at: START, through: START }, topic(chatId, `omt_${chatId}`),
  ]);
  await f.state.saveLarkPollProgress(cursors);
  const payload = { id: 'unrelated', text: 'x'.repeat(200_000), created_at: '2026-11-06T00:00:00.000Z', session_id: 'fixture-inbox', adapter: 'trae' as const };
  f.state.inboxMessages.set(payload.id, payload); await f.state.save();
  Object.defineProperty(payload, 'toJSON', { value() { throw new Error('Idle polling serialized unrelated inbox data'); } });
  let commits = 0; let batches = 0; let changedCursors = 0;
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) { if (sql === 'COMMIT') commits++; return exec.call(this, sql); });
  const save = f.state.saveLarkPollProgress.bind(f.state);
  t.mock.method(f.state, 'saveLarkPollProgress', async (changed: readonly LarkPollCursor[], receipts = [], prune = []) => {
    batches++; changedCursors += changed.length; return save(changed, receipts, prune);
  });
  f.advance(5_000); assert.equal(await f.receiver.pollOnce(), true);
  assert.equal(batches, 1); assert.equal(changedCursors, cursors.length); assert.equal(commits, 1);
});

test('actual delivery treats a poison 413 as terminal and continues to the following valid command', async t => {
  const f = await fixture(t); const attempts: string[] = [];
  const delivery = realDelivery(f, f.state, async content => { const id = content.includes('poison-input') ? 'poison-input' : 'valid-input'; attempts.push(id);
    if (id === 'poison-input') throw new HttpError(413, 'Fixture input is too large'); return { status: 'input_accepted' }; });
  f.model.rows.set('chat:oc_bound', [message('poison-input', START + 1_000), message('valid-input', START + 2_000)]); f.advance(5_000);
  assert.equal(await delivery.receiver.pollOnce(), true); assert.deepEqual(attempts, ['poison-input', 'valid-input']);
  assert.equal(f.state.larkDelivery('poison-input')!.transport_status, 'ignored');
  assert.equal(f.state.hasLarkPollReceipt(chatKey('oc_bound'), 'poison-input'), true);
  await delivery.receiver.pollOnce(); assert.equal(attempts.length, 2);
});

test('actual proven pre-send failure retries safely before releasing following same-chat input', async t => {
  const f = await fixture(t); let fail = true; const attempts: string[] = [];
  const delivery = realDelivery(f, f.state, async content => {
    const id = content.includes('retry-input') ? 'retry-input' : 'following-input'; attempts.push(id);
    if (fail) throw new RetryableDeliveryError('Fixture has not submitted any input'); return { status: 'input_accepted' };
  });
  f.model.rows.set('chat:oc_bound', [message('retry-input', START + 1_000), message('following-input', START + 2_000)]); f.advance(5_000);
  assert.equal(await delivery.receiver.pollOnce(), false); assert.deepEqual(attempts, ['retry-input']);
  assert.equal(f.state.larkDelivery('retry-input')!.retryable, true);
  fail = false; f.advance(6_000); assert.equal(await delivery.receiver.pollOnce(), true);
  assert.deepEqual(attempts, ['retry-input', 'retry-input', 'following-input']);
});

test('actual ambiguous or acknowledged input is terminal for polling and remains suppressed after receipt pruning', async t => {
  const f = await fixture(t); let service!: LarkService; const attempts: string[] = [];
  const delivery = realDelivery(f, f.state, async content => {
    const id = content.includes('acked-input') ? 'acked-input' : content.includes('uncertain-input') ? 'uncertain-input' : 'following-input';
    attempts.push(id);
    if (id === 'acked-input') { await service.handle({ method: 'POST', path: '/v1/lark/messages/acked-input/ack', body: {} }); throw new UnconfirmedDeliveryError('Fixture response lost after ACK'); }
    if (id === 'uncertain-input') throw new UnconfirmedDeliveryError('Fixture submission response lost');
    return { status: 'input_accepted' };
  }); service = delivery.service;
  f.model.rows.set('chat:oc_bound', [message('acked-input', START + 1_000), message('uncertain-input', START + 2_000), message('following-input', START + 3_000)]); f.advance(5_000);
  assert.equal(await delivery.receiver.pollOnce(), true); assert.deepEqual(attempts, ['acked-input', 'uncertain-input', 'following-input']);
  assert.ok(f.state.larkDelivery('acked-input')!.acknowledged_at); assert.equal(f.state.larkDelivery('uncertain-input')!.transport_status, 'delivery_unconfirmed');
  await f.state.saveLarkPollProgress([], [], [{ cursor_id: chatKey('oc_bound'), before: START + 10_000 }]);
  const reopened = await State.open(f.directory); const restarted = realDelivery(f, reopened, async () => { throw new Error('Terminal input was submitted again'); });
  assert.equal(await restarted.receiver.pollOnce(), true);
  assert.equal(reopened.larkPollReceipts(chatKey('oc_bound')).size, 3);
});

test('abrupt restart during a >2000 topic backlog never replays accepted, last-batch or pending commands', { timeout: 120_000 }, async t => {
  const f = await fixture(t); const count = 2_107; const previouslyAccepted = 2_000;
  const acceptedBeforeCrash: number[] = []; const acceptedAfterRestart: number[] = [];
  const entered = gate(); const release = gate(); const abort = new AbortController();
  await f.receiver.pollOnce(); // Persist activation before the simulated offline backlog arrives.
  const root = message('om_old_root', START - 60_000, 'oc_bound', { thread_id: 'omt_backlog', sender: { sender_type: 'app', id_type: 'app_id', id: 'cli_fixture' } });
  const backlog = Array.from({ length: count }, (_, index) => message(`om_backlog_${String(index).padStart(5, '0')}`, START + index + 1, 'oc_bound', {
    thread_id: 'omt_backlog', root_id: root.message_id, body: { content: JSON.stringify({ text: `command-${String(index).padStart(5, '0')}` }) },
  }));
  // Seed only the already-accepted ledger, without poll receipts. Repeating 4,000 FULL-sync
  // delivery commits for setup exceeds the Windows deadline. The poller still stages and
  // checkpoints all 2,107 messages; real deliveries below exercise eviction and the crash boundary.
  for (const item of backlog.slice(0, previouslyAccepted)) f.state.deliveries.set(item.message_id, {
    message_id: item.message_id, chat_id: item.chat_id, sender_open_id: OWNER, thread_id: item.thread_id,
    session_id: 'fixture-session', session_name: 'Fixture target', adapter: 'codex', created_at: new Date(START).toISOString(),
    transport_status: 'input_accepted', replies: [],
  });
  await f.state.save();
  f.model.rows.set('chat:oc_bound', [root]); f.model.rows.set('thread:omt_backlog', [root, ...backlog]); f.advance(10_000);
  const old = realDelivery(f, f.state, async content => {
    const index = Number(/command-(\d{5})/.exec(content)?.[1]); assert.ok(Number.isInteger(index));
    if (index === 2_053) { entered.resolve(); await release.promise; throw new UnconfirmedDeliveryError('Fixture abrupt interruption after durable pending state'); }
    acceptedBeforeCrash.push(index); return { status: 'input_accepted' };
  });
  const running = old.receiver.pollOnce(abort.signal).then(value => ({ value }), error => ({ error }));
  f.cleanups.push(async () => { abort.abort(); release.resolve(); await running; });
  await Promise.race([entered.promise, running.then(result => { if ('error' in result) throw result.error; throw new Error('Old receiver finished before the abrupt snapshot'); })]);
  assert.deepEqual(acceptedBeforeCrash, Array.from({ length: 2_053 - previouslyAccepted }, (_, offset) => offset + previouslyAccepted),
    'the seeded accepted prefix must not be submitted again while the uncheckpointed tail uses real delivery');
  const snapshot = await State.open(f.directory); const threadId = larkPollCursorKey(topic('oc_bound', 'omt_backlog', root.message_id));
  assert.equal(snapshot.larkPollCursors.get(threadId)!.through, START + 2_050, 'only the last fully checkpointed provider-time prefix may advance before interruption');
  assert.equal(snapshot.larkPollReceipts(threadId).size, 2_050, 'completed IDs are checkpointed in bounded batches before interruption');
  assert.deepEqual([...snapshot.deliveries.keys()], backlog.slice(2_054 - previouslyAccepted, 2_054).map(item => item.message_id),
    'real pending/accepted saves evict the oldest seeded entries and retain exactly the latest 2000 commands');
  assert.equal(snapshot.deliveries.has(backlog[0].message_id), false, 'the oldest accepted command has already left the bounded ledger');
  assert.equal(snapshot.hasLarkPollReceipt(threadId, backlog[0].message_id), true);
  for (const index of [2_050, 2_051, 2_052]) {
    assert.equal(snapshot.hasLarkPollReceipt(threadId, backlog[index].message_id), false);
    assert.equal(snapshot.larkDelivery(backlog[index].message_id)!.transport_status, 'input_accepted', 'the last partial batch remains protected by the ledger');
  }
  assert.equal(snapshot.larkDelivery(backlog[2_053].message_id)!.transport_status, 'pending');
  const fresh = realDelivery(f, snapshot, async content => {
    const index = Number(/command-(\d{5})/.exec(content)?.[1]); acceptedAfterRestart.push(index); return { status: 'input_accepted' };
  });
  assert.equal(await fresh.receiver.pollOnce(), true);
  assert.deepEqual(acceptedAfterRestart, Array.from({ length: count - 2_054 }, (_, offset) => offset + 2_054));
  const allAccepted = [...Array.from({ length: previouslyAccepted }, (_, index) => index), ...acceptedBeforeCrash, ...acceptedAfterRestart];
  assert.equal(allAccepted.length, count - 1, 'every command except the interrupted pending submission was accepted once');
  assert.equal(new Set(allAccepted).size, allAccepted.length);
  assert.equal(snapshot.larkDelivery(backlog[2_053].message_id)!.transport_status, 'pending', 'unknown pending submission must not be replayed');
  const durable = await State.open(f.directory);
  assert.equal(durable.larkPollCursors.get(threadId)!.through, START + count);
  assert.equal(durable.larkPollReceipts(threadId).size, count);
  abort.abort(); release.resolve(); const stopped = await running; assert.ok('error' in stopped);
  await old.service.drain();
  assert.equal((await readdir(f.directory)).some(name => name.startsWith('.poll-history-')), false, 'both receivers release their ephemeral spools');
});
