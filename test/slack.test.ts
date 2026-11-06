import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import type { ChatMessage, ChatTransport, SlackConfig } from '../src/chat-transport.js';
import { createSlackTransportWithClient, type SlackClient, type SlackSocket, type SlackSocketOptions } from '../src/slack.js';

const config: SlackConfig = { bot_token: 'xoxb-fixture-bot-secret', app_token: 'xapp-fixture-app-secret', channel_id: 'C012AB3CD', user_id: 'U024BE7LH' };
const root = '1712320421.000100';
const reply = '1712320422.000200';
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

class FakeSocket extends EventEmitter implements SlackSocket {
  readyState = WebSocket.CONNECTING as number;
  bufferedAmount = 0;
  readonly acks: { envelope_id: string }[] = [];
  readonly ackCallbacks: ((error?: Error) => void)[] = [];
  holdAcks = false;
  autoPong = true;
  pings = 0;
  terminated = 0;
  constructor(readonly url: string, readonly options: SlackSocketOptions) { super(); }
  send(data: string, callback: (error?: Error) => void): void {
    this.acks.push(JSON.parse(data));
    if (this.holdAcks) this.ackCallbacks.push(callback); else callback();
  }
  ping(): void { this.pings++; if (this.autoPong) this.emit('pong', Buffer.alloc(0)); }
  terminate(): void { this.terminated++; this.readyState = WebSocket.CLOSED; this.emit('close', 1006, Buffer.alloc(0)); }
  open(): void { this.readyState = WebSocket.OPEN; this.emit('open'); }
  frame(frame: unknown): void { this.emit('message', Buffer.from(JSON.stringify(frame)), false); }
  hello(): void {
    this.frame({ type: 'hello', num_connections: 1, connection_info: { app_id: 'A01234567' }, debug_info: { host: 'wss-111.slack.com', approximate_connection_time: 3600 } });
  }
}

interface Call { method: string; url: URL; init: RequestInit; body: Record<string, unknown> }
class Fixture {
  readonly calls: Call[] = [];
  readonly sockets: FakeSocket[] = [];
  readonly auth = { ok: true, url: 'https://fixture.slack.com/', team: 'Fixture workspace', user: 'nootify', team_id: 'T01234567', user_id: 'U0BOT1234', bot_id: 'B0BOT1234' };
  readonly channel: Record<string, unknown> = { id: config.channel_id, name: 'agent-sessions', is_channel: true, is_group: false, is_private: false, is_im: false, is_mpim: false, is_archived: false, is_member: true };
  readonly user: Record<string, unknown> = { id: config.user_id, team_id: 'T01234567', name: 'owner', is_bot: false, is_app_user: false, deleted: false };
  override?: (call: Call) => Response | Promise<Response> | undefined;
  connections = 0;
  posts = 0;
  failSocket = false;
  readonly client: SlackClient = {
    fetch: async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const call: Call = { method: url.pathname.split('/').at(-1)!, url, init, body: init.body ? JSON.parse(String(init.body)) : {} };
      this.calls.push(call);
      const overridden = this.override?.(call);
      if (overridden) return overridden;
      switch (call.method) {
        case 'auth.test': return json(this.auth);
        case 'conversations.info': return json({ ok: true, channel: this.channel });
        case 'users.info': return json({ ok: true, user: this.user });
        case 'apps.connections.open': return json({ ok: true, url: `wss://wss-primary.slack.com/link/?ticket=fixture-${++this.connections}` });
        case 'chat.postMessage': return json({ ok: true, channel: this.channel.id, ts: `1712320423.${String(++this.posts).padStart(6, '0')}`, message: { type: 'message', text: call.body.text } });
        default: throw new Error('Unexpected fixture method');
      }
    },
    webSocket: (url, options) => {
      if (this.failSocket) throw new Error(`Raw WebSocket failure ${config.app_token}`);
      const socket = new FakeSocket(url, options); this.sockets.push(socket); return socket;
    },
  };
}

