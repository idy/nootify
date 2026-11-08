import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { LarkService } from '../src/lark.js';
import { ApiError, type LarkApi } from '../src/lark-metadata.js';
import { SessionsService } from '../src/sessions.js';
import { State } from '../src/state.js';
import { RetryableDeliveryError, SessionUnavailable, UnconfirmedDeliveryError, type DeliveryResult } from '../src/types.js';

const payload = () => ({
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
  message: { chat_id: 'oc_reactions', message_id: 'om_received', thread_id: 'omt_topic',
    message_type: 'text', content: JSON.stringify({ text: 'continue' }) },
});
async function fixture(t: TestContext, status: DeliveryResult['status'] = 'input_accepted') {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-reactions-'));
  const state = await State.open(directory);
  state.bindings.set('oc_reactions', { chat_id: 'oc_reactions', session_id: 'reaction-session', sender_open_id: 'ou_owner', adapter: 'codex' });
  const sessions = new SessionsService(state);
  const order: string[] = [];
  const send = t.mock.method(sessions, 'send', async () => { order.push('send'); return { status }; });
  const reactions: { method: string; path: string; body: unknown; status?: string }[] = [];
  const model = { error: undefined as Error | undefined };
  const api: LarkApi = { appId: 'cli_reactions', async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (path.endsWith('/reactions')) {
      order.push('reaction');
      reactions.push({ method, path, body, status: state.larkDelivery('om_received')?.transport_status });
      if (model.error) throw model.error;
      return { reaction_id: 'reaction-received' } as T;
    }
    assert.equal(method, 'GET'); assert.equal(path, '/open-apis/im/v1/chats/oc_reactions/announcement');
    return { revision: '1', content: `agent-session:v1:${hostname()}:codex:reaction-session` } as T;
  } };
  const reports: Record<string, unknown>[] = [];
  const lark = new LarkService(state, sessions, undefined, record => reports.push(record), api);
  t.after(async () => { await lark.stop(); await sessions.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, state, sessions, send, api, lark, reactions, reports, model, order };
}

for (const status of ['socket_written', 'input_accepted', 'inbox_queued'] as const) {
  test(`successful ${status} routing reacts to the original topic message once, including after restart`, async t => {
    const f = await fixture(t, status);
    assert.equal(await f.lark.enqueue(payload()), true);
    assert.deepEqual(f.order, ['send', 'reaction']);
    assert.deepEqual(f.reactions, [{ method: 'POST', path: '/open-apis/im/v1/messages/om_received/reactions',
      body: { reaction_type: { emoji_type: 'FINGERHEART' } }, status }]);
    assert.equal(f.state.larkDelivery('om_received')?.acknowledged_at, undefined, 'routing is distinct from a session receipt');
    assert.equal(await f.lark.enqueue(payload()), true);
    const restarted = new LarkService(await State.open(f.directory), f.sessions, undefined, () => {}, f.api);
    t.after(() => restarted.stop());
    assert.equal(await restarted.enqueue(payload()), true);
    assert.equal(f.send.mock.calls.length, 1); assert.equal(f.reactions.length, 1);
  });
}

for (const [error, status, handled] of [
  [new RetryableDeliveryError('not submitted'), 'delivery_failed', false],
  [new UnconfirmedDeliveryError('submission outcome unknown'), 'delivery_unconfirmed', true],
  [new SessionUnavailable('session_offline'), 'ignored', true],
] as const) {
  test(`${status} input receives no success reaction`, async t => {
    const f = await fixture(t);
    t.mock.method(f.sessions, 'send', async () => { throw error; });
    assert.equal(await f.lark.enqueue(payload()), handled);
    assert.equal(f.state.larkDelivery('om_received')?.transport_status, status);
    assert.equal(f.reactions.length, 0);
  });
}

test('untrusted senders and unsupported messages receive no reaction', async t => {
  const f = await fixture(t);
  const untrusted = payload(); untrusted.sender.sender_id.open_id = 'ou_other';
  const unsupported = payload(); unsupported.message.message_type = 'image';
  const invalid = payload(); invalid.message.content = '{invalid';
  for (const event of [untrusted, unsupported, invalid]) assert.equal(await f.lark.enqueue(event), true);
  assert.equal(f.send.mock.calls.length, 0); assert.equal(f.reactions.length, 0);
});

test('same-app bot messages are ignored before routing without consuming a user message ID', async t => {
  const f = await fixture(t);
  const bot = { ...payload(), sender: { sender_type: 'app', sender_id: { open_id: 'ou_owner', app_id: f.api.appId } } };
  // A matching trusted ID must never turn an application sender into user input.
  for (const event of [bot, { event: bot }]) assert.equal(await f.lark.enqueue(event), true);
  assert.equal(f.send.mock.calls.length, 0); assert.equal(f.reactions.length, 0);
  assert.equal(f.state.deliveries.size, 0); assert.deepEqual(f.reports, []);

  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(f.send.mock.calls.length, 1); assert.equal(f.reactions.length, 1);
});

test('a safely retried delivery only gets a reaction after the successful attempt', async t => {
  const f = await fixture(t); let attempts = 0;
  t.mock.method(f.sessions, 'send', async () => {
    if (++attempts === 1) throw new RetryableDeliveryError('not submitted');
    return { status: 'input_accepted' as const };
  });
  assert.equal(await f.lark.enqueue(payload()), false); assert.equal(f.reactions.length, 0);
  assert.equal(await f.lark.enqueue(payload()), true); assert.equal(f.reactions.length, 1);
  assert.equal(await f.lark.enqueue(payload()), true); assert.equal(attempts, 2);
});

for (const error of [new ApiError(99991672, 'reaction permission missing'), new RetryableDeliveryError('reaction request timed out')]) {
  test(`reaction failure does not change successful routing or replay input: ${error.message}`, async t => {
    const f = await fixture(t); f.model.error = error;
    assert.equal(await f.lark.enqueue(payload()), true);
    assert.equal(f.state.larkDelivery('om_received')?.transport_status, 'input_accepted');
    assert.equal(f.state.larkDelivery('om_received')?.retryable, undefined);
    assert.equal(await f.lark.enqueue(payload()), true);
    const restarted = new LarkService(await State.open(f.directory), f.sessions, undefined, () => {}, f.api);
    t.after(() => restarted.stop());
    assert.equal(await restarted.enqueue(payload()), true);
    assert.equal(f.send.mock.calls.length, 1); assert.equal(f.reactions.length, 1);
    assert.ok(f.reports.some(record => record.status === 'reaction_failed' && record.message_id === 'om_received' && record.error === error.message));
    assert.ok(!f.reports.some(record => record.status === 'delivery_failed' || record.status === 'delivery_unconfirmed'));
  });
}

test('a status-save failure after successful routing still adds the reaction without resending', async t => {
  const f = await fixture(t); const save = f.state.save.bind(f.state); let writes = 0;
  t.mock.method(f.state, 'save', async () => {
    if (++writes === 2) throw new Error('status storage unavailable');
    await save();
  });
  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(f.reactions.length, 1); assert.equal(f.send.mock.calls.length, 1);
  assert.ok(f.reports.some(record => record.status === 'state_write_failed'));
  assert.equal(await f.lark.enqueue(payload()), true);
  assert.equal(f.send.mock.calls.length, 1);
});
