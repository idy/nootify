import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServiceHost } from '../src/server.js';
import { SessionsService } from '../src/sessions.js';
import { LarkService } from '../src/lark.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { State } from '../src/state.js';
import { forwardedLarkMessage, LarkReplies } from '../src/lark-replies.js';
import type { LarkApi } from '../src/lark-metadata.js';
import type { LarkDelivery } from '../src/types.js';

async function fixture(t: TestContext): Promise<{ state: State; delivery: LarkDelivery }> {
  const dir = await mkdtemp(join(tmpdir(), 'ws-replies-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = await State.open(dir);
  const delivery: LarkDelivery = { message_id: 'om_original', chat_id: 'oc_origin', sender_open_id: 'ou_sender',
    session_id: 'local_session', session_name: 'Session title', adapter: 'claude-desktop',
    created_at: new Date().toISOString(), transport_status: 'socket_written', replies: [] };
  state.deliveries.set(delivery.message_id, delivery); await state.save();
  return { state, delivery };
}
const apiFrom = (fn: (method: string, path: string, body: unknown) => Promise<unknown>): LarkApi => ({ appId: 'cli_test',
  async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> { return await fn(method, path, body) as T; } });

test('forwarded text identifies the Feishu user and gives original-message reply and acknowledgment commands', async t => {
  const { state, delivery } = await fixture(t);
  const input = "在么？\nOriginal text with 'quotes' and $(shell syntax).";
  const forwarded = forwardedLarkMessage(delivery, input, '/private/some user\'s state', 9517);
  assert.match(forwarded, /来自飞书用户/); assert.match(forwarded, /方便时回复原飞书消息/);
  assert.ok(forwarded.includes(input)); assert.ok(forwarded.includes(delivery.sender_open_id));
  assert.ok(forwarded.includes(delivery.chat_id)); assert.match(forwarded, /lark-ack .*--message-id 'om_original'/);
  assert.match(forwarded, /lark-reply .*--message-id 'om_original'/); assert.match(forwarded, /--port 9517/);
  assert.ok(!forwarded.includes(state.token));
  const commands = forwarded.split('\n').filter(line => line.includes(' lark-'));
  assert.ok(commands.every(command => !command.includes('$(shell syntax)')));
  assert.ok(commands.every(command => command.includes(`'"'"'`)), 'Paths with apostrophes must be shell quoted');
});

test('acknowledging receipt is idempotent, survives restart and sends no Feishu message', async t => {
  const { state, delivery } = await fixture(t); const logs: Record<string, unknown>[] = [];
  const replies = new LarkReplies(state, apiFrom(async () => assert.fail('Acknowledgment must not send a chat message')), log => logs.push(log));
  const first = await replies.acknowledge(delivery.message_id);
  assert.deepEqual(await replies.acknowledge(delivery.message_id), first);
  const restored = await State.open(state.directory);
  assert.equal(restored.deliveries.get(delivery.message_id)?.acknowledged_at, first.acknowledged_at);
  assert.equal(logs.length, 1); assert.equal(logs[0].status, 'session_acknowledged');
});

test('replies go to the original message and preserve thread behavior', async t => {
  const { state, delivery } = await fixture(t); delivery.thread_id = 'omt_original';
  const calls: unknown[] = []; const logs: Record<string, unknown>[] = [];
  const replies = new LarkReplies(state, apiFrom(async (method, path, body) => {
    assert.equal(method, 'POST'); assert.equal(path, '/open-apis/im/v1/messages/om_original/reply');
    calls.push(body); return { message_id: 'om_reply', chat_id: 'oc_origin' };
  }), log => logs.push(log));
  const result = await replies.reply(delivery.message_id, '在的，稍后回复。');
  assert.equal(result.status, 'replied');
  const body = calls[0] as { msg_type: string; content: string; reply_in_thread: boolean; uuid: string };
  assert.equal(body.msg_type, 'text'); assert.equal(body.reply_in_thread, true);
  assert.equal(JSON.parse(body.content).text, '[Session title] 在的，稍后回复。');
  assert.ok(body.uuid.length <= 50);
  assert.deepEqual(logs.map(log => log.status), ['session_acknowledged', 'replied']);
});

test('concurrent identical replies and retries after restart do not send duplicates', async t => {
  const { state, delivery } = await fixture(t); let calls = 0;
  const api = apiFrom(async () => { calls++; return { message_id: 'om_reply', chat_id: delivery.chat_id }; });
  const replies = new LarkReplies(state, api, () => {});
  const results = await Promise.all([replies.reply(delivery.message_id, 'Hello'), replies.reply(delivery.message_id, 'Hello'), replies.reply(delivery.message_id, 'Hello')]);
  assert.equal(calls, 1); assert.ok(results.every(result => result.reply_id === 'om_reply'));
  const restored = new LarkReplies(await State.open(state.directory), api, () => {});
  await restored.reply(delivery.message_id, 'Hello'); assert.equal(calls, 1);
});

test('unknown or ignored messages cannot be replied to through the bridge', async t => {
  const { state, delivery } = await fixture(t);
  const replies = new LarkReplies(state, apiFrom(async () => assert.fail('Must not send')), () => {});
  await assert.rejects(replies.reply('om_unknown', 'Hello'), /No forwarded/);
  delivery.transport_status = 'ignored';
  await assert.rejects(replies.acknowledge(delivery.message_id), /not forwarded/);
  await assert.rejects(replies.reply(delivery.message_id, 'Hello'), /not forwarded/);
});

test('failed replies are not marked as sent and retain the same retry idempotency key', async t => {
  const { state, delivery } = await fixture(t); const keys: string[] = []; const logs: Record<string, unknown>[] = [];
  const api = apiFrom(async (_method, _path, body) => {
    keys.push((body as { uuid: string }).uuid);
    if (keys.length === 1) throw new Error('network failure');
    return { message_id: 'om_reply', chat_id: delivery.chat_id };
  });
  const replies = new LarkReplies(state, api, log => logs.push(log));
  await assert.rejects(replies.reply(delivery.message_id, 'Hello'), /network failure/);
  assert.equal(delivery.replies.length, 0); assert.equal(logs.at(-1)?.status, 'reply_failed');
  await replies.reply(delivery.message_id, 'Hello');
  assert.equal(keys[0], keys[1]); assert.equal(delivery.replies.length, 1);
});

test('the actual CLI acknowledgment and reply reach the authenticated service callbacks', async t => {
  const { state, delivery } = await fixture(t); let calls = 0;
  const sessions = new SessionsService(state, { async inspect() { assert.fail('Replies must not scan sessions'); } });
  const lark = new LarkService(state, sessions, undefined, () => {}, apiFrom(async (_method, path) => {
    assert.equal(path, '/open-apis/im/v1/messages/om_original/reply'); calls++;
    return { message_id: 'om_reply', chat_id: delivery.chat_id };
  }));
  const server = createServiceHost([lark], state.token);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const args = ['--state-dir', state.directory, '--port', String((server.address() as AddressInfo).port), '--message-id', delivery.message_id];
  const exec = promisify(execFile);
  const acknowledged = await exec(process.execPath, [cli, 'lark-ack', ...args]);
  assert.equal(JSON.parse(acknowledged.stdout).status, 'session_acknowledged'); assert.equal(calls, 0);
  const replied = await exec(process.execPath, [cli, 'lark-reply', ...args, '--text', 'Hello from CLI']);
  assert.equal(JSON.parse(replied.stdout).reply_id, 'om_reply'); assert.equal(calls, 1);
  assert.ok(!acknowledged.stdout.includes(state.token)); assert.ok(!replied.stdout.includes(state.token));
});