let envelopeSequence = 0;
/** Actual events_api wrapper/event_callback/message shape from Slack's Socket Mode protocol. */
function event(change: Record<string, unknown> = {}, payloadChange: Record<string, unknown> = {}) {
  return {
    envelope_id: `39cf1049-${String(++envelopeSequence).padStart(4, '0')}-4cbb-a80e-b3a3893be441`, type: 'events_api', accepts_response_payload: false,
    payload: {
      token: 'legacy-verification-token', team_id: 'T01234567', api_app_id: 'A01234567', type: 'event_callback',
      event: { type: 'message', channel: config.channel_id, user: config.user_id, text: 'Please continue', ts: reply, thread_ts: root, event_ts: reply, channel_type: 'channel', ...change },
      event_id: 'Ev01234567', event_time: 1712320422, authorizations: [{ team_id: 'T01234567', user_id: 'U0BOT1234', is_bot: true }], ...payloadChange,
    },
  };
}
async function transport(t: TestContext, fixture = new Fixture()) {
  const value = await createSlackTransportWithClient(config, fixture.client);
  t.after(() => value.stop());
  return { value, fixture };
}
async function running(t: TestContext, fixture = new Fixture(), receive?: (message: ChatMessage) => Promise<void>) {
  const { value } = await transport(t, fixture);
  const statuses: string[] = []; const received: ChatMessage[] = [];
  const opening = value.start(receive ?? (async message => { received.push(message); }), status => statuses.push(status));
  await nextTurn();
  const socket = fixture.sockets.at(-1)!;
  socket.open(); socket.hello(); await opening;
  return { value, fixture, socket, statuses, received };
}
function timers(t: TestContext): void { t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); }

test('Slack validates the bot, workspace, member channel, human owner and Socket Mode before returning', async t => {
  const { value, fixture } = await transport(t);
  assert.equal(value.identity, `T01234567:B0BOT1234:${config.channel_id}`);
  assert.equal(value.account, 'Slack Fixture workspace · @nootify · #agent-sessions');
  assert.deepEqual(fixture.calls.map(call => call.method), ['auth.test', 'conversations.info', 'users.info', 'apps.connections.open']);
  assert.equal(fixture.sockets.length, 0, 'factory verifies the socket URL without starting a listener');
  for (const call of fixture.calls) {
    const app = call.method === 'apps.connections.open';
    assert.equal(new Headers(call.init.headers).get('authorization'), `Bearer ${app ? config.app_token : config.bot_token}`);
    assert.equal(call.url.origin, 'https://slack.com');
    assert.equal(call.init.redirect, 'error');
    assert.ok(!call.url.href.includes(config.bot_token) && !call.url.href.includes(config.app_token));
    assert.ok(!String(call.init.body).includes(config.bot_token) && !String(call.init.body).includes(config.app_token));
    assert.ok(call.init.signal);
  }
  assert.equal(fixture.calls[1].init.method, 'GET');
  assert.equal(fixture.calls[1].url.searchParams.get('channel'), config.channel_id);
  assert.equal(fixture.calls[2].url.searchParams.get('user'), config.user_id);
  assert.equal(new Headers(fixture.calls[3].init.headers).get('content-type'), 'application/x-www-form-urlencoded');
});

test('private and legacy private channels are supported after explicitly inviting the bot', async t => {
  for (const legacy of [false, true]) await t.test(legacy ? 'legacy G channel' : 'private C channel', async sub => {
    const fixture = new Fixture();
    fixture.channel.is_private = true; fixture.channel.is_channel = !legacy; fixture.channel.is_group = legacy;
    const privateConfig = { ...config, channel_id: legacy ? 'G012AB3CD' : config.channel_id };
    fixture.channel.id = privateConfig.channel_id;
    const value = await createSlackTransportWithClient(privateConfig, fixture.client);
    sub.after(() => value.stop());
    assert.equal(value.identity, `T01234567:B0BOT1234:${privateConfig.channel_id}`);
  });
});

