import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createSocketServer, type AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NootifyClient } from '../src/client.js';
import { ChatService } from '../src/chat-service.js';
import type { ChatLocation, ChatMessage, ChatTransport } from '../src/chat-transport.js';
import { LarkService } from '../src/lark.js';
import type { LarkApi } from '../src/lark-metadata.js';
import { registerPolledSession } from '../src/polled-sessions.js';
import { createServiceHost } from '../src/server.js';
import { SessionsService } from '../src/sessions.js';
import { State } from '../src/state.js';
import { StateDatabase, type StateRows } from '../src/state-database.js';
import type { PolledAdapter, SessionInbox, ThreadInfo } from '../src/types.js';
import { sessionInbox } from '../src/polled-sessions.js';
import { assertMode, inboxPath } from './platform-fixtures.js';

const execute = promisify(execFile);
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-polled-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await State.open(directory);
  const forwarding: { port: number; command?: string[] } = { port: 0 };
  const sessions = new SessionsService(state, { inspect: async () => { throw new Error('Must not resolve a polled client through Claude'); } }, () => {},
    { resolve: async () => { throw new Error('Must not query a native backend'); }, close() {} }, forwarding);
  const server = createServiceHost([sessions], state.token);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as AddressInfo).port; forwarding.port = port;
  const client = new NootifyClient({ baseUrl: `http://127.0.0.1:${port}`, token: state.token });
  return { directory, state, sessions, server, client, port, forwarding };
}

for (const adapter of ['trae', 'workbuddy'] as const) {
  test(`${adapter}: private inbox survives restart, is session-scoped, and retains input until explicit acknowledgment`, async t => {
    const f = await fixture(t);
    await registerPolledSession(f.state, adapter, 'conversation-one', 'First task');
    await registerPolledSession(f.state, adapter, 'conversation-two', 'Second task');
    const other = adapter === 'trae' ? 'workbuddy' : 'trae';
    await assert.rejects(f.client.sendMessage('conversation-one', 'Wrong adapter', other), /session_not_local/);
    await assert.rejects(f.client.sendMessage('missing', 'Unknown', adapter), /session_not_local/);
    assert.deepEqual(await f.client.sendMessage('conversation-one', 'User input', adapter), { status: 'inbox_queued' });
    const pending = await f.client.receiveThread('conversation-one', adapter);
    assert.equal(pending.messages.length, 1);
    assert.match(pending.messages[0].text, /\[Nootify: First task\]\nUser input/);
    assert.deepEqual(await f.client.receiveThread('conversation-one', adapter), pending, 'reading does not consume the message');
    assert.deepEqual((await f.client.receiveThread('conversation-two', adapter)).messages, []);
    await assert.rejects(f.client.receiveThread('conversation-one', other), /session_not_local/);
    const id = pending.messages[0].id;
    await assert.rejects(f.client.acknowledgeThread('conversation-two', adapter, id), /No inbox message/);
    assert.equal((await State.open(f.directory)).inboxMessages.get(id)?.text, pending.messages[0].text);
    await assertMode(join(f.directory, 'state.sqlite'), 0o600);
    await f.client.acknowledgeThread('conversation-one', adapter, id);
    await f.client.acknowledgeThread('conversation-one', adapter, id);
    assert.deepEqual((await f.client.receiveThread('conversation-one', adapter)).messages, []);
    assert.equal((await State.open(f.directory)).inboxMessages.size, 0);
    await assert.rejects(f.client.registerSession('conversation-one', { adapter: other, session_name: 'Must not overwrite' }), /another adapter/);
    assert.ok(!(JSON.stringify(await f.client.listSessions())).includes('User input'), 'public session history omits inbox text');
    assert.equal(f.state.session('conversation-one').host_id, hostname());
    assert.equal((await fetch(`http://127.0.0.1:${f.port}/v1/sessions/conversation-one/inbox`, { method: 'POST', body: JSON.stringify({ adapter }) })).status, 401);
  });
}

