import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ChatService } from '../src/chat-service.js';
import { type ChatLocation, type ChatMessage, type ChatTransport, type SlackConfig, type TelegramConfig } from '../src/chat-transport.js';
import { NootifyClient } from '../src/client.js';
import { EventLog } from '../src/events.js';
import { GitHubAuth } from '../src/github-auth.js';
import { PullRequestsService } from '../src/github.js';
import { createServiceHost } from '../src/server.js';
import { SettingsService } from '../src/settings.js';
import { State } from '../src/state.js';
import { SessionUnavailable, type Adapter } from '../src/types.js';

const slackConfig: SlackConfig = { bot_token: 'xoxb-secret', app_token: 'xapp-secret', channel_id: 'C123', user_id: 'U123' };
const telegramConfig: TelegramConfig = { bot_token: '123:secret', chat_id: '-100123', user_id: '123' };
class FakeTransport implements ChatTransport {
  readonly account = 'fixture-account';
  receive: (message: ChatMessage) => Promise<void> = async () => {};
  opened = 0; stopped = false;
  readonly sent: { location: ChatLocation; text: string; reply?: string }[] = [];
  constructor(readonly identity: string, readonly room: string) {}
  async start(receive: (message: ChatMessage) => Promise<void>, status: (status: 'ready') => void): Promise<void> { this.receive = receive; status('ready'); }
  async stop(): Promise<void> { this.stopped = true; }
  async openThread(): Promise<ChatLocation> { return { chat_id: this.room, thread_id: String(++this.opened) }; }
  async send(location: ChatLocation, text: string, reply?: string) { this.sent.push({ location: { chat_id: location.chat_id, thread_id: location.thread_id }, text, reply }); return { message_id: `sent-${this.sent.length}` }; }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-channels-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await State.open(directory);
  const delivered: { id: string; content: string; adapter?: Adapter }[] = [];
  let unavailable = false;
  const sessions = { send: async (id: string, content: string, adapter?: Adapter) => {
    if (unavailable) throw new SessionUnavailable('session_archived');
    delivered.push({ id, content, adapter }); return { status: 'socket_written' as const };
  } };
  const slackTransports: FakeTransport[] = []; const telegramTransports: FakeTransport[] = [];
  let fail = false;
  const slackFactory = async (config: SlackConfig) => {
    if (fail) throw new Error('https://example.invalid/xoxb-private-secret');
    const transport = new FakeTransport(`workspace:${config.bot_token}:${config.channel_id}`, config.channel_id); slackTransports.push(transport); return transport;
  };
  const telegramFactory = async (config: TelegramConfig) => {
    const transport = new FakeTransport(`bot:${config.chat_id}`, config.chat_id); telegramTransports.push(transport); return transport;
  };
  const reports: Record<string, unknown>[] = [];
  const slack = new ChatService('slack', state, sessions, slackFactory, record => reports.push(record));
  const telegram = new ChatService('telegram', state, sessions, telegramFactory, record => reports.push(record));
  await slack.start(); await telegram.start();
  t.after(async () => { await slack.stop(); await telegram.stop(); });
  return { directory, state, sessions, slack, telegram, slackFactory, telegramFactory, slackTransports, telegramTransports, delivered, reports,
    fail: (value: boolean) => { fail = value; }, unavailable: () => { unavailable = true; } };
}
const incoming = (location: ChatLocation, sender = 'U123', message = '9'): ChatMessage => ({ ...location, message_id: message, sender_id: sender, text: 'Continue the task' });

test('legacy state defaults to Feishu and channel settings never expose tokens', async t => {
  const f = await fixture(t);
  assert.equal(f.state.settings.notification_channel, undefined);
  assert.equal(f.slack.page().configured, false);
  await f.slack.configure(slackConfig);
  assert.equal(f.slack.page().status, 'ready');
  assert.equal(f.slack.page().chat_id, 'C123');
  assert.ok(!JSON.stringify(f.slack.page()).includes('secret'));
  assert.ok(!JSON.stringify(f.reports).includes('secret'));
  assert.deepEqual((await State.open(f.directory)).settings.slack, slackConfig);
});

test('verification failures keep the working connection and never expose credentials', async t => {
  const f = await fixture(t); await f.slack.configure(slackConfig);
  const current = f.slackTransports[0]; f.fail(true);
  await assert.rejects(f.slack.configure({ ...slackConfig, bot_token: 'xoxb-other' }), /Slack verification failed/);
  assert.equal(current.stopped, false); assert.deepEqual(f.state.settings.slack, slackConfig);
  assert.equal(f.slack.status(), 'ready');
  await assert.rejects(f.slack.configure({ ...slackConfig, user_id: '' }), /Invalid Slack/);
});