test('malformed config, unverified identities, nonmembers and nonhuman senders fail closed', async t => {
  const invalid: [string, (f: Fixture) => void, RegExp][] = [
    ['missing bot identity', f => { f.auth.bot_id = ''; }, /verify a bot/],
    ['missing workspace', f => { f.auth.team_id = ''; }, /verify a bot/],
    ['missing bot user', f => { f.auth.user_id = ''; }, /verify a bot/],
    ['wrong channel', f => { f.channel.id = 'COTHER'; }, /unsupported channel/],
    ['archived channel', f => { f.channel.is_archived = true; }, /unsupported channel/],
    ['group DM', f => { f.channel.is_mpim = true; }, /unsupported channel/],
    ['nonmember', f => { f.channel.is_member = false; }, /Invite.*bot/],
    ['unknown membership', f => { delete f.channel.is_member; }, /Invite.*bot/],
    ['wrong user', f => { f.user.id = 'UOTHER'; }, /active human/],
    ['bot owner', f => { f.user.is_bot = true; }, /active human/],
    ['unknown user type', f => { delete f.user.is_bot; }, /active human/],
    ['app owner', f => { f.user.is_app_user = true; }, /active human/],
    ['deleted owner', f => { f.user.deleted = true; }, /active human/],
    ['other workspace owner', f => { f.user.team_id = 'TOTHER'; }, /active human/],
    ['bot itself', f => { f.user.id = config.user_id; f.auth.user_id = config.user_id; }, /active human/],
  ];
  for (const [name, change, expected] of invalid) await t.test(name, async () => {
    const fixture = new Fixture(); change(fixture);
    await assert.rejects(createSlackTransportWithClient(config, fixture.client), expected);
    assert.equal(fixture.sockets.length, 0);
  });
  const fixture = new Fixture();
  await assert.rejects(createSlackTransportWithClient({ ...config, bot_token: 'xoxp-not-a-bot' }, fixture.client), /configuration is invalid/);
  assert.equal(fixture.calls.length, 0);
});

test('Slack API failures, network errors and malformed JSON never surface provider text or credentials', async t => {
  for (const kind of ['network', 'json', 'api', 'error object', 'http', 'redirect', 'invite', 'scope', 'rate'] as const) await t.test(kind, async () => {
    const fixture = new Fixture();
    fixture.override = call => {
      if (kind === 'invite' && call.method === 'conversations.info') return json({ ok: false, error: 'channel_not_found' });
      if (call.method !== 'auth.test') return;
      if (kind === 'network') throw new Error(`Raw failed URL https://bad.invalid/${config.bot_token}/${config.app_token}`);
      if (kind === 'json') { const response = json({}); response.json = async () => { throw new Error(config.app_token); }; return response; }
      if (kind === 'http') return new Response(config.bot_token, { status: 500 });
      if (kind === 'redirect') return new Response(null, { status: 302, headers: { location: `https://bad.invalid/${config.app_token}` } });
      if (kind === 'scope') return json({ ok: false, error: 'missing_scope', needed: config.bot_token });
      if (kind === 'rate') return new Response(null, { status: 429 });
      if (kind === 'api') return json({ ok: false, error: `secret error ${config.bot_token}` });
      if (kind === 'error object') return json({ ok: false, error: { toString: config.bot_token } });
    };
    const expected = kind === 'invite' ? /Invite the bot/ : kind === 'scope' ? /required.*permissions/ : kind === 'rate' ? /rate limit/ : /Slack auth.test request failed/;
    await assert.rejects(createSlackTransportWithClient(config, fixture.client), error => {
      assert.match(String(error), expected);
      assert.ok(!String(error).includes(config.bot_token) && !String(error).includes(config.app_token));
      assert.equal((error as Error & { cause?: unknown }).cause, undefined);
      return true;
    });
  });
});

test('both fetch and response-body reads have bounded aborting timeouts', async t => {
  for (const phase of ['fetch', 'json']) await t.test(phase, async sub => {
    timers(sub);
    const fixture = new Fixture();
    fixture.override = () => {
      if (phase === 'fetch') return new Promise<Response>(() => {});
      const response = json({}); response.json = () => new Promise(() => {}); return response;
    };
    const rejected = assert.rejects(createSlackTransportWithClient(config, fixture.client), /request timed out/);
    await nextTurn(); sub.mock.timers.tick(15_000); await rejected;
    assert.equal(fixture.calls[0].init.signal?.aborted, true);
  });
});

