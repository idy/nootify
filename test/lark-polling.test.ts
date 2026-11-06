import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { LarkPoller, type LarkPollingOptions } from '../src/lark-polling.js';
import { LarkService } from '../src/lark.js';
import { ApiError, type LarkApi } from '../src/lark-metadata.js';
import { SessionsService } from '../src/sessions.js';
import { State } from '../src/state.js';
import { RetryableDeliveryError } from '../src/types.js';

const START = 1_700_000_000_000;
function message(id: string, time: number, chat_id = 'oc_test') {
  return { message_id: id, chat_id, create_time: String(time), msg_type: 'text', deleted: false,
    sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_owner' }, body: { content: JSON.stringify({ text: id }) }, thread_id: undefined as string | undefined };
}
type Message = ReturnType<typeof message>;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-lark-poll-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await State.open(directory);
  state.bindings.set('oc_test', { chat_id: 'oc_test', session_id: 'thread-test', sender_open_id: 'ou_owner', adapter: 'codex' });
  await state.save();
  const model = { now: START, rows: new Map<string, Message[]>(), chats: [] as { chat_id: string }[],
    announcements: new Map<string, string>(), fail: undefined as ((query: URLSearchParams) => void) | undefined };
  const received: unknown[] = []; const reports: Record<string, unknown>[] = []; const paths: string[] = [];
  const api: LarkApi = { appId: 'cli_test', async request<T>(_method: string, path: string): Promise<T> {
    paths.push(path);
    const url = new URL(path, 'https://open.feishu.cn'); const query = url.searchParams;
    if (url.pathname === '/open-apis/bot/v3/info') return {} as T;
    if (url.pathname === '/open-apis/im/v1/chats') return { items: model.chats } as T;
    if (url.pathname.endsWith('/announcement')) {
      const chatId = url.pathname.split('/').at(-2)!;
      return { revision: '1', content: model.announcements.get(chatId) ?? `agent-session:v1:${hostname()}:codex:thread-test` } as T;
    }
    assert.equal(url.pathname, '/open-apis/im/v1/messages');
    model.fail?.(query);
    const type = query.get('container_id_type');
    let rows = [...(model.rows.get(`${type}:${query.get('container_id')}`) ?? [])];
    if (query.has('start_time')) rows = rows.filter(item => Number(item.create_time) >= Number(query.get('start_time')) * 1000);
    if (query.has('end_time')) rows = rows.filter(item => Number(item.create_time) <= Number(query.get('end_time')) * 1000);
    rows.sort((a, b) => Number(a.create_time) - Number(b.create_time));
    if (query.get('sort_type') === 'ByCreateTimeDesc') rows.reverse();
    const offset = Number(query.get('page_token') ?? 0);
    return { items: rows.slice(offset, offset + 50), has_more: rows.length > offset + 50,
      ...(rows.length > offset + 50 ? { page_token: String(offset + 50) } : {}) } as T;
  } };
  const options: LarkPollingOptions = { state, api, now: () => model.now, monotonic: () => model.now, wait: async () => {},
    receive: async payload => { received.push(payload); return true; }, status: () => {}, report: record => reports.push(record) };
  const poller = new LarkPoller(options);
  const ids = () => received.map(item => (item as { message: { message_id: string } }).message.message_id);
  return { state, directory, api, options, poller, model, received, reports, paths, ids };
}

test('history polling starts now, normalizes user text, and ignores bot, deleted and non-text messages', async t => {
  const f = await fixture(t);
  const bot = message('om_bot', START + 2); bot.sender.sender_type = 'app';
  const deleted = message('om_deleted', START + 3); deleted.deleted = true;
  const image = message('om_image', START + 4); image.msg_type = 'image';
  f.model.rows.set('chat:oc_test', [message('om_old', START - 1), message('om_new', START + 1), bot, deleted, image]);
  f.model.now += 5_000;
  assert.equal(await f.poller.pollOnce(), true);
  assert.deepEqual(f.ids(), ['om_new']);
  assert.deepEqual(f.received[0], { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: { chat_id: 'oc_test', message_id: 'om_new', message_type: 'text', content: '{"text":"om_new"}', thread_id: undefined } });
  const saved = await State.open(f.directory);
  assert.equal(saved.larkPollCursors.get('cli_test:chat:oc_test')?.started_at, START);
  assert.equal(saved.larkPollCursors.get('cli_test:chat:oc_test')?.through, START + 4, 'without a provider clock only observed provider timestamps advance progress');
});

