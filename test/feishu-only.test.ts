import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { NootifyClient } from '../src/client.js';
import { EventLog } from '../src/events.js';
import { GitHubAuth } from '../src/github-auth.js';
import { LarkService } from '../src/lark.js';
import type { LarkApi } from '../src/lark-metadata.js';
import { SessionsService } from '../src/sessions.js';
import { SettingsService } from '../src/settings.js';
import { createServiceHost } from '../src/server.js';
import { State } from '../src/state.js';
import { StateDatabase } from '../src/state-database.js';

const execute = promisify(execFile);
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-feishu-only-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await State.open(directory);
  const database = await StateDatabase.open(directory, async () => undefined);
  const retired = JSON.stringify({ id: 'retired-input', adapter: 'trae', session_id: 'conversation', text: 'Retired input must never be delivered as Feishu',
    created_at: '2026-11-01T00:00:00Z', source: { channel: 'slack', delivery: { id: 'retired-delivery' } } });
  const native = '{ "key": "retired-native", "session": "private-retired-authorization", "pts": 100 }';
  await database.patch({ settings: new Map([
    ['notification_channel', JSON.stringify('telegram')], ['slack', JSON.stringify({ bot_token: 'private-retired-bot' })],
    ['telegram', JSON.stringify({ bot_token: 'private-retired-other' })], ['lark_recipient_open_id', JSON.stringify('ou_owner')],
  ]), inbox_messages: new Map([['retired-input', retired]]), telegram_clients: new Map([['retired-native', native]]) });
  const state = await State.open(directory); const announcements = new Map<string, string>(); const calls: string[] = [];
  const api: LarkApi = { appId: 'cli_0123456789abcdef', async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    calls.push(`${method} ${path}`);
    const match = /\/chats\/([^/]+)\/announcement$/.exec(path);
    if (match) {
      if (method === 'GET') return { revision: '1', content: announcements.get(match[1]) ?? '' } as T;
      const operation = JSON.parse((body as { requests: string[] }).requests[0]);
      announcements.set(match[1], JSON.parse(operation.insertBlocksRequest.payload).blocks[0].paragraph.elements[0].textRun.text); return {} as T;
    }
    if (path.startsWith('/open-apis/im/v1/chats?')) return (method === 'GET' ? { items: [], has_more: false } : { chat_id: 'oc_feishu' }) as T;
    if (path.startsWith('/open-apis/im/v1/messages?')) return { message_id: 'om_progress' } as T;
    if (path.endsWith('/reactions')) return { reaction_id: 'reaction' } as T;
    throw new Error(`Unexpected synthetic API ${method} ${path}`);
  } };
  const sessions = new SessionsService(state);
  const lark = new LarkService(state, sessions, { appId: api.appId, appSecret: 'fixture-feishu-secret' }, () => {}, api);
  const settings = new SettingsService({ state, lark, github: new GitHubAuth(state), env: {},
    pulls: { async preferences() { return { follow: [] }; }, async restore() {} },
    agents: { async list() { return []; }, async set() { throw new Error('Not used'); } } });
  const logs = await EventLog.open(directory); const server = createServiceHost([sessions, lark], state.token, logs, { settings, channel: () => lark.channel() });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await lark.stop(); await sessions.stop(); await settings.stop(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new NootifyClient({ token: state.token, baseUrl: origin });
  const post = (path: string, body = {}) => fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json', 'x-nootify-ui': '1' }, body: JSON.stringify(body) });
  return { directory, state, settings, lark, client, calls, origin, post, native, retired };
}

test('legacy defaults cannot select another provider or expose retired credentials', async t => {
  const f = await fixture(t);
  assert.equal('notification_channel' in f.state.settings, false); assert.equal('slack' in f.state.settings, false); assert.equal('telegram' in f.state.settings, false);
  const page = await f.settings.page(); assert.equal('slack' in page, false); assert.equal('telegram' in page, false); assert.equal('notification_channel' in page, false);
  const encoded = JSON.stringify(page); assert.ok(!encoded.includes('private-retired-'));
  const exported = await f.settings.exportConfig(); const contents = await readFile(exported.path, 'utf8');
  assert.ok(!contents.includes('private-retired-')); assert.equal('notification_channel' in JSON.parse(contents), false);
  await f.state.save();
  const rows = (await StateDatabase.open(f.directory, async () => undefined)).load();
  assert.equal(rows.telegram_clients.get('retired-native'), f.native); assert.equal(rows.inbox_messages.get('retired-input'), f.retired);
  assert.equal((await State.open(f.directory)).inboxMessages.has('retired-input'), false);
});
test('thread commands always use Feishu and do not release retired input into its inbox', async t => {
  const f = await fixture(t);
  const thread = await f.client.openThread({ adapter: 'trae', session_id: 'conversation', session_name: 'Feishu task' }); assert.equal(thread.channel, 'feishu');
  assert.deepEqual((await f.client.receiveThread('conversation', 'trae')).messages, []);
  assert.equal((await f.client.sendThread('conversation', 'Progress', 'trae')).channel, 'feishu');
  assert.equal(await f.lark.enqueue({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: { chat_id: thread.chat_id, message_id: 'om_user', message_type: 'text', content: JSON.stringify({ text: 'Active Feishu input' }) } }), true);
  const inbox = await f.client.receiveThread('conversation', 'trae'); assert.equal(inbox.messages.length, 1);
  assert.match(inbox.messages[0].text, /Active Feishu input/); assert.match(inbox.messages[0].text, /lark-reply/);
  assert.ok(!inbox.messages[0].text.includes('Retired input'));
});
test('removed configuration and callback APIs are unavailable and cannot trigger Feishu calls', async t => {
  const f = await fixture(t); const before = f.calls.length;
  for (const path of ['/ui/api/settings/slack', '/ui/api/settings/telegram', '/ui/api/settings/slack/secret', '/ui/api/settings/telegram/recipients',
    '/ui/api/settings/channel', '/v1/chat/messages/old/ack', '/v1/chat/messages/old/reply']) assert.equal((await f.post(path)).status, 404, path);
  for (const channel of ['slack', 'telegram', 'unknown']) {
    assert.equal((await f.post('/v1/threads', { channel, adapter: 'trae', session_id: 'wrong', session_name: 'Wrong provider' })).status, 400);
    assert.equal((await f.post('/v1/threads/conversation/messages', { channel, adapter: 'trae', text: 'Must not send' })).status, 400);
  }
  assert.equal(f.calls.length, before);
});
test('CLI help and validation expose only Feishu messaging commands', async t => {
  const f = await fixture(t); const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const { stdout } = await execute(process.execPath, [cli, '--help']);
  assert.ok(!/slack|telegram|chat-ack|chat-reply/.test(stdout)); assert.match(stdout, /lark-ack/);
  await assert.rejects(execute(process.execPath, [cli, 'thread-open', '--state-dir', join(f.directory, 'missing'), '--channel', 'slack', '--agent', 'trae', '--session-name', 'Wrong']), /Only Feishu/);
});