test('Socket Mode URLs must be credential-free official Slack WSS endpoints', async t => {
  const urls = [
    'https://wss.slack.com/link/?ticket=fixture', 'ws://wss.slack.com/link/?ticket=fixture',
    'wss://wss.slack.com.evil.invalid/link/?ticket=fixture', 'wss://slack.com.evil.invalid/link/?ticket=fixture',
    'wss://localhost/link/?ticket=fixture', 'wss://127.0.0.1/link/?ticket=fixture', 'wss://slack.com/link/?ticket=fixture',
    'wss://wss.slack.com:8443/link/?ticket=fixture', 'wss://wss.slack.com/link/?ticket=fixture#fragment',
    'wss://wss.slack.com/not-a-link/?ticket=fixture', 'wss://wss.slack.com/link/',
    `wss://${config.app_token}@wss.slack.com/link/?ticket=fixture`, `wss://owner:${config.bot_token}@wss.slack.com/link/?ticket=fixture`,
    `wss://wss.slack.com/link/?ticket=fixture&app_token=${config.app_token}`,
    `wss://wss.slack.com/link/?ticket=${encodeURIComponent(config.app_token).replace('x', '%78')}`,
    ' wss://wss.slack.com/link/?ticket=fixture', 'not a URL',
  ];
  for (const url of urls) {
    const fixture = new Fixture();
    fixture.override = call => call.method === 'apps.connections.open' ? json({ ok: true, url }) : undefined;
    await assert.rejects(createSlackTransportWithClient(config, fixture.client), error => {
      assert.equal((error as Error).message, 'Slack returned an invalid Socket Mode URL.');
      assert.ok(!String(error).includes(config.app_token) && !String(error).includes(config.bot_token));
      return true;
    });
    assert.equal(fixture.sockets.length, 0);
  }
});

test('display account labels cannot accidentally expose credentials', async t => {
  const fixture = new Fixture(); fixture.auth.team = config.bot_token; fixture.auth.user = config.app_token; fixture.channel.name = `name ${config.bot_token}`;
  const { value } = await transport(t, fixture);
  assert.equal(value.account, `Slack T01234567 · @U0BOT1234 · #${config.channel_id}`);
});

test('openThread posts exactly one root; send chunks plaintext in that root and returns the final receipt', async t => {
  const { value, fixture } = await transport(t);
  const location = await value.openThread('Working session');
  assert.deepEqual(location, { chat_id: config.channel_id, thread_id: '1712320423.000001' });
  const text = `${'a'.repeat(3499)}😀${'b'.repeat(3501)}`;
  const result = await value.send(location, text, reply);
  const posts = fixture.calls.filter(call => call.method === 'chat.postMessage');
  assert.equal(posts[0].body.thread_ts, undefined);
  assert.equal(posts[0].body.text, 'Working session');
  assert.equal(posts.slice(1).map(call => call.body.text).join(''), text);
  assert.ok(posts.length >= 3);
  for (const call of posts) {
    assert.equal(call.init.method, 'POST');
    assert.equal(call.body.channel, config.channel_id);
    assert.equal(call.body.mrkdwn, false);
    assert.equal(call.body.parse, 'none');
    assert.equal(call.body.link_names, false);
    assert.equal(call.body.unfurl_links, false);
    assert.equal(call.body.unfurl_media, false);
    assert.equal(call.body.reply_broadcast, false);
    assert.ok(String(call.body.text).length <= 3500);
    assert.doesNotMatch(String(call.body.text), /[\ud800-\udbff]$/u);
    if (call !== posts[0]) assert.equal(call.body.thread_ts, location.thread_id, 'replyTo cannot redirect a message into another root');
  }
  assert.deepEqual(result, { message_id: `1712320423.${String(posts.length).padStart(6, '0')}` });
});

