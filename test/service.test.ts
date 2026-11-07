import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { State } from '../src/state.js';
import { SessionsService, writeInbox } from '../src/sessions.js';
import { LarkService, selectMessage } from '../src/lark.js';
import { createServiceHost } from '../src/server.js';
import { NootifyClient } from '../src/client.js';
import { assertInstallPort, launchdPlist } from '../src/launchd.js';
import { ApiError, assertMetadata, bindingToken, ensureAnnouncement, ensureBindingMessage, loadCredentials, readAnnouncement, readRemoteBinding } from '../src/lark-metadata.js';
import type { LarkApi } from '../src/lark-metadata.js';
import type { RemoteBinding, ServiceModule } from '../src/types.js';
import type { SessionCatalog } from '../src/local-sessions.js';
import { assertMode, inboxPath } from './platform-fixtures.js';

function catalogFor(state: State): SessionCatalog {
  return {
    async inspect(id) { const session = state.sessions.get(id); return session && { ...session, availability: 'active' as const, runtime_pid: process.pid }; },
  };
}

const binding: RemoteBinding = {
  session_id: 'local_test', host_id: hostname(), adapter: 'claude-desktop', session_name: 'Test',
  socket_path: '/unused', chat_id: 'oc_test', sender_open_id: 'ou_allowed',
};
const marker = bindingToken(binding);
const event = (id = 'om_test', text = 'bridge-check') => ({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_allowed' } },
  message: { chat_id: 'oc_test', message_id: id, message_type: 'text', content: JSON.stringify({ text }) } });
const apiFrom = (handler: (method: string, path: string, body?: unknown) => Promise<unknown>): LarkApi => ({ appId: 'cli_test',
  async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> { return await handler(method, path, body) as T; } });