test('a saved configuration retries a failed initial connection and stops retrying when cleared', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const service = new ChatService('slack', f.state, f.sessions, async () => {
    const transport = new FakeTransport('workspace:bot:C123', 'C123');
    if (++attempts === 1) transport.start = async () => { throw new Error('connection unavailable'); };
    return transport;
  });
  t.after(() => service.stop());
  await service.start();
  await assert.rejects(service.configure(slackConfig), /settings were saved and will retry/);
  assert.equal(service.status(), 'failed');
  assert.deepEqual(f.state.settings.slack, slackConfig);
  t.mock.timers.tick(30000);
  await new Promise<void>(done => setImmediate(done));
  assert.equal(attempts, 2); assert.equal(service.status(), 'ready');
  await service.configure(undefined);
  t.mock.timers.tick(60000);
  await new Promise<void>(done => setImmediate(done));
  assert.equal(attempts, 2); assert.equal(service.status(), 'disabled');
});

test('concurrent opens share one remote thread and provider IDs cannot collide', async t => {
  const f = await fixture(t); await f.slack.configure(slackConfig); await f.telegram.configure(telegramConfig);
  const [one, duplicate] = await Promise.all([f.slack.open('claude-desktop', 'local_session', 'Task'), f.slack.open('claude-desktop', 'local_session', 'Task')]);
  assert.deepEqual(one, duplicate); assert.equal(f.slackTransports[0].opened, 1);
  const other = await f.telegram.open('claude-desktop', 'local_session', 'Task');
  assert.equal(one.thread_id, other.thread_id); assert.equal(f.state.chatBindings.size, 2);
  const slack = f.slackTransports[0]; const telegram = f.telegramTransports[0];
  await slack.receive(incoming({ chat_id: one.chat_id, thread_id: one.thread_id! }));
  await telegram.receive(incoming({ chat_id: other.chat_id, thread_id: other.thread_id! }, '123'));
  assert.equal(f.delivered.length, 2); assert.equal(f.state.chatDeliveries.size, 2);
  assert.match(f.delivered[0].content, /来自Slack用户/); assert.match(f.delivered[1].content, /来自Telegram用户/);
  assert.ok([...f.state.chatDeliveries.values()].every(delivery => delivery.transport_status === 'socket_written'));
});

test('only the trusted user and exact bound thread can reach the exact session', async t => {
  const f = await fixture(t); await f.slack.configure(slackConfig);
  const thread = await f.slack.open('codex', 'codex_session', 'Task');
  const location = { chat_id: thread.chat_id, thread_id: thread.thread_id! }; const transport = f.slackTransports[0];
  await transport.receive(incoming(location, 'U999'));
  await transport.receive(incoming({ ...location, thread_id: 'unbound' }));
  await transport.receive(incoming({ ...location, chat_id: 'C999' }));
  assert.equal(f.delivered.length, 0);
  await transport.receive(incoming(location)); await transport.receive(incoming(location));
  assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].adapter, 'codex'); assert.equal(f.delivered[0].id, 'codex_session');
  assert.match(f.delivered[0].content, /chat-ack/); assert.match(f.delivered[0].content, /chat-reply/);
  assert.ok(!f.delivered[0].content.includes(f.state.token));
});

test('persisted deliveries deduplicate retries and reply to the original topic after restart', async t => {
  const f = await fixture(t); await f.telegram.configure(telegramConfig);
  const thread = await f.telegram.open('opencode', 'ses_fixture', 'Task');
  const message = incoming({ chat_id: thread.chat_id, thread_id: thread.thread_id! }, '123', '42');
  await f.telegramTransports[0].receive(message); await f.telegram.stop();
  const state = await State.open(f.directory); const transport = new FakeTransport('bot:-100123', '-100123');
  const restarted = new ChatService('telegram', state, f.sessions, async () => transport); t.after(() => restarted.stop()); await restarted.start();
  await transport.receive(message); assert.equal(f.delivered.length, 1);
  const id = [...state.chatDeliveries.keys()][0];
  await Promise.all([restarted.reply(id, 'Done'), restarted.reply(id, 'Done')]);
  assert.equal(transport.sent.length, 1);
  assert.deepEqual(transport.sent[0], { location: { chat_id: '-100123', thread_id: '1' }, text: '[Task] Done', reply: '42' });
  assert.ok(state.chatDeliveries.get(id)?.acknowledged_at);
  assert.equal((await State.open(f.directory)).chatDeliveries.get(id)?.replies.length, 1);
  assert.ok(!await readFile(join(f.directory, 'state.json'), 'utf8').then(value => value.includes('Continue the task')));
});

