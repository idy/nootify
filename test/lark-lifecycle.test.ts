import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { LarkService } from '../src/lark.js';
import type { LarkPollingOptions, LarkReceiver } from '../src/lark-polling.js';
import type { Credentials, LarkApi } from '../src/lark-metadata.js';
import { SessionsService } from '../src/sessions.js';
import { State } from '../src/state.js';

const firstBot: Credentials = { appId: 'cli_0123456789abcdef', appSecret: 'first-secret' };
const secondBot: Credentials = { appId: 'cli_fedcba9876543210', appSecret: 'second-secret' };
function gate() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
/** Delayed starts and late HTTP completions without contacting Feishu. */
class FakeReceiver implements LarkReceiver {
  readonly opening = gate();
  closed = 0;
  onStop?: () => void;
  constructor(readonly options: LarkPollingOptions) {}
  start(): Promise<void> { return this.opening.promise; }
  async stop(): Promise<void> { this.closed++; this.onStop?.(); }
  ready(): void { this.options.status('ready'); this.opening.resolve(); }
  message(payload: unknown): Promise<boolean> { return this.options.receive(payload); }
  lateCallbacks(): void {
    this.options.status('failed'); this.options.report({ status: 'lark_failed', error: 'late failure' }); this.options.status('ready');
  }
}
async function fixture(t: TestContext, api?: LarkApi) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-lark-lifecycle-'));
  const state = await State.open(directory);
  const sessions = new SessionsService(state);
  const receivers: FakeReceiver[] = []; const reports: Record<string, unknown>[] = [];
  const lark = new LarkService(state, sessions, firstBot, record => reports.push(record), api, 9417, options => {
    const receiver = new FakeReceiver(options); receivers.push(receiver); return receiver;
  });
  t.after(async () => { for (const receiver of receivers) receiver.opening.resolve(); await lark.stop(); await sessions.stop(); await rm(directory, { recursive: true, force: true }); });
  return { lark, state, sessions, receivers, reports };
}

test('missing Feishu credentials never start polling or report ready', async t => {
  const { lark, receivers, reports } = await fixture(t);
  for (const credentials of [{ ...firstBot, appSecret: '' }, { ...firstBot, appSecret: '   ' }, { ...firstBot, appId: '' }]) {
    await lark.configure(credentials);
    assert.equal(lark.status(), 'failed');
    assert.equal(receivers.length, 0);
  }
  assert.ok(reports.every(record => record.status === 'lark_failed'));
  await lark.configure(undefined); await lark.start();
  assert.equal(lark.status(), 'disabled');
  assert.equal(receivers.length, 0);
});

test('Feishu stays connecting until a successful history polling pass', async t => {
  const { lark, receivers, reports } = await fixture(t);
  const starting = lark.start(); await nextTurn();
  receivers[0].opening.resolve(); await starting;
  assert.equal(lark.status(), 'connecting');
  assert.equal(reports.length, 0);
  receivers[0].ready();
  assert.equal(lark.status(), 'ready');
});

test('a polling failure can recover on the same receiver', async t => {
  const { lark, receivers, reports } = await fixture(t);
  const starting = lark.start(); await nextTurn(); receivers[0].ready(); await starting;
  receivers[0].options.status('failed');
  assert.equal(lark.status(), 'failed');
  await lark.start();
  assert.equal(receivers.length, 1);
  receivers[0].ready();
  assert.equal(lark.status(), 'ready');
  assert.equal(reports.filter(record => record.status === 'lark_ready').length, 2);
});

test('reconfiguring unchanged credentials replaces the receiver; stale completions are ignored', async t => {
  const { lark, receivers, reports } = await fixture(t);
  const starting = lark.start(); await nextTurn(); receivers[0].ready(); await starting;
  receivers[0].onStop = () => receivers[0].lateCallbacks();
  const configuring = lark.configure({ ...firstBot }); await nextTurn();
  assert.equal(receivers[0].closed, 1);
  assert.equal(receivers.length, 2);
  assert.equal(lark.status(), 'connecting');
  receivers[1].ready(); await configuring;
  const count = reports.length;
  receivers[0].lateCallbacks();
  assert.equal(await receivers[0].message({ retired: true }), false);
  assert.equal(lark.status(), 'ready');
  assert.equal(reports.length, count);
});