for (const adapter of ['trae', 'workbuddy'] as const) {
  test(`${adapter}: registration cannot be overwritten by a concurrent Claude socket validation`, async t => {
    const f = await fixture(t); const id = 'registration-race';
    const socket_path = inboxPath(f.directory);
    const socket = createSocketServer(connection => connection.end());
    socket.listen(socket_path); await once(socket, 'listening'); t.after(() => socket.close());
    // handle() reaches its async socket validation before the polled registration is queued.
    const request = f.sessions.handle({ method: 'PUT', path: `/v1/sessions/${id}`,
      body: { adapter: 'claude-code', session_name: 'Native registration', socket_path } });
    const refused = assert.rejects(request, /another adapter/);
    await registerPolledSession(f.state, adapter, id, 'Polled task');
    await refused;
    assert.equal(f.state.session(id).adapter, adapter);
    assert.equal((await State.open(f.directory)).session(id).adapter, adapter);
    await f.sessions.send(id, 'Input still reaches the polled conversation', adapter);
    assert.match((await f.client.receiveThread(id, adapter)).messages[0].text, /still reaches the polled conversation/);
  });
}

test('inboxes enforce message and queue limits without dropping older input', async t => {
  const f = await fixture(t); await registerPolledSession(f.state, 'trae', 'bounded', 'Task');
  await assert.rejects(f.sessions.send('bounded', 'x'.repeat(64000), 'trae'), /64,000 bytes/);
  for (let index = 0; index < 100; index++) await f.sessions.send('bounded', `message-${index}`, 'trae');
  await assert.rejects(f.sessions.send('bounded', 'overflow', 'trae'), /inbox is full/);
  const batch = await f.client.receiveThread('bounded', 'trae'); assert.equal(batch.messages.length, 20);
  assert.match(batch.messages[0].text, /message-0$/); assert.match(batch.messages.at(-1)!.text, /message-19$/);
  for (const message of batch.messages) await f.client.acknowledgeThread('bounded', 'trae', message.id);
  assert.match((await f.client.receiveThread('bounded', 'trae')).messages[0].text, /message-20$/);
});

test('a failed inbox acknowledgment is rolled back before an overlapping save takes its snapshot', async t => {
  const f = await fixture(t);
  await registerPolledSession(f.state, 'trae', 'atomic-ack', 'Task');
  await f.sessions.send('atomic-ack', 'Keep this input', 'trae');
  const message = (await f.client.receiveThread('atomic-ack', 'trae')).messages[0];
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const write = StateDatabase.prototype.write; let fail = true;
  t.mock.method(StateDatabase.prototype, 'write', async function (this: StateDatabase, rows: StateRows) {
    if (fail && this.path === join(f.directory, 'state.sqlite')) {
      fail = false; entered(); await gate; throw new Error('Injected state transaction failure');
    }
    return write.call(this, rows);
  });
  const acknowledgment = f.client.acknowledgeThread('atomic-ack', 'trae', message.id);
  await started;
  f.state.settings.notification_channel = 'slack';
  const overlapping = f.state.save();
  const failed = assert.rejects(acknowledgment, /Injected state transaction failure/);
  release(); await failed; await overlapping;
  assert.ok(f.state.inboxMessages.has(message.id));
  const restored = await State.open(f.directory);
  assert.ok(restored.inboxMessages.has(message.id), 'a failed ACK must retain input after restart');
  assert.equal(restored.settings.notification_channel, 'slack');
});

class FakeTransport implements ChatTransport {
  readonly identity = 'fixture-bot'; readonly account = 'Test bot';
  receive: (message: ChatMessage) => Promise<void> = async () => {};
  opened = 0;
  sent: { text: string; reply?: string }[] = [];
  async start(receive: (message: ChatMessage) => Promise<void>, status: (status: 'ready') => void) { this.receive = receive; status('ready'); }
  async stop() {}
  async openThread(): Promise<ChatLocation> { return { chat_id: 'fixture-room', thread_id: String(++this.opened) }; }
  async send(_location: ChatLocation, text: string, reply?: string) { this.sent.push({ text, reply }); return { message_id: `sent-${this.sent.length}` }; }
}

