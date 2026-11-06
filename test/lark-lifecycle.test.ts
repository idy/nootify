import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { LarkService, type LarkSocketFactory } from '../src/lark.js';
import type { Credentials, LarkApi } from '../src/lark-metadata.js';
import { SessionsService } from '../src/sessions.js';
import { State } from '../src/state.js';

type Socket = ReturnType<LarkSocketFactory>;
type SocketOptions = Parameters<LarkSocketFactory>[0];
const firstBot: Credentials = { appId: 'cli_0123456789abcdef', appSecret: 'first-secret' };
const secondBot: Credentials = { appId: 'cli_fedcba9876543210', appSecret: 'second-secret' };
function gate() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
/** Delayed starts and late SDK callbacks, without creating a real Feishu connection. */
class FakeSocket implements Socket {
  readonly opening = gate();
  closed = 0;
  dispatcher?: Parameters<Socket['start']>[0]['eventDispatcher'];
  onClose?: () => void;
  constructor(readonly options: SocketOptions) {}
  start({ eventDispatcher }: Parameters<Socket['start']>[0]): Promise<void> {
    this.dispatcher = eventDispatcher;
    return this.opening.promise;
  }
  close(): void { this.closed++; this.onClose?.(); }
  ready(): void { this.options.onReady?.(); this.opening.resolve(); }
  async message(payload: unknown): Promise<void> { await this.dispatcher?.handles.get('im.message.receive_v1')?.(payload); }
  lateCallbacks(): void {
    this.options.onError?.(new Error('late error from a closed connection'));
    this.options.onReady?.(); this.options.onReconnecting?.(); this.options.onReconnected?.();
  }
}
async function fixture(t: TestContext, api?: LarkApi) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-lark-lifecycle-'));
  const state = await State.open(directory);
  const sessions = new SessionsService(state);
  const sockets: FakeSocket[] = []; const reports: Record<string, unknown>[] = [];
  const lark = new LarkService(state, sessions, firstBot, record => reports.push(record), api, 9417, options => {
    const socket = new FakeSocket(options); sockets.push(socket); return socket;
  });
  t.after(async () => { for (const socket of sockets) socket.opening.resolve(); await lark.stop(); await sessions.stop(); await rm(directory, { recursive: true, force: true }); });
  return { lark, state, sessions, sockets, reports };
}

test('missing Feishu credentials never start a socket or report ready', async t => {
  const { lark, sockets, reports } = await fixture(t);
  for (const credentials of [{ ...firstBot, appSecret: '' }, { ...firstBot, appSecret: '   ' }, { ...firstBot, appId: '' }]) {
    await lark.configure(credentials);
    assert.equal(lark.status(), 'failed');
    assert.equal(sockets.length, 0);
  }
  assert.ok(reports.every(record => record.status === 'lark_failed'));
  await lark.configure(undefined);
  await lark.start();
  assert.equal(lark.status(), 'disabled');
  assert.equal(sockets.length, 0);
});

test('Feishu stays connecting until the SDK confirms the handshake', async t => {
  const { lark, sockets, reports } = await fixture(t);
  const starting = lark.start(); await nextTurn();
  assert.equal(lark.status(), 'connecting');
  assert.equal(reports.length, 0);
  sockets[0].ready(); await starting;
  assert.equal(lark.status(), 'ready');
});

test('a retired Feishu client cannot change the current connection or dispatch messages', async t => {
  const { lark, sockets, reports } = await fixture(t);
  const enqueue = t.mock.method(lark, 'enqueue', () => true);
  const starting = lark.start(); await nextTurn(); sockets[0].ready(); await starting;
  // Even a synchronous callback from close must already belong to a retired connection.
  sockets[0].onClose = () => sockets[0].lateCallbacks();
  const configuring = lark.configure(secondBot); await nextTurn(); sockets[1].ready(); await configuring;
  assert.equal(sockets[0].closed, 1);
  assert.equal(lark.status(), 'ready');
  const count = reports.length;
  sockets[0].options.onError?.(new Error('old handshake failed'));
  assert.equal(lark.status(), 'ready');
  sockets[1].options.onReconnecting?.();
  sockets[0].options.onReady?.(); sockets[0].options.onReconnected?.();
  assert.equal(lark.status(), 'reconnecting');
  sockets[1].options.onReconnected?.();
  sockets[0].options.onReconnecting?.();
  assert.equal(lark.status(), 'ready');
  assert.equal(reports.length, count, 'stale callbacks must not produce log events either');
  await sockets[0].message({ old: true }); await sockets[1].message({ current: true });
  assert.equal(enqueue.mock.calls.length, 1);
  assert.deepEqual(enqueue.mock.calls[0].arguments, [{ current: true }]);
});

