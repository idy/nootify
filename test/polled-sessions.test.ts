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
import { LarkService } from '../src/lark.js';
import type { LarkApi } from '../src/lark-metadata.js';
import { discardCanceledInbox, registerPolledSession, sessionInbox } from '../src/polled-sessions.js';
import { createServiceHost } from '../src/server.js';
import { SessionsService } from '../src/sessions.js';
import { State } from '../src/state.js';
import { StateDatabase, type StateRows } from '../src/state-database.js';
import type { PolledAdapter, SessionInbox, ThreadInfo } from '../src/types.js';
import { assertMode, inboxPath } from './platform-fixtures.js';

const execute = promisify(execFile);
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-polled-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await State.open(directory); const forwarding: { port: number; command?: string[] } = { port: 0 };
  const sessions = new SessionsService(state, { inspect: async () => { throw new Error('Must not resolve a polled client through Claude'); } }, () => {},
    { resolve: async () => { throw new Error('Must not query a native backend'); }, close() {} }, forwarding);
  const server = createServiceHost([sessions], state.token); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as AddressInfo).port; forwarding.port = port;
  const client = new NootifyClient({ baseUrl: `http://127.0.0.1:${port}`, token: state.token });
  return { directory, state, sessions, server, client, port, forwarding };
}
for (const adapter of ['trae', 'workbuddy'] as const) {
  test(`${adapter}: private inbox survives restart, is session-scoped, and retains input until explicit acknowledgment`, async t => {
    const f = await fixture(t); await registerPolledSession(f.state, adapter, 'conversation-one', 'First task');
    await registerPolledSession(f.state, adapter, 'conversation-two', 'Second task');
    const other = adapter === 'trae' ? 'workbuddy' : 'trae';
    await assert.rejects(f.client.sendMessage('conversation-one', 'Wrong adapter', other), /session_not_local/);
    await assert.rejects(f.client.sendMessage('missing', 'Unknown', adapter), /session_not_local/);
    assert.deepEqual(await f.client.sendMessage('conversation-one', 'User input', adapter), { status: 'inbox_queued' });
    const pending = await f.client.receiveThread('conversation-one', adapter); assert.equal(pending.messages.length, 1);
    assert.match(pending.messages[0].text, /\[Nootify: First task\]\nUser input/);
    assert.deepEqual(await f.client.receiveThread('conversation-one', adapter), pending);
    assert.deepEqual((await f.client.receiveThread('conversation-two', adapter)).messages, []);
    await assert.rejects(f.client.receiveThread('conversation-one', other), /session_not_local/);
    const id = pending.messages[0].id; await assert.rejects(f.client.acknowledgeThread('conversation-two', adapter, id), /No inbox message/);
    assert.equal((await State.open(f.directory)).inboxMessages.get(id)?.text, pending.messages[0].text);
    await assertMode(join(f.directory, 'state.sqlite'), 0o600);
    await f.client.acknowledgeThread('conversation-one', adapter, id); await f.client.acknowledgeThread('conversation-one', adapter, id);
    assert.deepEqual((await f.client.receiveThread('conversation-one', adapter)).messages, []);
    assert.equal((await State.open(f.directory)).inboxMessages.size, 0);
    await assert.rejects(f.client.registerSession('conversation-one', { adapter: other, session_name: 'Must not overwrite' }), /another adapter/);
    assert.ok(!JSON.stringify(await f.client.listSessions()).includes('User input'));
    assert.equal(f.state.session('conversation-one').host_id, hostname());
    assert.equal((await fetch(`http://127.0.0.1:${f.port}/v1/sessions/conversation-one/inbox`, { method: 'POST', body: JSON.stringify({ adapter }) })).status, 401);
  });
  test(`${adapter}: registration cannot be overwritten by a concurrent Claude socket validation`, async t => {
    const f = await fixture(t); const id = 'registration-race'; const socket_path = inboxPath(f.directory);
    const socket = createSocketServer(connection => connection.end()); socket.listen(socket_path); await once(socket, 'listening'); t.after(() => socket.close());
    const request = f.sessions.handle({ method: 'PUT', path: `/v1/sessions/${id}`, body: { adapter: 'claude-code', session_name: 'Native registration', socket_path } });
    const refused = assert.rejects(request, /another adapter/); await registerPolledSession(f.state, adapter, id, 'Polled task'); await refused;
    assert.equal(f.state.session(id).adapter, adapter); assert.equal((await State.open(f.directory)).session(id).adapter, adapter);
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
  const f = await fixture(t); await registerPolledSession(f.state, 'trae', 'atomic-ack', 'Task');
  let releases = 0; f.sessions.setInboxConsumer(async () => { releases++; });
  await f.sessions.send('atomic-ack', 'Keep this input', 'trae', { text: 'Keep this input', source: { channel: 'provider',
    delivery: { adapter: 'trae', session_id: 'atomic-ack', message: { origin_node_id: 'source', provider_id: 'bot', message_id: 'pending' } } } });
  const message = (await f.client.receiveThread('atomic-ack', 'trae')).messages[0];
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const write = StateDatabase.prototype.write; let fail = true;
  t.mock.method(StateDatabase.prototype, 'write', async function (this: StateDatabase, rows: StateRows) {
    if (fail && this.path === join(f.directory, 'state.sqlite')) { fail = false; entered(); await gate; throw new Error('Injected state transaction failure'); }
    return write.call(this, rows);
  });
  const acknowledgment = f.client.acknowledgeThread('atomic-ack', 'trae', message.id); await started;
  f.state.settings.lark_recipient_open_id = 'ou_changed'; const overlapping = f.state.save();
  const failed = assert.rejects(acknowledgment, /Injected state transaction failure/); release(); await failed; await overlapping;
  assert.ok(f.state.inboxMessages.has(message.id)); const restored = await State.open(f.directory);
  assert.ok(restored.inboxMessages.has(message.id)); assert.equal(restored.settings.lark_recipient_open_id, 'ou_changed');
  assert.equal(releases, 0, 'a failed durable deletion cannot release the callback route');
  await f.client.acknowledgeThread('atomic-ack', 'trae', message.id);
  assert.equal(releases, 1); assert.equal((await State.open(f.directory)).inboxMessages.has(message.id), false);
});
test('a cancellation snapshot cannot remove a later inbox entry with the same reference', async t => {
  const f = await fixture(t); await registerPolledSession(f.state, 'workbuddy', 'snapshot-scoped', 'Retained task');
  const message = { origin_node_id: 'source', provider_id: 'bot', message_id: 'canceled-input' };
  const origin = { text: 'Input', source: { channel: 'provider' as const,
    delivery: { adapter: 'workbuddy' as const, session_id: 'snapshot-scoped', message } } };
  await f.sessions.send('snapshot-scoped', 'Input', 'workbuddy', origin);
  const original = [...f.state.inboxMessages.values()][0];
  const snapshot = [{ inbox_id: original.id, message }];
  await f.sessions.send('snapshot-scoped', 'Later input', 'workbuddy', { ...origin, text: 'Later input' });
  const later = [...f.state.inboxMessages.values()].find(item => item.id !== original.id)!;
  await discardCanceledInbox(f.state, snapshot, [message]);
  const restored = await State.open(f.directory);
  assert.equal(restored.inboxMessages.has(original.id), false); assert.equal(restored.inboxMessages.get(later.id)?.text, 'Later input');
  assert.equal(restored.sessions.get('snapshot-scoped')?.session_name, 'Retained task');
});

test('failed hostname reconciliation retains the prior registration and queued input', async t => {
  const f = await fixture(t); await registerPolledSession(f.state, 'trae', 'retained', 'Original task'); await f.sessions.send('retained', 'Pending input', 'trae');
  const saved = { ...f.state.session('retained'), host_id: 'previous-mac-hostname' }; f.state.sessions.set('retained', saved); await f.state.save();
  t.mock.method(f.state, 'save', async () => { throw new Error('Cannot persist registration'); });
  await assert.rejects(registerPolledSession(f.state, 'trae', 'retained', 'Reopened task'), /Cannot persist registration/);
  assert.deepEqual(f.state.session('retained'), saved); assert.equal(f.state.inboxMessages.size, 1);
  assert.equal((await State.open(f.directory)).session('retained').host_id, 'previous-mac-hostname');
});
function fakeFeishu() {
  const announcements = new Map<string, string>(); let next = 0;
  const api: LarkApi = { appId: 'cli_fixture', async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const announcement = /\/chats\/([^/]+)\/announcement$/.exec(path);
    if (announcement) {
      if (method === 'GET') return { revision: '1', content: announcements.get(announcement[1]) ?? '' } as T;
      const request = body as { requests: string[] }; const operation = JSON.parse(request.requests[0]);
      announcements.set(announcement[1], JSON.parse(operation.insertBlocksRequest.payload).blocks[0].paragraph.elements[0].textRun.text); return {} as T;
    }
    if (path.startsWith('/open-apis/im/v1/chats?')) return (method === 'GET' ? { items: [], has_more: false } : { chat_id: `oc_${++next}` }) as T;
    if (path.startsWith('/open-apis/im/v1/messages?')) return { message_id: `om_${++next}` } as T;
    if (path.endsWith('/reactions')) return { reaction_id: 'fixture-reaction' } as T;
    throw new Error(`Unexpected ${method} ${path}`);
  } };
  return { api, announcements };
}
test('Feishu announcements route replies into the exact registered Trae and WorkBuddy inbox', async t => {
  const f = await fixture(t); f.state.settings.lark_recipient_open_id = 'ou_owner'; const { api, announcements } = fakeFeishu();
  const lark = new LarkService(f.state, f.sessions, undefined, () => {}, api);
  for (const adapter of ['trae', 'workbuddy'] as const) {
    const opened = await lark.handle({ method: 'POST', path: '/v1/threads', body: { adapter, session_id: adapter, session_name: `${adapter} task` } });
    const thread = opened!.body as ThreadInfo; assert.ok(announcements.get(thread.chat_id)?.includes(`:${adapter}:${adapter}`));
    await lark.handle({ method: 'POST', path: `/v1/threads/${adapter}/messages`, body: { adapter, text: 'Progress' } });
    lark.enqueue({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: { chat_id: thread.chat_id, message_id: `om_${adapter}`,
      message_type: 'text', content: JSON.stringify({ text: `Reply for ${adapter}` }) } });
    await lark.drain(); const inbox = await f.client.receiveThread(adapter, adapter);
    assert.equal(inbox.messages.length, 1); assert.match(inbox.messages[0].text, new RegExp(`Reply for ${adapter}`));
    assert.match(inbox.messages[0].text, /lark-ack/); assert.match(inbox.messages[0].text, /lark-reply/);
    assert.equal(f.state.deliveries.get(`om_${adapter}`)?.transport_status, 'inbox_queued');
  }
});
test('Feishu unread replies retain their source across eviction/restart and use current callback commands', async t => {
  const f = await fixture(t); f.state.settings.lark_recipient_open_id = 'ou_owner'; f.forwarding.command = ['/Old Nootify/node', '/Old Nootify/cli.js'];
  const remote = fakeFeishu(); let chat = ''; let replies = 0;
  const api: LarkApi = { appId: remote.api.appId, async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    if (method === 'POST' && /^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/.test(path)) { replies++; return { message_id: 'om_reply', chat_id: chat } as T; }
    return remote.api.request<T>(method, path, body);
  } };
  const original = new LarkService(f.state, f.sessions, undefined, () => {}, api, 9999);
  const opened = await original.handle({ method: 'POST', path: '/v1/threads', body: { adapter: 'workbuddy', session_id: 'retained-lark', session_name: 'Retained task' } });
  chat = (opened!.body as ThreadInfo).chat_id;
  const incoming = { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: { chat_id: chat, message_id: 'om_retained',
    message_type: 'text', content: JSON.stringify({ text: 'Original unread Feishu text' }) } };
  original.enqueue(incoming); await original.drain(); const delivery = f.state.deliveries.get('om_retained')!;
  for (let index = 0; index < 1999; index++) { const id = `om_newer_${index}`; f.state.deliveries.set(id, { ...delivery, message_id: id, transport_status: 'input_accepted', replies: [] }); }
  original.enqueue({ ...incoming, message: { ...incoming.message, message_id: 'om_trigger', content: JSON.stringify({ text: 'Later Feishu text' }) } }); await original.drain();
  assert.equal(f.state.deliveries.has('om_retained'), false);
  const state = await State.open(f.directory); const runtime = { port: 0, command: [process.execPath, fileURLToPath(new URL('../src/cli.js', import.meta.url))] };
  const sessions = new SessionsService(state, undefined, () => {}, undefined, runtime); const lark = new LarkService(state, sessions, undefined, () => {}, api);
  const server = createServiceHost([sessions, lark], state.token); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); }); runtime.port = (server.address() as AddressInfo).port;
  const client = new NootifyClient({ baseUrl: `http://127.0.0.1:${runtime.port}`, token: state.token });
  assert.equal(await lark.enqueue(incoming), true);
  const pending = await client.receiveThread('retained-lark', 'workbuddy'); assert.equal(pending.messages.length, 2);
  const message = pending.messages.find(message => message.text.includes('Original unread Feishu text'))!;
  assert.match(message.text, new RegExp(`--port ${runtime.port} `)); assert.ok(!message.text.includes('/Old Nootify/'));
  const relocated = sessionInbox(state, 'workbuddy', 'retained-lark', { port: 9517, command: ['/New Nootify/node', '/New Nootify/cli.js'] });
  assert.ok(relocated.messages[0].text.includes("'/New Nootify/node' '/New Nootify/cli.js' lark-ack")); assert.match(relocated.messages[0].text, /--port 9517 /);
  await client.acknowledgeLark('om_retained'); await client.replyLark('om_retained', 'Reply to retained Feishu source'); await client.replyLark('om_retained', 'Reply to retained Feishu source');
  assert.equal(replies, 1); assert.equal((await State.open(f.directory)).larkDelivery('om_retained')?.replies.length, 1);
  await client.acknowledgeThread('retained-lark', 'workbuddy', message.id); assert.equal(state.larkDelivery('om_retained'), undefined);
});
test('manually bound Feishu groups register Trae and WorkBuddy inboxes without thread-open', async t => {
  const f = await fixture(t); const { api, announcements } = fakeFeishu(); const lark = new LarkService(f.state, f.sessions, undefined, () => {}, api);
  for (const adapter of ['trae', 'workbuddy'] as const) {
    const id = `manual-${adapter}`; const chat_id = `oc_${adapter}`;
    await lark.handle({ method: 'PUT', path: `/v1/lark/bindings/${chat_id}`, body: { adapter, session_id: id, session_name: `${adapter} task`, sender_open_id: 'ou_owner' } });
    assert.equal((await State.open(f.directory)).session(id).adapter, adapter); assert.match(announcements.get(chat_id)!, new RegExp(`:${adapter}:${id}`));
    lark.enqueue({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: { chat_id, message_id: `om_manual_${adapter}`,
      message_type: 'text', content: JSON.stringify({ text: `Reply for manually bound ${adapter}` }) } }); await lark.drain();
    const inbox = await f.client.receiveThread(id, adapter); assert.equal(inbox.messages.length, 1);
    assert.match(inbox.messages[0].text, new RegExp(`Reply for manually bound ${adapter}`)); assert.equal(f.state.deliveries.get(`om_manual_${adapter}`)?.transport_status, 'inbox_queued');
  }
  await assert.rejects(lark.handle({ method: 'PUT', path: '/v1/lark/bindings/oc_conflict', body: { adapter: 'workbuddy', session_id: 'manual-trae', sender_open_id: 'ou_owner' } }), /another adapter/);
  assert.equal(announcements.get('oc_conflict'), undefined);
});
test('CLI allocates distinct conversation IDs and requires them on receive, send and acknowledgment', async t => {
  const f = await fixture(t); const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const threads = { name: 'fixture-threads', status: () => 'ready', async handle(request: { method: string; path: string; body: unknown }) {
    if (request.path !== '/v1/threads') return;
    const body = request.body as { adapter: PolledAdapter; session_id: string; session_name: string }; await registerPolledSession(f.state, body.adapter, body.session_id, body.session_name);
    return { body: { ...body, channel: 'feishu', chat_id: 'oc_fixture', created: true } };
  } };
  const server = createServiceHost([f.sessions, threads], f.state.token); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const args = ['--state-dir', f.directory, '--port', String((server.address() as AddressInfo).port)];
  const run = async (command: string, ...flags: string[]) => JSON.parse((await execute(process.execPath, [cli, command, ...args, ...flags])).stdout);
  for (const adapter of ['trae', 'workbuddy'] as const) {
    const first = await run('thread-open', '--agent', adapter, '--session-name', 'Task') as ThreadInfo;
    const second = await run('thread-open', '--agent', adapter, '--session-name', 'Task') as ThreadInfo; assert.notEqual(first.session_id, second.session_id);
    for (const command of ['thread-send', 'thread-receive', 'thread-ack']) await assert.rejects(run(command, '--agent', adapter), /session-id returned by thread-open/);
    await f.sessions.send(first.session_id, 'CLI inbox input', adapter);
    const inbox = await run('thread-receive', '--agent', adapter, '--session-id', first.session_id) as SessionInbox; assert.equal(inbox.messages.length, 1);
    await run('thread-ack', '--agent', adapter, '--session-id', first.session_id, '--message-id', inbox.messages[0].id);
    assert.equal((await f.client.receiveThread(first.session_id, adapter)).messages.length, 0);
  }
});