for (const channel of ['slack', 'telegram'] as const) {
  test(`${channel}: progress and replies reach the polled conversation through the existing transport`, async t => {
    const f = await fixture(t); const transport = new FakeTransport();
    const service = new ChatService(channel, f.state, f.sessions, async () => transport);
    t.after(() => service.stop());
    await service.configure(channel === 'slack' ? { bot_token: 'xoxb-fixture', app_token: 'xapp-fixture', channel_id: 'C123', user_id: 'U123' }
      : { bot_token: '123:fixture', chat_id: '-100123', user_id: '123' });
    for (const adapter of ['trae', 'workbuddy'] as const) {
      const id = `${channel}-${adapter}`;
      const thread = await service.open(adapter, id, `${adapter} task`);
      await service.send(id, 'Progress', adapter);
      const incoming: ChatMessage = { chat_id: thread.chat_id, thread_id: thread.thread_id!, message_id: `${adapter}-message`,
        sender_id: channel === 'slack' ? 'U123' : '123', text: 'Continue here' };
      await transport.receive({ ...incoming, sender_id: 'untrusted' });
      assert.equal((await f.client.receiveThread(id, adapter)).messages.length, 0);
      await transport.receive(incoming); await transport.receive(incoming);
      const messages = (await f.client.receiveThread(id, adapter)).messages;
      assert.equal(messages.length, 1); assert.match(messages[0].text, /Continue here/); assert.match(messages[0].text, /chat-reply/);
      const delivery = [...f.state.chatDeliveries.values()].find(delivery => delivery.session_id === id)!;
      assert.equal(delivery.transport_status, 'inbox_queued');
      await service.acknowledge(delivery.id); await service.reply(delivery.id, 'Done');
      assert.equal(transport.sent.at(-1)?.reply, incoming.message_id);
      await f.client.acknowledgeThread(id, adapter, messages[0].id);
    }
  });

  test(`${channel}: unread source contexts survive ledger eviction and restart, with commands regenerated for the current installation`, async t => {
    const f = await fixture(t); f.forwarding.command = ['/Old Nootify/node', '/Old Nootify/cli.js'];
    const transport = new FakeTransport();
    const original = new ChatService(channel, f.state, f.sessions, async () => transport, () => {}, 9999);
    await original.configure(channel === 'slack' ? { bot_token: 'xoxb-fixture', app_token: 'xapp-fixture', channel_id: 'C123', user_id: 'U123' }
      : { bot_token: '123:fixture', chat_id: '-100123', user_id: '123' });
    const thread = await original.open('trae', 'retained-source', 'Retained task');
    const incoming: ChatMessage = { chat_id: thread.chat_id, thread_id: thread.thread_id!, message_id: 'original-provider-id',
      sender_id: channel === 'slack' ? 'U123' : '123', text: 'Original unread user text' };
    await transport.receive(incoming);
    const delivery = [...f.state.chatDeliveries.values()][0];
    for (let index = 0; index < 1999; index++) {
      const id = `newer-${index}`;
      f.state.chatDeliveries.set(id, { ...delivery, id, message_id: id, transport_status: 'input_accepted', replies: [] });
    }
    await transport.receive({ ...incoming, message_id: 'trigger-eviction', text: 'A later message' });
    assert.equal(f.state.chatDeliveries.has(delivery.id), false, 'the bounded main ledger evicted the original entry');
    await original.stop();
    const state = await State.open(f.directory); const nextTransport = new FakeTransport();
    const runtime = { port: 0, command: [process.execPath, fileURLToPath(new URL('../src/cli.js', import.meta.url))] };
    const sessions = new SessionsService(state, undefined, () => {}, undefined, runtime);
    const service = new ChatService(channel, state, sessions, async () => nextTransport);
    await service.start(); t.after(async () => { await service.stop(); await sessions.stop(); });
    const server = createServiceHost([sessions, service], state.token); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); }); runtime.port = (server.address() as AddressInfo).port;
    const client = new NootifyClient({ baseUrl: `http://127.0.0.1:${runtime.port}`, token: state.token });
    await nextTransport.receive(incoming);
    const pending = await client.receiveThread('retained-source', 'trae');
    assert.equal(pending.messages.length, 2, 'the original provider message is still deduplicated');
    const message = pending.messages.find(message => message.text.includes('Original unread user text'))!;
    assert.match(message.text, new RegExp(`--port ${runtime.port} `));
    assert.ok(!message.text.includes('/Old Nootify/')); assert.ok(!message.text.includes('--port 9999 '));
    assert.ok(message.text.includes(runtime.command[1]));
    assert.match(message.text, new RegExp(`--message-id '${delivery.id}'`));
    assert.ok(!JSON.stringify(pending).includes('xoxb-fixture'));
    await client.acknowledgeChat(delivery.id);
    await client.replyChat(delivery.id, 'Reply to retained source');
    await client.replyChat(delivery.id, 'Reply to retained source');
    assert.equal(nextTransport.sent.length, 1); assert.equal(nextTransport.sent[0].reply, incoming.message_id);
    assert.equal((await State.open(f.directory)).chatDelivery(delivery.id)?.replies.length, 1);
    await client.acknowledgeThread('retained-source', 'trae', message.id);
    assert.equal(state.chatDelivery(delivery.id), undefined, 'consumption releases the retained context');
  });

  test(`${channel}: reopening after a hostname change restores retained inbox messages without creating another thread`, async t => {
    const f = await fixture(t); const originalTransport = new FakeTransport();
    const original = new ChatService(channel, f.state, f.sessions, async () => originalTransport);
    await original.configure(channel === 'slack' ? { bot_token: 'xoxb-fixture', app_token: 'xapp-fixture', channel_id: 'C123', user_id: 'U123' }
      : { bot_token: '123:fixture', chat_id: '-100123', user_id: '123' });
    const prior = new Map<PolledAdapter, ThreadInfo>();
    for (const adapter of ['trae', 'workbuddy'] as const) {
      const id = `renamed-${adapter}`;
      prior.set(adapter, await original.open(adapter, id, `${adapter} task`));
      await f.sessions.send(id, 'Retained before the hostname change', adapter);
      f.state.sessions.get(id)!.host_id = 'previous-mac-hostname';
    }
    await f.state.save(); await original.stop();
    const state = await State.open(f.directory); const transport = new FakeTransport();
    const sessions = new SessionsService(state);
    const restarted = new ChatService(channel, state, sessions, async () => transport);
    await restarted.start(); t.after(async () => { await restarted.stop(); await sessions.stop(); });
    const server = createServiceHost([sessions, restarted], state.token);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const client = new NootifyClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: state.token });
    for (const adapter of ['trae', 'workbuddy'] as const) {
      const id = `renamed-${adapter}`; const thread = prior.get(adapter)!;
      await assert.rejects(client.receiveThread(id, adapter), /session_not_local/);
      const reopened = await client.openThread({ adapter, session_id: id, session_name: 'Reopen existing task', channel });
      assert.equal(reopened.created, false); assert.equal(reopened.thread_id, thread.thread_id);
      assert.equal(state.session(id).host_id, hostname());
      assert.equal((await State.open(f.directory)).session(id).host_id, hostname());
      const pending = await client.receiveThread(id, adapter);
      assert.equal(pending.messages.length, 1); assert.match(pending.messages[0].text, /Retained before the hostname change/);
      await client.acknowledgeThread(id, adapter, pending.messages[0].id);
      const message: ChatMessage = { chat_id: thread.chat_id, thread_id: thread.thread_id!, message_id: `after-rename-${adapter}`,
        sender_id: channel === 'slack' ? 'U123' : '123', text: 'Reply after reopening' };
      await transport.receive(message);
      assert.match((await client.receiveThread(id, adapter)).messages[0].text, /Reply after reopening/);
    }
    assert.equal(transport.opened, 0, 'existing remote threads are reused');
  });
}