test('overlapping windows deduplicate IDs and collect late-indexed and equal-timestamp messages', async t => {
  const f = await fixture(t);
  const rows = [message('om_first', START + 1_500)]; f.model.rows.set('chat:oc_test', rows);
  f.model.now += 5_000; await f.poller.pollOnce();
  rows.push(message('om_same_time', START + 1_500), message('om_late_index', START + 4_500));
  f.model.now += 3_000; await f.poller.pollOnce(); await f.poller.pollOnce();
  assert.deepEqual(f.ids(), ['om_first', 'om_same_time', 'om_late_index']);
  const query = new URL(f.paths.filter(path => path.startsWith('/open-apis/im/v1/messages?')).at(-1)!, 'https://open.feishu.cn').searchParams;
  assert.equal(query.get('start_time'), String(START / 1000 - 1));
  assert.equal(query.get('end_time'), String((START + 8_000) / 1000 + 1));
});

test('a restart resumes the saved cursor and catches the whole offline interval', async t => {
  const f = await fixture(t);
  const rows = [message('om_first', START + 1_000)]; f.model.rows.set('chat:oc_test', rows);
  f.model.now += 5_000; await f.poller.pollOnce();
  f.model.now += 120_000;
  rows.push(message('om_offline', START + 60_000), message('om_recent', START + 120_000));
  const reopened = await State.open(f.directory);
  const restarted = new LarkPoller({ ...f.options, state: reopened });
  await restarted.pollOnce();
  assert.deepEqual(f.ids(), ['om_first', 'om_offline', 'om_recent']);
});

test('pagination keeps a fixed window and waits for complete history before ordered dispatch', async t => {
  const f = await fixture(t);
  f.model.rows.set('chat:oc_test', Array.from({ length: 75 }, (_, i) => message(`om_${i}`, START + i + 1)));
  f.model.fail = query => { if (query.get('page_token')) throw new Error('temporary page failure'); };
  f.model.now += 1_000;
  assert.equal(await f.poller.pollOnce(), false);
  assert.equal(f.received.length, 0, 'a partial snapshot cannot be ordered against the remaining roots and topics');
  const cursor = f.state.larkPollCursors.get('cli_test:chat:oc_test')!;
  assert.equal(cursor.through, START);
  assert.equal(f.state.larkPollReceipts('cli_test:chat:oc_test').size, 0);
  f.model.fail = undefined;
  const restarted = new LarkPoller({ ...f.options, state: await State.open(f.directory) });
  assert.equal(await restarted.pollOnce(), true);
  assert.equal(f.received.length, 75);
  assert.equal(new Set(f.ids()).size, 75);
});

test('an initial history failure persists its baseline, so restarting does not skip new messages', async t => {
  const f = await fixture(t);
  f.model.fail = () => { throw new ApiError(99991672, 'history permission required'); };
  f.model.now += 5_000;
  assert.equal(await f.poller.pollOnce(), false);
  assert.equal((await State.open(f.directory)).larkPollCursors.get('cli_test:chat:oc_test')?.through, START);
  f.model.now += 120_000; f.model.fail = undefined;
  f.model.rows.set('chat:oc_test', [message('om_during_failure', START + 3_000)]);
  await new LarkPoller({ ...f.options, state: await State.open(f.directory) }).pollOnce();
  assert.deepEqual(f.ids(), ['om_during_failure']);
});