test('an initial start rejection stays local and a concurrent configuration waits its turn', async t => {
  const { lark, sockets, reports } = await fixture(t);
  const starting = assert.doesNotReject(lark.start()); await nextTurn();
  const configuring = lark.configure(secondBot); await nextTurn();
  assert.equal(sockets.length, 1, 'a configuration cannot overlap the initial SDK start');
  sockets[0].opening.reject(new Error('initial start rejected'));
  await starting; await nextTurn();
  assert.equal(sockets[0].closed, 1);
  assert.equal(sockets.length, 2);
  sockets[1].ready(); await configuring;
  assert.equal(lark.status(), 'ready');
  assert.equal(lark.credentials?.appId, secondBot.appId);
  assert.deepEqual(reports.map(record => record.status), ['lark_failed', 'lark_ready']);
});

test('overlapping save, clear and save operations apply in order', async t => {
  const { lark, sockets } = await fixture(t);
  const saving = lark.configure(firstBot);
  const clearing = lark.configure(undefined);
  const replacing = lark.configure(secondBot);
  await nextTurn();
  assert.equal(sockets.length, 1, 'later settings operations wait for the current SDK start');
  sockets[0].ready(); await saving; await clearing; await nextTurn();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].closed, 1);
  assert.equal(sockets[1].options.appId, secondBot.appId);
  sockets[1].ready(); await replacing;
  assert.equal(lark.credentials?.appId, secondBot.appId);
  assert.equal(lark.api?.appId, secondBot.appId);
  assert.equal(lark.status(), 'ready');
});

test('clear and stop reject late callbacks; repeated starts create one client', async t => {
  const { lark, sockets, reports } = await fixture(t);
  const starting = lark.start(); const again = lark.start();
  await nextTurn();
  assert.equal(sockets.length, 1);
  sockets[0].ready(); await Promise.all([starting, again]);
  await lark.configure(undefined);
  const clearedCount = reports.length;
  sockets[0].lateCallbacks();
  assert.equal(lark.status(), 'disabled');
  assert.equal(lark.api, undefined);
  assert.equal(reports.length, clearedCount);
  const replacing = lark.configure(secondBot); await nextTurn();
  const stopping = lark.stop(); await nextTurn();
  sockets[1].ready(); await replacing; await stopping;
  const stoppedCount = reports.length;
  sockets[1].lateCallbacks();
  assert.equal(lark.status(), 'stopped');
  assert.equal(reports.length, stoppedCount);
  assert.equal(sockets[1].closed, 1);
});

test('a rejected configuration start reports failure without leaving a live client', async t => {
  const { lark, sockets, reports } = await fixture(t);
  const configuring = assert.doesNotReject(lark.configure(firstBot)); await nextTurn();
  sockets[0].opening.reject(new Error('configuration start rejected')); await configuring;
  assert.equal(lark.status(), 'failed');
  assert.equal(sockets[0].closed, 1);
  sockets[0].lateCallbacks();
  assert.equal(lark.status(), 'failed');
  assert.deepEqual(reports.map(record => record.status), ['lark_failed']);
  const retrying = lark.start(); await nextTurn(); sockets[1].ready(); await retrying;
  assert.equal(lark.status(), 'ready');
});

test('configuration drains accepted messages on the old API and ignores new events from that socket', async t => {
  const reading = gate(); const requested = gate();
  const api: LarkApi = { appId: firstBot.appId, async request<T>(): Promise<T> {
    requested.resolve(); await reading.promise;
    return { revision: '1', content: `agent-session:v1:${hostname()}:codex:thread-test` } as T;
  } };
  const { lark, state, sessions, sockets, reports } = await fixture(t, api);
  const send = t.mock.method(sessions, 'send', async () => ({ status: 'input_accepted' as const }));
  state.bindings.set('oc_test', { chat_id: 'oc_test', session_id: 'thread-test', sender_open_id: 'ou_owner' });
  const event = (message_id: string) => ({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: { chat_id: 'oc_test', message_id, message_type: 'text', content: JSON.stringify({ text: 'hello' }) } });
  const starting = lark.start(); await nextTurn(); sockets[0].ready(); await starting;
  await sockets[0].message(event('om_accepted')); await requested.promise;
  const configuring = lark.configure(secondBot); await nextTurn();
  try {
    assert.equal(sockets[0].closed, 1);
    assert.equal(lark.api, api, 'accepted messages still use their original credentials');
    assert.equal(sockets.length, 1, 'the replacement waits for message delivery');
    await sockets[0].message(event('om_late'));
    assert.ok(!reports.some(record => record.message_id === 'om_late'), 'the closed socket cannot enqueue another message');
  } finally { reading.resolve(); }
  await lark.drain(); await nextTurn(); sockets[1].ready(); await configuring;
  assert.equal(send.mock.calls.length, 1);
  assert.equal(state.deliveries.has('om_late'), false);
  assert.equal(state.deliveries.get('om_accepted')?.transport_status, 'input_accepted');
  assert.equal(lark.api?.appId, secondBot.appId);
});
