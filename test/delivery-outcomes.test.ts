import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { CodexRpc } from '../src/codex-rpc.js';
import type { ExternalResolver } from '../src/external-sessions.js';
import { LarkService } from '../src/lark.js';
import type { LarkApi } from '../src/lark-metadata.js';
import { SessionsService, writeInbox } from '../src/sessions.js';
import { State } from '../src/state.js';
import { RetryableDeliveryError, SessionUnavailable, UnconfirmedDeliveryError, type Adapter, type LarkDelivery } from '../src/types.js';

const id = 'outcome-fixture';
const payload = (message_id = 'om_once', text = 'run this command once') => ({
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
  message: { chat_id: 'oc_fixture', message_id, message_type: 'text', content: JSON.stringify({ text }) },
});
async function fixture(t: TestContext, adapter: Adapter = 'codex', external?: ExternalResolver) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-outcomes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await State.open(directory);
  state.bindings.set('oc_fixture', { chat_id: 'oc_fixture', session_id: id, sender_open_id: 'ou_owner', adapter });
  state.sessions.set(id, { session_id: id, session_name: 'Outcome fixture', host_id: hostname(), adapter });
  await state.save();
  const sessions = new SessionsService(state, { inspect: async () => { throw new Error('Unexpected Claude lookup'); } }, () => {}, external);
  t.after(() => sessions.stop());
  const api: LarkApi = { appId: 'cli_fixture', async request<T>(): Promise<T> {
    return { revision: '1', content: `agent-session:v1:${hostname()}:${adapter}:${id}` } as T;
  } };
  const reports: Record<string, unknown>[] = [];
  const lark = new LarkService(state, sessions, undefined, record => reports.push(record), api);
  t.after(() => lark.stop());
  return { directory, state, sessions, lark, reports };
}
function context(message_id = 'om_once'): LarkDelivery {
  return { message_id, chat_id: 'oc_fixture', sender_open_id: 'ou_owner', session_id: id, session_name: 'Outcome fixture', adapter: 'codex',
    created_at: '2026-11-06T00:00:00.000Z', transport_status: 'delivery_failed', replies: [] };
}
function rpcFixture(t: TestContext) {
  const requests: { id: number; method: string; params: unknown }[] = [];
  const rpc = new CodexRpc({ url: 'ws://127.0.0.1:9' }, 5);
  const socket = { readyState: WebSocket.OPEN as number,
    send(frame: string, callback?: (error?: Error) => void) { requests.push(JSON.parse(frame)); callback?.(); },
    terminate() { this.readyState = WebSocket.CLOSED; },
  };
  Object.assign(rpc, { socket });
  t.after(() => rpc.close());
  return { rpc, requests, socket };
}

test('Codex turn requests accepted before a response timeout are unconfirmed and never automatically replayed', async t => {
  const rpc = rpcFixture(t); const f = await fixture(t);
  t.mock.method(f.sessions, 'send', async (_id: string, text: string) => {
    await rpc.rpc.call('turn/start', { threadId: id, input: [{ type: 'text', text }] });
    return { status: 'input_accepted' as const };
  });
  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(f.state.larkDelivery('om_once')!.transport_status, 'delivery_unconfirmed');
  assert.equal(f.state.larkDelivery('om_once')!.retryable, undefined);
  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(rpc.requests.filter(request => request.method === 'turn/start').length, 1);
  const reopened = await State.open(f.directory);
  const restarted = new LarkService(reopened, f.sessions, undefined, () => {}, f.lark.api);
  assert.equal(await restarted.enqueue(payload()), true);
  assert.equal(rpc.requests.length, 1);
  assert.ok(f.reports.some(record => record.status === 'delivery_unconfirmed'));
});

test('read-only RPC response timeouts are retryable while disconnected unsent turn requests stay safe to retry', async t => {
  const f = rpcFixture(t);
  await assert.rejects(f.rpc.call('thread/read', { threadId: id }), RetryableDeliveryError);
  f.socket.readyState = WebSocket.CLOSED;
  await assert.rejects(f.rpc.call('turn/start', { threadId: id }), RetryableDeliveryError);
  assert.equal(f.requests.length, 1, 'an unsent mutation must not enter the socket');
});

test('a native inbox that receives the full frame without EOF produces one unconfirmed submission', async t => {
  const f = await fixture(t); const path = join(f.directory, 'inbox.sock');
  const sockets = new Set<Socket>(); const frames: { type: string; message?: { content: string } }[] = [];
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let data = '';
    socket.setEncoding('utf8'); socket.on('data', chunk => {
      data += chunk;
      for (;;) { const end = data.indexOf('\n'); if (end < 0) break; frames.push(JSON.parse(data.slice(0, end))); data = data.slice(end + 1); }
    });
  });
  server.listen(path); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  t.mock.method(f.sessions, 'send', async (_id: string, text: string) => writeInbox(path, text, undefined, 20));
  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(frames.filter(frame => frame.type === 'user').length, 1);
  assert.match(frames.find(frame => frame.type === 'user')!.message!.content, /run this command once/);
  assert.equal(f.state.larkDelivery('om_once')!.transport_status, 'delivery_unconfirmed');
});

test('positively identified pre-input failures retry without losing the original context', async t => {
  const f = await fixture(t); let calls = 0;
  t.mock.method(f.sessions, 'send', async () => {
    if (++calls === 1) throw new RetryableDeliveryError('connection refused before submission');
    return { status: 'input_accepted' as const };
  });
  assert.equal(await f.lark.enqueue(payload()), false);
  const first = f.state.larkDelivery('om_once')!;
  assert.equal(first.transport_status, 'delivery_failed'); assert.equal(first.retryable, true);
  const created = first.created_at;
  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(calls, 2);
  assert.equal(f.state.larkDelivery('om_once')!.created_at, created);
  assert.equal(f.state.larkDelivery('om_once')!.transport_status, 'input_accepted');
  assert.equal(f.state.larkDelivery('om_once')!.retryable, undefined);
});