test('delivery backpressure preserves progress and does not block another group', async t => {
  const f = await fixture(t);
  f.state.bindings.set('oc_other', { chat_id: 'oc_other', session_id: 'other', sender_open_id: 'ou_owner' });
  f.model.rows.set('chat:oc_test', [message('om_retry', START + 1)]);
  f.model.rows.set('chat:oc_other', [message('om_other', START + 2, 'oc_other')]);
  let blocked = true;
  const poller = new LarkPoller({ ...f.options, receive: async payload => {
    if ((payload as { message: { message_id: string } }).message.message_id === 'om_retry' && blocked) return false;
    return f.options.receive(payload);
  } });
  f.model.now += 5_000;
  assert.equal(await poller.pollOnce(), false);
  assert.deepEqual(f.ids(), ['om_other']);
  assert.equal(f.state.larkPollCursors.get('cli_test:chat:oc_test')?.through, START);
  blocked = false; f.model.now += 6_000;
  assert.equal(await poller.pollOnce(), true);
  assert.deepEqual(f.ids(), ['om_other', 'om_retry']);
});

test('two independent installations can read the same app history without consuming each other\'s messages', async t => {
  const first = await fixture(t); const second = await fixture(t);
  for (const f of [first, second]) { f.model.rows.set('chat:oc_test', [message('om_shared', START + 1)]); f.model.now += 5_000; }
  await first.poller.pollOnce(); await second.poller.pollOnce();
  assert.deepEqual(first.ids(), ['om_shared']); assert.deepEqual(second.ids(), ['om_shared']);
  await first.poller.pollOnce(); await second.poller.pollOnce();
  assert.deepEqual(first.ids(), ['om_shared']); assert.deepEqual(second.ids(), ['om_shared']);
});

test('application IDs have independent history cursors even for the same group ID', async t => {
  const f = await fixture(t);
  f.model.rows.set('chat:oc_test', [message('om_one', START + 1)]); f.model.now += 5_000;
  await f.poller.pollOnce();
  const other = new LarkPoller({ ...f.options, api: { ...f.api, appId: 'cli_other' } });
  f.model.rows.get('chat:oc_test')!.push(message('om_two', START + 5_001)); f.model.now += 1_000;
  await other.pollOnce();
  assert.equal(f.state.larkPollCursors.get('cli_test:chat:oc_test')?.through, START + 1);
  assert.equal(f.state.larkPollCursors.get('cli_other:chat:oc_test')?.started_at, START + 5_000);
  assert.deepEqual(f.ids(), ['om_one', 'om_two']);
});

test('announcement-only groups on this host are discovered without binding or polling another host', async t => {
  const f = await fixture(t);
  f.model.chats = [{ chat_id: 'oc_discovered' }, { chat_id: 'oc_remote' }];
  f.model.announcements.set('oc_remote', 'agent-session:v1:another-host:codex:remote-thread');
  f.model.rows.set('chat:oc_discovered', [message('om_discovered', START + 1, 'oc_discovered')]);
  f.model.rows.set('chat:oc_remote', [message('om_remote', START + 1, 'oc_remote')]);
  f.model.now += 5_000; await f.poller.pollOnce();
  assert.deepEqual(f.ids(), ['om_discovered']);
  assert.equal(f.state.bindings.has('oc_discovered'), false);
  assert.ok(!f.paths.some(path => path.includes('container_id=oc_remote')));
});

test('old topic roots are indexed, thread replies are read chronologically without unsupported time filters', async t => {
  const f = await fixture(t);
  const root = message('om_root', START - 60_000); root.sender.sender_type = 'app'; root.thread_id = 'omt_topic';
  const replies = [root, message('om_reply1', START + 1), message('om_reply2', START + 2)];
  for (const item of replies) item.thread_id = 'omt_topic';
  f.model.rows.set('chat:oc_test', [root]); f.model.rows.set('thread:omt_topic', replies);
  f.model.now += 5_000; await f.poller.pollOnce(); await f.poller.pollOnce();
  assert.deepEqual(f.ids(), ['om_reply1', 'om_reply2']);
  const threadQueries = f.paths.filter(path => path.includes('container_id_type=thread')).map(path => new URL(path, 'https://open.feishu.cn').searchParams);
  assert.ok(threadQueries.length >= 2);
  assert.ok(threadQueries.every(query => !query.has('start_time') && !query.has('end_time')));
  assert.equal((f.received[0] as { message: { thread_id: string } }).message.thread_id, 'omt_topic');
});