test('failed hostname reconciliation retains the prior registration and queued input', async t => {
  const f = await fixture(t);
  await registerPolledSession(f.state, 'trae', 'retained', 'Original task');
  await f.sessions.send('retained', 'Pending input', 'trae');
  const saved = { ...f.state.session('retained'), host_id: 'previous-mac-hostname' };
  f.state.sessions.set('retained', saved); await f.state.save();
  t.mock.method(f.state, 'save', async () => { throw new Error('Cannot persist registration'); });
  await assert.rejects(registerPolledSession(f.state, 'trae', 'retained', 'Reopened task'), /Cannot persist registration/);
  assert.deepEqual(f.state.session('retained'), saved);
  assert.equal(f.state.inboxMessages.size, 1);
  assert.equal((await State.open(f.directory)).session('retained').host_id, 'previous-mac-hostname');
});

function fakeFeishu() {
  const announcements = new Map<string, string>(); let next = 0;
  const api: LarkApi = { appId: 'cli_fixture', async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const announcement = /\/chats\/([^/]+)\/announcement$/.exec(path);
    if (announcement) {
      if (method === 'GET') return { revision: '1', content: announcements.get(announcement[1]) ?? '' } as T;
      const request = body as { requests: string[] };
      const operation = JSON.parse(request.requests[0]);
      announcements.set(announcement[1], JSON.parse(operation.insertBlocksRequest.payload).blocks[0].paragraph.elements[0].textRun.text);
      return {} as T;
    }
    if (path.startsWith('/open-apis/im/v1/chats?')) return (method === 'GET' ? { items: [], has_more: false } : { chat_id: `oc_${++next}` }) as T;
    if (path.startsWith('/open-apis/im/v1/messages?')) return { message_id: `om_${++next}` } as T;
    throw new Error(`Unexpected ${method} ${path}`);
  } };
  return { api, announcements };
}