test('Slack control characters stay literal, entities and surrogate pairs never straddle chunks', async t => {
  const { value, fixture } = await transport(t);
  const text = `${'&<@UOTHER> <!channel> <https://example.invalid|label> 😀 '.repeat(160)}&amp;`;
  await value.send({ chat_id: config.channel_id, thread_id: root }, text);
  const posts = fixture.calls.filter(call => call.method === 'chat.postMessage');
  const decode = (value: string) => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  assert.equal(posts.map(call => decode(String(call.body.text))).join(''), text);
  for (const call of posts) {
    const text = String(call.body.text);
    assert.ok(text.length <= 3500);
    assert.doesNotMatch(text, /[<>]/);
    assert.doesNotMatch(text.replaceAll('&amp;', '').replaceAll('&lt;', '').replaceAll('&gt;', ''), /&/);
  }
  const count = posts.length;
  await value.openThread('x'.repeat(8000));
  const roots = fixture.calls.filter(call => call.method === 'chat.postMessage').slice(count);
  assert.equal(roots.length, 1); assert.equal(String(roots[0].body.text).length, 3500); assert.equal(roots[0].body.thread_ts, undefined);
});

test('invalid destinations and empty text are rejected before posting', async t => {
  const { value, fixture } = await transport(t);
  const before = fixture.calls.length;
  await assert.rejects(value.send({ chat_id: 'COTHER', thread_id: root }, 'hello'), /location is invalid/);
  await assert.rejects(value.send({ chat_id: config.channel_id, thread_id: 'not-a-ts' }, 'hello'), /location is invalid/);
  await assert.rejects(value.send({ chat_id: config.channel_id, thread_id: root }, 'hello', 'not-a-ts'), /location is invalid/);
  await assert.rejects(value.send({ chat_id: config.channel_id, thread_id: root }, ' \n '), /text is empty/);
  await assert.rejects(value.openThread(''), /text is empty/);
  await assert.rejects(value.send({ chat_id: config.channel_id, thread_id: root }, 'x'.repeat(128_001)), /too large/);
  assert.equal(fixture.calls.length, before);
});

test('outgoing failures are safe, are not retried, and cannot substitute another channel receipt', async t => {
  const { value, fixture } = await transport(t);
  fixture.override = call => call.method === 'chat.postMessage' ? json({ ok: false, error: config.app_token }) : undefined;
  await assert.rejects(value.openThread('session'), { message: 'Slack chat.postMessage request failed.' });
  assert.equal(fixture.calls.filter(call => call.method === 'chat.postMessage').length, 1);
  fixture.override = call => call.method === 'chat.postMessage' ? json({ ok: true, channel: 'COTHER', ts: reply }) : undefined;
  await assert.rejects(value.openThread('session'), /invalid message receipt/);
});

test('Socket Mode acknowledges envelopes before dispatching and filters wrong senders, bots, edits and rooms', async t => {
  const { socket, statuses, received } = await running(t);
  assert.deepEqual(statuses, ['ready']);
  assert.deepEqual(socket.options, { maxPayload: 256 * 1024, handshakeTimeout: 10_000, followRedirects: false, perMessageDeflate: false });
  const ignored = [
    event({ user: 'UOTHER' }), event({ channel: 'COTHER' }), event({ thread_ts: undefined }), event({ user: undefined }), event({ text: undefined }),
    event({ ts: undefined }), event({ text: ' ' }), event({ type: 'app_mention' }), event({ bot_id: 'BOTHER' }), event({ bot_profile: {} }), event({ app_id: 'AOTHER' }),
    event({ subtype: 'bot_message' }), event({ subtype: 'message_changed', message: { user: config.user_id, text: 'edited' } }),
    event({ subtype: 'message_deleted' }), event({ subtype: 'message_replied' }), event({ subtype: 'thread_broadcast' }), event({ edited: { user: config.user_id, ts: reply } }), event({ hidden: true }),
    event({}, { team_id: 'TOTHER' }), event({}, { type: 'url_verification' }), event({}, { event: null }),
    { envelope_id: 'interactive-envelope', type: 'interactive', accepts_response_payload: true, payload: {} },
  ];
  for (const frame of ignored) socket.frame(frame);
  const accepted = event(); socket.frame(accepted); socket.frame(accepted);
  assert.equal(socket.acks.length, ignored.length + 2, 'ignored and duplicate events still require ACKs');
  assert.deepEqual(socket.acks.at(-1), { envelope_id: accepted.envelope_id });
  assert.equal(received.length, 0, 'consumer work runs after the ACK');
  await nextTurn();
  assert.deepEqual(received, [{ chat_id: config.channel_id, thread_id: root, message_id: reply, sender_id: config.user_id, text: 'Please continue' }]);
  socket.emit('message', Buffer.from('{not json'), false);
  socket.frame({ type: 'events_api', payload: accepted.payload });
  socket.emit('message', Buffer.from(JSON.stringify(event())), true);
  await nextTurn(); assert.equal(received.length, 1);
});