test('a topic root is delivered through the chat once and never replayed by the thread history', async t => {
  const f = await fixture(t);
  const root = message('om_root', START + 1); root.thread_id = 'omt_topic';
  const reply = message('om_reply', START + 2); reply.thread_id = 'omt_topic';
  f.model.rows.set('chat:oc_test', [root]); f.model.rows.set('thread:omt_topic', [root, reply]);
  f.model.now += 5_000;
  await f.poller.pollOnce();
  assert.deepEqual(f.ids(), ['om_root', 'om_reply']);
  const reopened = await State.open(f.directory);
  assert.equal(reopened.larkPollCursors.get('cli_test:thread:omt_topic')?.root_message_id, 'om_root');
  await new LarkPoller({ ...f.options, state: reopened }).pollOnce();
  assert.deepEqual(f.ids(), ['om_root', 'om_reply']);
});

test('a new topic on an old message is found by the periodic root refresh', async t => {
  const f = await fixture(t);
  const root = message('om_root', START - 60_000); root.sender.sender_type = 'app';
  f.model.rows.set('chat:oc_test', [root]); f.model.now += 5_000; await f.poller.pollOnce();
  root.thread_id = 'omt_new';
  f.model.rows.set('thread:omt_new', [message('om_reply', START + 6_000)]);
  f.model.now += 61_000; await f.poller.pollOnce();
  assert.deepEqual(f.ids(), ['om_reply']);
});

test('failed cursor persistence rolls back in-memory progress', async t => {
  const f = await fixture(t);
  f.model.now += 1_000; await f.poller.pollOnce();
  const previous = f.state.larkPollCursors.get('cli_test:chat:oc_test');
  f.model.rows.set('chat:oc_test', [message('om_new', START + 1_001)]); f.model.now += 3_000;
  const db = new DatabaseSync(join(f.directory, 'state.sqlite'));
  try { db.exec("CREATE TRIGGER fail_cursor BEFORE UPDATE ON lark_poll_cursors BEGIN SELECT RAISE(ABORT, 'injected atomic write failure'); END"); }
  finally { db.close(); }
  assert.equal(await f.poller.pollOnce(), false);
  assert.equal(f.state.larkPollCursors.get('cli_test:chat:oc_test'), previous);
  assert.equal((await State.open(f.directory)).larkPollCursors.get('cli_test:chat:oc_test')?.through, START);
});

test('stopping during an HTTP request rejects late results and does not advance the cursor', async t => {
  const f = await fixture(t);
  const requested = gate(); const release = gate(); const statuses: string[] = [];
  const api: LarkApi = { ...f.api, async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string): Promise<T> {
    if (path.startsWith('/open-apis/im/v1/messages?')) { requested.resolve(); await release.promise; }
    return f.api.request<T>(method, path);
  } };
  f.model.rows.set('chat:oc_test', [message('om_late', START + 1)]);
  const poller = new LarkPoller({ ...f.options, api, status: status => statuses.push(status) });
  f.model.now += 5_000;
  await poller.start(); await requested.promise;
  await poller.stop();
  assert.deepEqual(f.ids(), []); assert.deepEqual(statuses, []);
  assert.equal(f.state.larkPollCursors.get('cli_test:chat:oc_test')?.through, START);
  release.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.ids(), []); assert.deepEqual(statuses, []);
});