test('Feishu announcements route replies into the exact registered Trae and WorkBuddy inbox', async t => {
  const f = await fixture(t); f.state.settings.lark_recipient_open_id = 'ou_owner';
  const { api, announcements } = fakeFeishu();
  const lark = new LarkService(f.state, f.sessions, undefined, () => {}, api);
  for (const adapter of ['trae', 'workbuddy'] as const) {
    const opened = await lark.handle({ method: 'POST', path: '/v1/threads', body: { adapter, session_id: adapter, session_name: `${adapter} task` } });
    const thread = opened!.body as ThreadInfo;
    assert.ok(announcements.get(thread.chat_id)?.includes(`:${adapter}:${adapter}`));
    await lark.handle({ method: 'POST', path: `/v1/threads/${adapter}/messages`, body: { adapter, text: 'Progress' } });
    lark.enqueue({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: { chat_id: thread.chat_id, message_id: `om_${adapter}`,
      message_type: 'text', content: JSON.stringify({ text: `Reply for ${adapter}` }) } });
    await lark.drain();
    const inbox = await f.client.receiveThread(adapter, adapter);
    assert.equal(inbox.messages.length, 1); assert.match(inbox.messages[0].text, new RegExp(`Reply for ${adapter}`));
    assert.match(inbox.messages[0].text, /lark-ack/); assert.match(inbox.messages[0].text, /lark-reply/);
    assert.equal(f.state.deliveries.get(`om_${adapter}`)?.transport_status, 'inbox_queued');
  }
});

test('Feishu unread replies retain their source across eviction/restart and use current callback commands', async t => {
  const f = await fixture(t); f.state.settings.lark_recipient_open_id = 'ou_owner';
  f.forwarding.command = ['/Old Nootify/node', '/Old Nootify/cli.js'];
  const remote = fakeFeishu(); let chat = ''; let replies = 0;
  const api: LarkApi = { appId: remote.api.appId, async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    if (method === 'POST' && /^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/.test(path)) {
      replies++; return { message_id: 'om_reply', chat_id: chat } as T;
    }
    return remote.api.request<T>(method, path, body);
  } };
  const original = new LarkService(f.state, f.sessions, undefined, () => {}, api, 9999);
  const opened = await original.handle({ method: 'POST', path: '/v1/threads', body: { adapter: 'workbuddy', session_id: 'retained-lark', session_name: 'Retained task' } });
  chat = (opened!.body as ThreadInfo).chat_id;
  const incoming = { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: { chat_id: chat, message_id: 'om_retained',
    message_type: 'text', content: JSON.stringify({ text: 'Original unread Feishu text' }) } };
  original.enqueue(incoming); await original.drain();
  const delivery = f.state.deliveries.get('om_retained')!;
  for (let index = 0; index < 1999; index++) {
    const id = `om_newer_${index}`;
    f.state.deliveries.set(id, { ...delivery, message_id: id, transport_status: 'input_accepted', replies: [] });
  }
  original.enqueue({ ...incoming, message: { ...incoming.message, message_id: 'om_trigger', content: JSON.stringify({ text: 'Later Feishu text' }) } });
  await original.drain();
  assert.equal(f.state.deliveries.has('om_retained'), false);
  const state = await State.open(f.directory);
  const runtime = { port: 0, command: [process.execPath, fileURLToPath(new URL('../src/cli.js', import.meta.url))] };
  const sessions = new SessionsService(state, undefined, () => {}, undefined, runtime);
  const lark = new LarkService(state, sessions, undefined, () => {}, api);
  const server = createServiceHost([sessions, lark], state.token); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); }); runtime.port = (server.address() as AddressInfo).port;
  const client = new NootifyClient({ baseUrl: `http://127.0.0.1:${runtime.port}`, token: state.token });
  assert.equal(await lark.enqueue(incoming), true, 'retained source context terminally handles provider retries without another inbox item');
  const pending = await client.receiveThread('retained-lark', 'workbuddy');
  assert.equal(pending.messages.length, 2);
  const message = pending.messages.find(message => message.text.includes('Original unread Feishu text'))!;
  assert.match(message.text, new RegExp(`--port ${runtime.port} `)); assert.ok(!message.text.includes('/Old Nootify/'));
  const relocated = sessionInbox(state, 'workbuddy', 'retained-lark', { port: 9517, command: ['/New Nootify/node', '/New Nootify/cli.js'] });
  assert.ok(relocated.messages[0].text.includes("'/New Nootify/node' '/New Nootify/cli.js' lark-ack"));
  assert.match(relocated.messages[0].text, /--port 9517 /);
  await client.acknowledgeLark('om_retained');
  await client.replyLark('om_retained', 'Reply to retained Feishu source');
  await client.replyLark('om_retained', 'Reply to retained Feishu source');
  assert.equal(replies, 1);
  assert.equal((await State.open(f.directory)).larkDelivery('om_retained')?.replies.length, 1);
  await client.acknowledgeThread('retained-lark', 'workbuddy', message.id);
  assert.equal(state.larkDelivery('om_retained'), undefined);
});