test('changing bot identity or recipient blocks stale replies and late callbacks', async t => {
  const f = await fixture(t); await f.slack.configure(slackConfig);
  const thread = await f.slack.open('claude-code', 'session', 'Task'); const old = f.slackTransports[0];
  await old.receive(incoming({ chat_id: thread.chat_id, thread_id: thread.thread_id! }));
  const id = [...f.state.chatDeliveries.keys()][0];
  await f.slack.configure({ ...slackConfig, bot_token: 'xoxb-second' });
  assert.equal(old.stopped, true); await assert.rejects(f.slack.reply(id, 'Wrong account'), /account or trusted user has changed/);
  await old.receive(incoming({ chat_id: thread.chat_id, thread_id: thread.thread_id! }, 'U123', '10'));
  assert.equal(f.delivered.length, 1);
  await f.slack.configure(undefined); assert.equal(f.slack.status(), 'disabled'); assert.equal(f.state.settings.slack, undefined);
  await assert.rejects(f.slack.send('session', 'Progress'), /not connected/);
});

test('archived sessions stay archived and cannot acknowledge or reply to an undelivered message', async t => {
  const f = await fixture(t); await f.slack.configure(slackConfig);
  const thread = await f.slack.open('claude-desktop', 'local_archived', 'Archived'); f.unavailable();
  await f.slackTransports[0].receive(incoming({ chat_id: thread.chat_id, thread_id: thread.thread_id! }));
  const id = [...f.state.chatDeliveries.keys()][0]; assert.equal(f.state.chatDeliveries.get(id)?.transport_status, 'ignored');
  await assert.rejects(f.slack.acknowledge(id), /not delivered/); await assert.rejects(f.slack.reply(id, 'No'), /not delivered/);
});

test('control APIs dispatch explicit and default channels, while legacy requests fall through to Feishu', async t => {
  const f = await fixture(t); await f.slack.configure(slackConfig);
  const server = createServiceHost([f.slack, f.telegram, { name: 'lark', status: () => 'ready', handle: async request => request.path === '/v1/threads' ? { body: { channel: 'feishu' } } : undefined }], f.state.token);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const client = new NootifyClient({ token: f.state.token, baseUrl });
  assert.equal((await client.openThread({ adapter: 'claude-code', session_id: 'session', session_name: 'Task' })).channel, 'feishu');
  const thread = await client.openThread({ adapter: 'claude-code', session_id: 'session', session_name: 'Task', channel: 'slack' });
  assert.equal(thread.channel, 'slack'); f.state.settings.notification_channel = 'slack';
  assert.equal((await client.sendThread('session', 'Progress', 'claude-code')).channel, 'slack');
  await f.slackTransports[0].receive(incoming({ chat_id: thread.chat_id, thread_id: thread.thread_id! }));
  const id = [...f.state.chatDeliveries.keys()][0]; await client.acknowledgeChat(id); assert.equal((await client.replyChat(id, 'Complete')).status, 'replied');
  const unauthorized = await fetch(`${baseUrl}/v1/chat/messages/${id}/ack`, { method: 'POST', body: '{}' }); assert.equal(unauthorized.status, 401);
});