test('authentication failure still saves known groups\' baselines before a restart', async t => {
  const f = await fixture(t);
  const api: LarkApi = { ...f.api, async request<T>(): Promise<T> { throw new ApiError(99991663, 'temporarily unavailable'); } };
  const poller = new LarkPoller({ ...f.options, api });
  f.model.now += 5_000;
  await assert.rejects(poller.pollOnce(), /temporarily unavailable/);
  const reopened = await State.open(f.directory);
  assert.equal(reopened.larkPollCursors.get('cli_test:chat:oc_test')?.through, START);
  f.model.now += 120_000; f.model.rows.set('chat:oc_test', [message('om_during_auth_failure', START + 1_000)]);
  await new LarkPoller({ ...f.options, state: reopened }).pollOnce();
  assert.deepEqual(f.ids(), ['om_during_auth_failure']);
});

test('optional group discovery permission failure does not prevent polling bound groups', async t => {
  const f = await fixture(t);
  const api: LarkApi = { ...f.api, async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string): Promise<T> {
    if (path.startsWith('/open-apis/im/v1/chats?')) throw new ApiError(99991672, 'group list permission required');
    return f.api.request<T>(method, path);
  } };
  const poller = new LarkPoller({ ...f.options, api });
  f.model.now += 5_000; f.model.rows.set('chat:oc_test', [message('om_bound', START + 1)]);
  assert.equal(await poller.pollOnce(), true);
  assert.deepEqual(f.ids(), ['om_bound']);
  assert.ok(f.reports.some(report => report.status === 'lark_discovery_failed'));
});

test('the receiver retries a failed request with backoff and returns to its normal polling interval', async t => {
  const f = await fixture(t);
  const failedWait = gate(); const resume = gate(); const recovered = gate();
  let attempts = 0; const delays: number[] = []; const statuses: string[] = [];
  const api: LarkApi = { ...f.api, async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string): Promise<T> {
    if (++attempts === 1) throw new Error('temporary network failure');
    return f.api.request<T>(method, path);
  } };
  const poller = new LarkPoller({ ...f.options, api,
    status: status => { statuses.push(status); if (status === 'ready') recovered.resolve(); },
    wait: async (ms, signal) => {
      if (ms < 3_000) return;
      delays.push(ms);
      if (delays.length === 1) { failedWait.resolve(); await resume.promise; signal.throwIfAborted(); return; }
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  t.after(async () => { resume.resolve(); await poller.stop(); });
  await poller.start(); await failedWait.promise;
  assert.deepEqual(statuses, ['failed']); assert.equal(delays[0], 6_000);
  resume.resolve(); await recovered.promise;
  assert.deepEqual(statuses, ['failed', 'ready']);
  assert.equal(delays[1], 3_000);
  await poller.stop();
});

test('transient routing and transport failures retry, while successfully delivered IDs stay deduplicated', async t => {
  const f = await fixture(t);
  const sessions = new SessionsService(f.state); t.after(() => sessions.stop());
  let failRoute = true; let failSend = true; let sends = 0;
  const api: LarkApi = { ...f.api, async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string): Promise<T> {
    if (path.endsWith('/announcement') && failRoute) throw new Error('temporary announcement failure');
    return f.api.request<T>(method, path);
  } };
  t.mock.method(sessions, 'send', async () => { sends++; if (failSend) throw new RetryableDeliveryError('temporary failure before any input was submitted'); return { status: 'input_accepted' as const }; });
  let options!: LarkPollingOptions;
  const lark = new LarkService(f.state, sessions, { appId: api.appId, appSecret: 'test' }, record => f.reports.push(record), api, 9417,
    value => { options = value; return { async start() {}, async stop() {} }; });
  await lark.start(); t.after(() => lark.stop());
  const payload = { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: { chat_id: 'oc_test', message_id: 'om_retry', message_type: 'text', content: '{"text":"retry me"}' } };
  assert.equal(await options.receive(payload), false);
  assert.equal(f.state.deliveries.size, 0);
  failRoute = false;
  assert.equal(await options.receive(payload), false);
  assert.equal(f.state.deliveries.get('om_retry')?.transport_status, 'delivery_failed');
  failSend = false;
  assert.equal(await options.receive(payload), true);
  assert.equal(f.state.deliveries.get('om_retry')?.transport_status, 'input_accepted');
  assert.equal(await options.receive(payload), true);
  assert.equal(sends, 2);
});