async function temporary(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nootify-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function inbox(t: TestContext, dir: string): Promise<{ path: string; messages: string[] }> {
  const path = inboxPath(dir);
  const messages: string[] = [];
  const server = createServer(socket => { socket.setEncoding('utf8'); socket.on('data', data => messages.push(data.toString())); socket.on('end', () => socket.end()); });
  server.listen(path); await once(server, 'listening'); t.after(() => server.close()); return { path, messages };
}
function announcementApi(): LarkApi {
  return apiFrom(async (_method, path) => {
    assert.ok(path.includes('/announcement'), 'Routing must read the group announcement');
    return { revision: '1', content: marker };
  });
}

test('metadata must uniquely match the complete local binding', () => {
  assert.doesNotThrow(() => assertMetadata(marker, binding));
  assert.throws(() => assertMetadata(`${marker}\n${marker}-other`, binding), /does not uniquely match/);
  assert.throws(() => assertMetadata(undefined, binding), /does not uniquely match/);
});

test('only the configured user and chat can send text; malformed content is ignored', () => {
  assert.equal(selectMessage(event(), binding)?.text, 'bridge-check');
  for (const mutate of [
    (e: ReturnType<typeof event>) => { e.sender.sender_type = 'app'; },
    (e: ReturnType<typeof event>) => { e.sender.sender_id.open_id = 'ou_other'; },
    (e: ReturnType<typeof event>) => { e.message.chat_id = 'oc_other'; },
    (e: ReturnType<typeof event>) => { e.message.content = '{bad'; },
    (e: ReturnType<typeof event>) => { e.message.content = 'null'; },
    (e: ReturnType<typeof event>) => { e.message.message_type = 'post'; },
  ]) { const payload = event(); mutate(payload); assert.equal(selectMessage(payload, binding), undefined); }
});

test('binding message is created once and checked against the application author', async () => {
  let writes = 0;
  const api = apiFrom(async method => {
    if (method === 'POST') { writes++; return { message_id: 'om_binding' }; }
    return { items: [{ message_id: 'om_binding', chat_id: 'oc_test', msg_type: 'text', sender: { sender_type: 'app', id: 'cli_test' }, body: { content: JSON.stringify({ text: marker }) } }] };
  });
  assert.equal(await ensureBindingMessage(api, binding), 'om_binding');
  assert.equal(await ensureBindingMessage(api, { ...binding, registration_message_id: 'om_binding' }), 'om_binding');
  assert.equal(writes, 1);
  await assert.rejects(readRemoteBinding({ ...api, appId: 'cli_other' }, { ...binding, registration_message_id: 'om_binding' }), /another author/);
});

test('legacy announcement preserves existing content and inserts once', async () => {
  let content = 'Existing notes'; let writes = 0;
  const api = apiFrom(async (method, _path, body) => {
    if (method === 'GET') return { revision: '12', content };
    const request = body as { revision: string; requests: string[] };
    assert.equal(request.revision, '12');
    assert.match(request.requests[0], /InsertBlocksRequestType/);
    writes++; content += '\n' + marker; return {};
  });
  await ensureAnnouncement(api, binding); await ensureAnnouncement(api, binding);
  assert.equal(content, 'Existing notes\n' + marker); assert.equal(writes, 1);
});

test('upgraded announcements use snapshot pagination and add a paragraph', async () => {
  const blocks: unknown[] = [{ text: 'Keep me' }]; let writes = 0;
  const api = apiFrom(async (method, path, body) => {
    if (path.startsWith('/open-apis/im/')) throw new ApiError(232097);
    if (method === 'POST') { writes++; blocks.push(body); return {}; }
    if (!path.includes('/blocks?')) return { revision_id: 8 };
    assert.match(path, /revision_id=8/);
    return path.includes('page_token=') ? { items: blocks.slice(1), has_more: false } : { items: blocks.slice(0, 1), has_more: true, page_token: 'next' };
  });
  await ensureAnnouncement(api, binding); assert.equal(writes, 1); assert.deepEqual(blocks[0], { text: 'Keep me' });
});

test('permission errors and conflicting metadata never become successful bindings', async () => {
  await assert.rejects(readAnnouncement(apiFrom(async () => { throw new ApiError(99991672, 'permission denied'); }), 'oc_test'), /permission denied/);
  let writes = 0;
  await assert.rejects(ensureAnnouncement(apiFrom(async method => {
    if (method !== 'GET') writes++; return { revision: '1', content: marker + '-other' };
  }), binding), /does not uniquely match/); assert.equal(writes, 0);
});

test('private state persists registrations across restarts and omits credentials from public lists', async t => {
  const dir = await temporary(t); const state = await State.open(dir);
  state.sessions.set(binding.session_id, { ...binding, socket_token: 'private-test-token' }); await state.save();
  const reopened = await State.open(dir);
  assert.equal(reopened.session(binding.session_id).socket_token, 'private-test-token');
  assert.equal(reopened.token, state.token);
  assert.ok(!JSON.stringify(reopened.publicSessions()).includes('private-test-token'));
  assert.ok(!JSON.stringify(reopened.publicSessions()).includes('socket_path'));
  await assertMode(join(dir, 'state.sqlite'), 0o600);
  await assertMode(join(dir, 'auth-token'), 0o600);
});

test('inbox frames carry the real registered token without asserting a permission mode', async t => {
  const dir = await temporary(t); const target = await inbox(t, dir);
  assert.deepEqual(await writeInbox(target.path, 'marker', 'test-token', 5000, process.pid), { status: 'socket_written' });
  const frames = target.messages.join('').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(frames[0], { type: 'auth', token: 'test-token' });
  assert.deepEqual(frames[1], { type: 'user', message: { role: 'user', content: 'marker' } });
  assert.equal('from_mode' in frames[1], false);
});

test('Feishu replies use the registry, verify metadata and suppress duplicate IDs', async t => {
  const dir = await temporary(t); const target = await inbox(t, dir); const state = await State.open(dir);
  state.sessions.set(binding.session_id, { ...binding, socket_path: target.path, socket_token: 'real-session-token' });
  state.bindings.set(binding.chat_id, { chat_id: binding.chat_id, session_id: binding.session_id, sender_open_id: binding.sender_open_id, registration_message_id: 'om_binding' });
  const reports: Record<string, unknown>[] = [];
  const lark = new LarkService(state, new SessionsService(state, catalogFor(state)), undefined, r => reports.push(r), announcementApi());
  assert.equal(await lark.enqueue(event('om_live', 'hello from Feishu')), true);
  assert.equal(await lark.enqueue(event('om_live', 'duplicate')), true, 'an already handled ID is a terminal completion');
  await lark.drain();
  assert.match(target.messages.join(''), /hello from Feishu/); assert.ok(reports.some(report => report.status === 'socket_written'));
  assert.ok(reports.some(report => report.reason === 'duplicate'));
});

test('invalid remote metadata prevents socket delivery without breaking the queue', async t => {
  const state = await State.open(await temporary(t));
  state.sessions.set(binding.session_id, binding); state.bindings.set(binding.chat_id, binding);
  const reports: Record<string, unknown>[] = [];
  const lark = new LarkService(state, new SessionsService(state, catalogFor(state)), undefined, r => reports.push(r), apiFrom(async () => ({ revision: '1', content: marker + '-other' })));
  lark.enqueue(event('om_1')); lark.enqueue(event('om_2')); await lark.drain();
  assert.deepEqual(reports.filter(r => r.status === 'ignored').map(r => r.reason), ['session_not_local', 'session_not_local']);
});

test('HTTP host protects APIs, serves health, supports unrelated modules and typed clients', async t => {
  const dir = await temporary(t); const target = await inbox(t, dir); const state = await State.open(dir);
  const sessions = new SessionsService(state, catalogFor(state));
  const extra: ServiceModule = { name: 'example', status: () => 'ready', async handle(r) { if (r.path === '/v1/example') return { body: { value: 42 } }; } };
  const server = createServiceHost([sessions, extra], state.token);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(baseUrl + '/v1/sessions')).status, 401);
  assert.equal((await fetch(baseUrl + '/v1/sessions', { headers: { authorization: `Bearer ${state.token}`, origin: 'https://example.org' } })).status, 403);
  const client = new NootifyClient({ baseUrl, token: state.token });
  assert.equal((await client.health()).service, 'nootify');
  assert.ok((await client.services()).some(service => service.name === 'example'));
  await client.registerSession(binding.session_id, { adapter: 'claude-desktop', session_name: 'Test', socket_path: target.path, socket_token: 'private-test-token' });
  assert.deepEqual(await client.listSessions(), []);
  assert.equal((await client.sendMessage(binding.session_id, 'typed client marker')).status, 'socket_written');
  assert.equal((await client.listSessions())[0].session_id, binding.session_id);
  const observed = JSON.stringify(await client.listSessions());
  for (const privateField of ['private-test-token', 'socket_path', 'socket_token', 'runtime_pid']) assert.ok(!observed.includes(privateField));
  const persisted = JSON.stringify([...(await State.open(dir)).sessions.values()]);
  assert.ok(!persisted.includes('runtime_pid'), 'runtime PIDs are transient delivery metadata');
  assert.match(target.messages.join(''), /typed client marker/);
  assert.deepEqual(await (await fetch(baseUrl + '/v1/example', { headers: { authorization: `Bearer ${state.token}` } })).json(), { value: 42 });
});