test('recipient lookups retain saved credentials without reconfiguring and reject stale configuration', async t => {
  const f = await fixture(t); await f.telegram.configure(telegramConfig);
  Object.assign(f.telegramTransports[0], { directoryTargets: () => ({ users: [{ id: '456', name: 'Known user' }], chats: [], limited: true }) });
  const settings = new SettingsService({ state: f.state, slack: f.slack, telegram: f.telegram,
    lark: { status: () => 'disabled', channel: () => ({ groups: 0 }), configure: async () => {} },
    github: new GitHubAuth(f.state), pulls: new PullRequestsService(f.directory), agents: { list: async () => [], set: async () => { throw new Error('unused'); } }, env: {} });
  let replace = false;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request): Promise<Response> => {
    assert.ok(String(url).startsWith('https://api.telegram.org/bot123:secret/'));
    if (String(url).endsWith('/getChat')) return Response.json({ ok: true, result: { id: -100123, type: 'supergroup', is_forum: true, title: 'Forum' } });
    assert.ok(String(url).endsWith('/getChatAdministrators'));
    if (replace) f.state.settings.telegram = { ...telegramConfig, user_id: '789' };
    return Response.json({ ok: true, result: [{ status: 'creator', user: { id: 123, is_bot: false, first_name: 'Admin' } }] });
  });
  const page = await settings.chatDirectory('telegram', { bot_token: '', chat_id: '', user_id: '' });
  assert.deepEqual(page.users, [{ id: '456', name: 'Known user' }, { id: '123', name: 'Admin' }]);
  assert.deepEqual(f.state.settings.telegram, telegramConfig);
  assert.equal(f.telegramTransports.length, 1, 'listing never replaces the receiver');
  replace = true;
  await assert.rejects(settings.chatDirectory('telegram', {}), /configuration changed/);
});

test('settings verify before saving, redact tokens, block remote edits and export private channel configuration', async t => {
  const f = await fixture(t);
  const settings = new SettingsService({ state: f.state, slack: f.slack, telegram: f.telegram,
    lark: { status: () => 'disabled', channel: () => ({ groups: 0 }), configure: async () => {} },
    github: new GitHubAuth(f.state), pulls: new PullRequestsService(f.directory), agents: { list: async () => [], set: async () => { throw new Error('unused'); } }, env: {} });
  t.after(() => settings.stop());
  await assert.rejects(settings.setNotificationChannel('slack'), /Configure/);
  await settings.saveChat('slack', slackConfig); await settings.setNotificationChannel('slack');
  await settings.saveChat('slack', { ...slackConfig, bot_token: '', app_token: '' }); assert.deepEqual(f.state.settings.slack, slackConfig);
  const page = await settings.page(); assert.equal(page.notification_channel, 'slack'); assert.ok(!JSON.stringify(page).includes('secret'));
  const exported = await settings.exportConfig(); const document = JSON.parse(await readFile(exported.path, 'utf8'));
  assert.deepEqual(document.slack, slackConfig); assert.deepEqual(exported.summary.slack, { chat_id: 'C123', user_id: 'U123' });
  assert.ok(!JSON.stringify(exported.summary).includes('secret'));
  assert.deepEqual(settings.chatSecret('slack', 'bot_token'), { secret: slackConfig.bot_token });
  assert.deepEqual(settings.chatSecret('slack', 'app_token'), { secret: slackConfig.app_token });
  await settings.saveChat('telegram', telegramConfig);
  assert.deepEqual(settings.chatSecret('telegram', 'bot_token'), { secret: telegramConfig.bot_token });
  assert.throws(() => settings.chatSecret('telegram', 'app_token'), /Invalid secret field/);
  assert.throws(() => settings.chatSecret('slack', 'user_id'), /Invalid secret field/);
  await assert.rejects(settings.previewImport({ ...document, telegram: { bot_token: 'invalid' } }), /Invalid Telegram/);
  const logs = await EventLog.open(f.directory);
  for (const via of ['loopback', 'tailnet'] as const) {
    const server = createServiceHost([], f.state.token, logs, { settings, via, ...(via === 'tailnet' ? { tailnet: { authorize: async () => undefined, url: () => undefined } as never } : {}) });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const secret = await fetch(base + '/ui/api/settings/slack/secret', { method: 'POST', headers: { 'x-nootify-ui': '1', 'content-type': 'application/json' }, body: JSON.stringify({ field: 'bot_token' }) });
    assert.equal(secret.status, via === 'tailnet' ? 403 : 200);
    if (via === 'loopback') {
      assert.deepEqual(await secret.json(), { secret: slackConfig.bot_token });
      assert.equal(secret.headers.get('cache-control'), 'no-store');
      assert.equal((await fetch(base + '/ui/api/settings/slack/secret', { method: 'POST', body: '{}' })).status, 403);
    }
    const recipients = await fetch(base + '/ui/api/settings/telegram/recipients', { method: 'POST', headers: { 'x-nootify-ui': '1', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(recipients.status, via === 'tailnet' ? 403 : 400);
    const response = await fetch(base + '/ui/api/settings/slack', { method: 'POST', headers: { 'x-nootify-ui': '1', 'content-type': 'application/json' }, body: JSON.stringify({ clear: true }) });
    assert.equal(response.status, via === 'tailnet' ? 403 : 200);
  }
});