test('a slow consumer has a bounded serial queue while all envelopes are ACKed', async t => {
  const blocked = gate(); const received: ChatMessage[] = []; let active = 0; let peak = 0;
  const { socket, statuses } = await running(t, new Fixture(), async message => {
    received.push(message); peak = Math.max(peak, ++active); await blocked.promise; active--;
  });
  for (let index = 0; index < 150; index++) socket.frame(event({ ts: `1712320422.${String(index).padStart(6, '0')}` }));
  assert.equal(socket.acks.length, 150);
  await nextTurn(); assert.equal(received.length, 1); assert.equal(peak, 1); assert.deepEqual(statuses, ['ready', 'failed']);
  blocked.resolve(); await nextTurn();
  assert.equal(received.length, 100, 'overflow signals failure and discards excess rather than growing memory');
  assert.equal(peak, 1);
});

test('consumer rejection cannot break ACKs or expose a raw error', async t => {
  let deliveries = 0;
  const { socket, statuses } = await running(t, new Fixture(), async () => { deliveries++; throw new Error(config.bot_token); });
  socket.frame(event()); socket.frame(event({ ts: '1712320422.000201' }));
  await nextTurn();
  assert.equal(socket.acks.length, 2); assert.equal(deliveries, 2); assert.deepEqual(statuses, ['ready', 'failed']);
});

test('disconnect, close and error each reconnect with a freshly obtained URL and retire the old socket', async t => {
  for (const reason of ['disconnect', 'close', 'error']) await t.test(reason, async sub => {
    timers(sub);
    const { value, fixture, socket, statuses, received } = await running(sub);
    const oldMessage = socket.listeners('message')[0];
    if (reason === 'disconnect') socket.frame({ type: 'disconnect', reason: 'refresh_requested', debug_info: { host: 'wss-111.slack.com' } });
    else if (reason === 'close') socket.emit('close', 1006, Buffer.alloc(0));
    else socket.emit('error', new Error(config.app_token));
    await nextTurn(); assert.deepEqual(statuses, ['ready', 'reconnecting']);
    sub.mock.timers.tick(499); await nextTurn(); assert.equal(fixture.sockets.length, 1);
    sub.mock.timers.tick(1); await nextTurn(); assert.equal(fixture.sockets.length, 2);
    const next = fixture.sockets[1];
    assert.notEqual(next.url, socket.url); assert.match(next.url, /ticket=fixture-2/); assert.equal(socket.terminated, 1);
    oldMessage(Buffer.from(JSON.stringify(event())), false); socket.emit('error', new Error(config.bot_token));
    assert.equal(socket.acks.length, 0); assert.equal(received.length, 0);
    next.open(); next.hello(); next.frame(event()); await nextTurn();
    assert.deepEqual(statuses, ['ready', 'reconnecting', 'ready']); assert.equal(received.length, 1);
    await value.stop(); sub.mock.timers.tick(120_000); await nextTurn(); assert.equal(fixture.sockets.length, 2);
  });
});

test('permanent reconnect failures retire safely before a status callback starts a replacement', async t => {
  for (const failure of ['revoked app token', 'unsafe fresh URL']) await t.test(failure, async sub => {
    timers(sub);
    const { value, fixture } = await transport(sub);
    const statuses: string[] = []; let replacement: Promise<void> | undefined;
    const receive = async () => {};
    const status = (next: 'ready' | 'reconnecting' | 'failed') => {
      statuses.push(next);
      if (next === 'failed') { fixture.override = undefined; replacement = value.start(receive, status); }
    };
    const opening = value.start(receive, status);
    await nextTurn(); const old = fixture.sockets[0]; old.open(); old.hello(); await opening;
    fixture.override = call => call.method !== 'apps.connections.open' ? undefined : failure === 'revoked app token'
      ? json({ ok: false, error: 'token_revoked' })
      : json({ ok: true, url: `wss://${config.app_token}@bad.invalid/link/?ticket=fixture` });
    old.emit('close'); await nextTurn(); sub.mock.timers.tick(500); await nextTurn();
    assert.deepEqual(statuses, ['ready', 'reconnecting', 'failed']);
    assert.equal(fixture.sockets.length, 2, 'the unsafe URL never reaches the socket factory');
    const next = fixture.sockets[1]; next.open(); next.hello(); await replacement;
    assert.deepEqual(statuses, ['ready', 'reconnecting', 'failed', 'ready']);
    assert.equal(next.terminated, 0, 'a retired run cannot overwrite its replacement');
  });
});