test('installation rejects occupied ports before changing any launchd job', async t => {
  let service = 'workspace-service';
  const server = createHttpServer((_request, response) => {
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ service }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as AddressInfo).port;
  await assert.rejects(assertInstallPort(port, false), /stop the existing service/);
  await assert.rejects(assertInstallPort(port, true), /stop the existing service/, 'a stale Nootify plist does not authorize replacing another server');
  service = 'nootify';
  await assert.rejects(assertInstallPort(port, false), /stop the existing service/, 'an unmanaged Nootify must be stopped first too');
  await assertInstallPort(port, true);
  server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  await assertInstallPort(port, false);
});

test('launchd plist uses an absolute executable and escapes paths', () => {
  const plist = launchdPlist({ node: '/opt/bin/node', server: '/A & B/server.js', stateDir: '/private/state', port: 9417, mcpConfig: '/some config.json' });
  assert.match(plist, /dev.idy.nootify.service/); assert.match(plist, /\/A &amp; B\/server.js/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/); assert.match(plist, /<string>\/opt\/bin\/node<\/string>/);
  assert.ok(!plist.includes('appSecret'));
});

test('MCP credential loading is explicit and does not alter its source', async t => {
  const dir = await temporary(t); const file = join(dir, 'mcp.json');
  const { writeFile } = await import('node:fs/promises');
  const source = JSON.stringify({ mcpServers: { lark: { args: ['cli.js', '-a', 'cli_test', '-s', 'fake-secret'] } } });
  await writeFile(file, source);
  assert.equal(await loadCredentials({}), undefined);
  assert.deepEqual(await loadCredentials({}, file), { appId: 'cli_test', appSecret: 'fake-secret' });
  await assert.rejects(loadCredentials({ LARK_APP_ID: 'partial' }, file), /both/);
  assert.equal(await readFile(file, 'utf8'), source);
  const unrelated = JSON.stringify({ mcpServers: { other: { command: 'example' } } });
  await writeFile(file, unrelated);
  assert.equal(await loadCredentials({}, file), undefined, 'an existing Claude config without Lark leaves notifications disabled');
  assert.equal(await readFile(file, 'utf8'), unrelated);
});