test('legacy failed deliveries without a safe-retry marker remain deduplicated', async t => {
  const f = await fixture(t); f.state.deliveries.set('om_once', context()); await f.state.save();
  const send = t.mock.method(f.sessions, 'send', async () => ({ status: 'input_accepted' as const }));
  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(send.mock.calls.length, 0);
  assert.equal(f.state.larkDelivery('om_once')!.transport_status, 'delivery_failed');
});

test('an application acknowledgment/reply is retained and suppresses a later failed-transport retry', async t => {
  const f = await fixture(t); let sends = 0;
  t.mock.method(f.sessions, 'send', async () => {
    sends++;
    const delivery = f.state.larkDelivery('om_once')!;
    delivery.acknowledged_at = '2026-11-06T00:00:01.000Z';
    delivery.replies.push({ digest: 'kept-digest', message_id: 'om_kept_reply', time: delivery.acknowledged_at });
    await f.state.save();
    throw new UnconfirmedDeliveryError('input was read, but the transport response was lost');
  });
  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(sends, 1);
  const saved = (await State.open(f.directory)).larkDelivery('om_once')!;
  assert.equal(saved.acknowledged_at, '2026-11-06T00:00:01.000Z');
  assert.equal(saved.replies[0].message_id, 'om_kept_reply');
  assert.ok(!f.reports.some(record => record.status === 'delivery_failed'));
});

test('an acknowledged record is terminal even when its stored transport status says safe-to-retry failure', async t => {
  const f = await fixture(t);
  f.state.deliveries.set('om_once', { ...context(), retryable: true, acknowledged_at: '2026-11-06T00:00:01.000Z' });
  const send = t.mock.method(f.sessions, 'send', async () => ({ status: 'input_accepted' as const }));
  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(send.mock.calls.length, 0);
});

test('configured-backend connection failure before resolution retries after recovery', async t => {
  let ready = false; let submissions = 0; let resolutions = 0;
  const external: ExternalResolver = { close() {}, async resolve() {
    resolutions++;
    if (!ready) throw new SessionUnavailable('backend_unavailable');
    return { info: { session_id: id, session_name: 'Existing unarchived thread', adapter: 'codex', host_id: hostname(), availability: 'active' },
      async send() { submissions++; return { status: 'input_accepted' }; } };
  } };
  const f = await fixture(t, 'codex', external);
  f.state.backends.set('codex', { url: 'ws://127.0.0.1:9' }); await f.state.save();
  assert.equal(await f.lark.enqueue(payload()), false);
  assert.equal(f.state.larkDelivery('om_once')!.retryable, true); assert.equal(submissions, 0);
  ready = true;
  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(resolutions, 2); assert.equal(submissions, 1);
});

for (const reason of ['backend_unavailable', 'session_offline', 'session_archived', 'session_not_local']) {
  test(`intentional routing ignore remains terminal: ${reason}`, async t => {
    let submissions = 0;
    const external: ExternalResolver = { close() {}, async resolve() {
      if (reason === 'session_not_local') return;
      return { info: { session_id: id, session_name: 'Blocked target', adapter: 'codex', host_id: hostname(), availability: reason === 'session_archived' ? 'archived' : reason === 'session_offline' ? 'offline' : 'unknown' },
        async send() { submissions++; throw new SessionUnavailable(reason); } };
    } };
    const f = await fixture(t, 'codex', external);
    assert.equal(await f.lark.enqueue(payload()), true);
    assert.equal(await f.lark.enqueue(payload()), true);
    assert.equal(f.state.larkDelivery('om_once')!.transport_status, 'ignored');
    assert.ok(submissions <= 1);
    assert.ok(f.reports.some(record => record.reason === reason));
  });
}

test('permanently oversized polled input is skipped while the next valid message reaches its inbox', async t => {
  const f = await fixture(t, 'trae');
  assert.equal(await f.lark.enqueue(payload('om_large', 'x'.repeat(65_000))), true);
  assert.equal(f.state.larkDelivery('om_large')!.transport_status, 'ignored');
  assert.equal(f.state.larkDelivery('om_large')!.retryable, undefined);
  assert.equal(await f.lark.enqueue(payload('om_small', 'the next valid input')), true);
  assert.equal(f.state.inboxMessages.size, 1);
  assert.equal([...f.state.inboxMessages.values()][0].text, 'the next valid input');
  assert.ok(f.reports.some(record => record.message_id === 'om_large' && record.reason === 'input_rejected'));
});

test('temporary inbox-full backpressure remains retryable after space is released', async t => {
  const f = await fixture(t, 'workbuddy');
  for (let n = 0; n < 100; n++) f.state.inboxMessages.set(`old_${n}`, { id: `old_${n}`, text: 'pending input', created_at: '2026-11-06T00:00:00.000Z', session_id: id, adapter: 'workbuddy' });
  await f.state.save();
  assert.equal(await f.lark.enqueue(payload()), false);
  assert.equal(f.state.larkDelivery('om_once')!.retryable, true);
  f.state.inboxMessages.delete('old_0'); await f.state.save();
  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(f.state.larkDelivery('om_once')!.transport_status, 'inbox_queued');
  assert.equal([...f.state.inboxMessages.values()].filter(message => message.text === 'run this command once').length, 1);
});