test('reconnect failures use increasing backoff capped at 30 seconds', async t => {
  timers(t);
  const { fixture, socket } = await running(t);
  fixture.failSocket = true;
  socket.emit('error', new Error(config.app_token)); await nextTurn();
  for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = fixture.calls.length;
    t.mock.timers.tick(delay - 1); await nextTurn(); assert.equal(fixture.calls.length, before);
    t.mock.timers.tick(1); await nextTurn(); assert.equal(fixture.calls.length, before + 1);
  }
});

test('unresponsive sockets are refreshed and initial readiness has a bounded deadline', async t => {
  await t.test('heartbeat', async sub => {
    timers(sub);
    const { socket, statuses } = await running(sub); socket.autoPong = false;
    sub.mock.timers.tick(30_000); assert.equal(socket.pings, 1);
    sub.mock.timers.tick(30_000); await nextTurn();
    assert.equal(socket.terminated, 1); assert.deepEqual(statuses, ['ready', 'reconnecting']);
  });
  await t.test('startup deadline', async sub => {
    timers(sub);
    const { value, fixture } = await transport(sub);
    const statuses: string[] = [];
    const rejected = assert.rejects(value.start(async () => {}, status => statuses.push(status)), /did not become ready/);
    await nextTurn(); fixture.sockets[0].open();
    sub.mock.timers.tick(10_000); await nextTurn(); assert.equal(fixture.sockets[0].terminated, 1);
    sub.mock.timers.tick(500); await nextTurn(); assert.equal(fixture.sockets.length, 2);
    sub.mock.timers.tick(19_500); await rejected;
    assert.equal(statuses.at(-1), 'failed');
    assert.equal(fixture.sockets[1].terminated, 1);
    const count = fixture.calls.length; sub.mock.timers.tick(120_000); await nextTurn(); assert.equal(fixture.calls.length, count);
  });
});

test('stop cancels a pending start and a retired socket cannot deliver to a later start', async t => {
  timers(t);
  const { value, fixture } = await transport(t);
  const statuses: string[] = []; const received: ChatMessage[] = [];
  const first = value.start(async message => { received.push(message); }, status => statuses.push(status));
  const rejected = assert.rejects(first, /cancelled/);
  assert.equal(value.start(async () => {}, () => {}), first, 'concurrent starts share one connection');
  await nextTurn();
  const old = fixture.sockets[0]; const lateMessage = old.listeners('message')[0]; const lateError = old.listeners('error')[0];
  await value.stop(); await rejected;
  lateMessage(Buffer.from(JSON.stringify({ type: 'hello' })), false); lateError(new Error(config.app_token));
  assert.equal(statuses.length, 0); assert.equal(old.acks.length, 0);
  const restarting = value.start(async message => { received.push(message); }, status => statuses.push(status));
  await nextTurn(); const next = fixture.sockets[1]; next.open(); next.hello(); await restarting;
  lateMessage(Buffer.from(JSON.stringify(event())), false);
  next.frame(event()); await nextTurn(); assert.equal(received.length, 1); assert.deepEqual(statuses, ['ready']);
});

test('stop drops queued deliveries without waiting for an unabortable already-running receiver', async t => {
  const blocked = gate(); const received: ChatMessage[] = [];
  const { value, socket, statuses } = await running(t, new Fixture(), async message => { received.push(message); await blocked.promise; });
  socket.frame(event()); socket.frame(event({ ts: '1712320422.000201' })); await nextTurn();
  assert.equal(received.length, 1); assert.equal(socket.acks.length, 2);
  const lateMessage = socket.listeners('message')[0];
  await value.stop();
  lateMessage(Buffer.from(JSON.stringify(event({ ts: '1712320422.000202' }))), false);
  blocked.resolve(); await nextTurn();
  assert.equal(received.length, 1); assert.deepEqual(statuses, ['ready']);
  await assert.rejects(value.openThread('stopped'), /transport is stopped/);
});