test('a rejected polling start stays local and a concurrent configuration waits its turn', async t => {
  const { lark, receivers, reports } = await fixture(t);
  const starting = assert.doesNotReject(lark.start()); await nextTurn();
  const configuring = lark.configure(secondBot); await nextTurn();
  assert.equal(receivers.length, 1);
  receivers[0].opening.reject(new Error('initial polling start rejected'));
  await starting; await nextTurn();
  assert.equal(receivers[0].closed, 1);
  assert.equal(receivers.length, 2);
  receivers[1].ready(); await configuring;
  assert.equal(lark.credentials?.appId, secondBot.appId);
  assert.deepEqual(reports.map(record => record.status), ['lark_failed', 'lark_ready']);
});

test('overlapping save, clear and save operations apply in order', async t => {
  const { lark, receivers } = await fixture(t);
  const saving = lark.configure(firstBot); const clearing = lark.configure(undefined); const replacing = lark.configure(secondBot);
  await nextTurn();
  assert.equal(receivers.length, 1);
  receivers[0].ready(); await saving; await clearing; await nextTurn();
  assert.equal(receivers.length, 2);
  assert.equal(receivers[0].closed, 1);
  assert.equal(receivers[1].options.api.appId, secondBot.appId);
  receivers[1].ready(); await replacing;
  assert.equal(lark.api?.appId, secondBot.appId);
  assert.equal(lark.status(), 'ready');
});

test('clear and stop reject late completions; repeated starts create one receiver', async t => {
  const { lark, receivers, reports } = await fixture(t);
  const starting = lark.start(); const again = lark.start(); await nextTurn();
  assert.equal(receivers.length, 1);
  receivers[0].ready(); await Promise.all([starting, again]);
  await lark.configure(undefined);
  const clearedCount = reports.length;
  receivers[0].lateCallbacks();
  assert.equal(lark.status(), 'disabled');
  assert.equal(lark.api, undefined);
  assert.equal(reports.length, clearedCount);
  const replacing = lark.configure(secondBot); await nextTurn();
  const stopping = lark.stop(); await nextTurn();
  receivers[1].ready(); await replacing; await stopping;
  const count = reports.length; receivers[1].lateCallbacks();
  assert.equal(lark.status(), 'stopped');
  assert.equal(reports.length, count);
  assert.equal(receivers[1].closed, 1);
});

test('configuration drains accepted messages on the old API and ignores late receiver input', async t => {
  const reading = gate(); const requested = gate(); const reactions: string[] = [];
  const api: LarkApi = { appId: firstBot.appId, async request<T>(_method: string, path: string): Promise<T> {
    if (path.endsWith('/reactions')) { reactions.push(path); return { reaction_id: 'old-bot-reaction' } as T; }
    requested.resolve(); await reading.promise;
    return { revision: '1', content: `agent-session:v1:${hostname()}:codex:thread-test` } as T;
  } };
  const { lark, state, sessions, receivers, reports } = await fixture(t, api);
  const send = t.mock.method(sessions, 'send', async () => ({ status: 'input_accepted' as const }));
  state.bindings.set('oc_test', { chat_id: 'oc_test', session_id: 'thread-test', sender_open_id: 'ou_owner' });
  const event = (message_id: string) => ({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: { chat_id: 'oc_test', message_id, message_type: 'text', content: JSON.stringify({ text: 'hello' }) } });
  const starting = lark.start(); await nextTurn(); receivers[0].ready(); await starting;
  const receiving = receivers[0].message(event('om_accepted')); await requested.promise;
  const configuring = lark.configure(secondBot); await nextTurn();
  try {
    assert.equal(receivers[0].closed, 1);
    assert.equal(lark.api, api);
    assert.equal(receivers.length, 1);
    const late = receivers[0].message(event('om_late'));
    reading.resolve();
    assert.equal(await late, false);
    assert.ok(!reports.some(record => record.message_id === 'om_late'));
  } finally { reading.resolve(); }
  assert.equal(await receiving, true);
  await nextTurn(); receivers[1].ready(); await configuring;
  assert.equal(send.mock.calls.length, 1);
  assert.equal(state.deliveries.has('om_late'), false);
  assert.equal(state.deliveries.get('om_accepted')?.transport_status, 'input_accepted');
  assert.deepEqual(reactions, ['/open-apis/im/v1/messages/om_accepted/reactions']);
  assert.equal(lark.api?.appId, secondBot.appId);
});