test('manually bound Feishu groups register Trae and WorkBuddy inboxes without thread-open', async t => {
  const f = await fixture(t); const { api, announcements } = fakeFeishu();
  const lark = new LarkService(f.state, f.sessions, undefined, () => {}, api);
  for (const adapter of ['trae', 'workbuddy'] as const) {
    const id = `manual-${adapter}`; const chat_id = `oc_${adapter}`;
    await lark.handle({ method: 'PUT', path: `/v1/lark/bindings/${chat_id}`,
      body: { adapter, session_id: id, session_name: `${adapter} task`, sender_open_id: 'ou_owner' } });
    assert.equal((await State.open(f.directory)).session(id).adapter, adapter);
    assert.match(announcements.get(chat_id)!, new RegExp(`:${adapter}:${id}`));
    lark.enqueue({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: { chat_id, message_id: `om_manual_${adapter}`,
      message_type: 'text', content: JSON.stringify({ text: `Reply for manually bound ${adapter}` }) } });
    await lark.drain();
    const inbox = await f.client.receiveThread(id, adapter);
    assert.equal(inbox.messages.length, 1);
    assert.match(inbox.messages[0].text, new RegExp(`Reply for manually bound ${adapter}`));
    assert.equal(f.state.deliveries.get(`om_manual_${adapter}`)?.transport_status, 'inbox_queued');
  }
  await assert.rejects(lark.handle({ method: 'PUT', path: '/v1/lark/bindings/oc_conflict',
    body: { adapter: 'workbuddy', session_id: 'manual-trae', sender_open_id: 'ou_owner' } }), /another adapter/);
  assert.equal(announcements.get('oc_conflict'), undefined, 'conflicting IDs fail before modifying the group');
});

test('CLI allocates distinct conversation IDs and requires them on receive, send and acknowledgment', async t => {
  const f = await fixture(t); const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const threads = { name: 'fixture-threads', status: () => 'ready', async handle(request: { method: string; path: string; body: unknown }) {
    if (request.path !== '/v1/threads') return;
    const body = request.body as { adapter: PolledAdapter; session_id: string; session_name: string };
    await registerPolledSession(f.state, body.adapter, body.session_id, body.session_name);
    return { body: { ...body, channel: 'feishu', chat_id: 'oc_fixture', created: true } };
  } };
  const server = createServiceHost([f.sessions, threads], f.state.token); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const args = ['--state-dir', f.directory, '--port', String((server.address() as AddressInfo).port)];
  const run = async (command: string, ...flags: string[]) => JSON.parse((await execute(process.execPath, [cli, command, ...args, ...flags])).stdout);
  for (const adapter of ['trae', 'workbuddy'] as const) {
    const first = await run('thread-open', '--agent', adapter, '--session-name', 'Task') as ThreadInfo;
    const second = await run('thread-open', '--agent', adapter, '--session-name', 'Task') as ThreadInfo;
    assert.notEqual(first.session_id, second.session_id);
    for (const command of ['thread-send', 'thread-receive', 'thread-ack']) await assert.rejects(run(command, '--agent', adapter), /session-id returned by thread-open/);
    await f.sessions.send(first.session_id, 'CLI inbox input', adapter);
    const inbox = await run('thread-receive', '--agent', adapter, '--session-id', first.session_id) as SessionInbox;
    assert.equal(inbox.messages.length, 1);
    await run('thread-ack', '--agent', adapter, '--session-id', first.session_id, '--message-id', inbox.messages[0].id);
    assert.equal((await f.client.receiveThread(first.session_id, adapter)).messages.length, 0);
  }
});