test('stop aborts a pending fresh connection request and ignores its late result', async t => {
  timers(t);
  const { value, fixture, socket, statuses } = await running(t);
  const pending = gate<Response>();
  fixture.override = call => call.method === 'apps.connections.open' ? pending.promise : undefined;
  socket.emit('close'); await nextTurn(); t.mock.timers.tick(500); await nextTurn();
  const request = fixture.calls.at(-1)!; assert.equal(request.method, 'apps.connections.open');
  await value.stop(); assert.equal(request.init.signal?.aborted, true);
  pending.resolve(json({ ok: true, url: 'wss://wss-backup.slack.com/link/?ticket=late' })); await nextTurn();
  t.mock.timers.tick(120_000); await nextTurn();
  assert.equal(fixture.sockets.length, 1); assert.deepEqual(statuses, ['ready', 'reconnecting']);
});

test('post concurrency is bounded and stop aborts outstanding requests', async t => {
  const { value, fixture } = await transport(t);
  const pending = gate<Response>();
  fixture.override = call => call.method === 'chat.postMessage' ? pending.promise : undefined;
  const posts = Array.from({ length: 4 }, () => value.openThread('session'));
  const rejected = posts.map(post => assert.rejects(post, /operation cancelled/));
  await assert.rejects(value.openThread('excess'), /request capacity reached/);
  assert.equal(fixture.calls.filter(call => call.method === 'chat.postMessage').length, 4);
  await value.stop(); await Promise.all(rejected);
  for (const call of fixture.calls.filter(call => call.method === 'chat.postMessage')) assert.equal(call.init.signal?.aborted, true);
  pending.resolve(json({ ok: true, channel: config.channel_id, ts: reply }));
});

test('unflushed ACK buffers are bounded by reconnecting instead of retaining unbounded send callbacks', async t => {
  timers(t);
  const { socket, statuses } = await running(t); socket.holdAcks = true;
  for (let index = 0; index < 200; index++) socket.frame({ type: 'interactive', envelope_id: `ack-${index}`, payload: {} });
  assert.equal(socket.acks.length, 128); assert.equal(socket.terminated, 1);
  await nextTurn(); assert.deepEqual(statuses, ['ready', 'reconnecting']);
  for (const callback of socket.ackCallbacks) callback(new Error(config.app_token));
  await nextTurn(); assert.deepEqual(statuses, ['ready', 'reconnecting']);
});

test('oversized websocket frames retire the connection without dispatch', async t => {
  timers(t);
  const { socket, received, statuses } = await running(t);
  socket.emit('message', Buffer.alloc(256 * 1024 + 1, 32), false);
  await nextTurn(); assert.equal(socket.terminated, 1); assert.equal(received.length, 0); assert.deepEqual(statuses, ['ready', 'reconnecting']);
});

test('real ws client handles Slack hello, ACK and shutdown against a local protocol fixture', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const fixture = new Fixture(); const received: ChatMessage[] = [];
  const value: ChatTransport = await createSlackTransportWithClient(config, {
    fetch: fixture.client.fetch,
    webSocket: (_officialUrl, options) => new WebSocket(`ws://127.0.0.1:${address.port}`, options),
  });
  t.after(() => value.stop());
  const connected = once(server, 'connection');
  const opening = value.start(async message => { received.push(message); }, () => {});
  const [socket] = await connected as [WebSocket];
  socket.send(JSON.stringify({ type: 'hello', connection_info: { app_id: 'A01234567' }, num_connections: 1 }));
  await opening;
  const acknowledged = once(socket, 'message'); const envelope = event(); socket.send(JSON.stringify(envelope));
  const [data] = await acknowledged;
  assert.deepEqual(JSON.parse(String(data)), { envelope_id: envelope.envelope_id });
  await nextTurn(); assert.equal(received.length, 1);
  await value.stop();
});
