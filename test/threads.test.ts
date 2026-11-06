import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { State } from '../src/state.js';
import { LarkThreads, threadName } from '../src/lark-threads.js';
import type { LarkApi } from '../src/lark-metadata.js';

interface Call { method: string; path: string; body?: Record<string, any> }
/** Legacy-announcement Feishu stand-in: chats, announcements and messages kept in memory. */
function fakeFeishu(chats: { chat_id: string; name: string; announcement: string }[] = []) {
  const calls: Call[] = [];
  const announcements = new Map(chats.map(chat => [chat.chat_id, chat.announcement]));
  let next = 1;
  const api: LarkApi = { appId: 'cli_test', async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    calls.push({ method, path, body: body as Record<string, any> });
    const announcement = /^\/open-apis\/im\/v1\/chats\/([^/?]+)\/announcement$/.exec(path);
    if (announcement) {
      const id = decodeURIComponent(announcement[1]);
      if (method === 'GET') return { revision: '1', content: announcements.get(id) ?? '' } as T;
      const operation = JSON.parse((body as { requests: string[] }).requests[0]);
      const text = JSON.parse(operation.insertBlocksRequest.payload).blocks[0].paragraph.elements[0].textRun.text;
      announcements.set(id, `${announcements.get(id) ?? ''}\n${text}`);
      return {} as T;
    }
    if (path.startsWith('/open-apis/im/v1/chats?') && method === 'GET') return { items: chats.map(({ chat_id, name }) => ({ chat_id, name })), has_more: false } as T;
    if (path.startsWith('/open-apis/im/v1/chats?') && method === 'POST') { const chat_id = `oc_new${next++}`; announcements.set(chat_id, ''); return { chat_id } as T; }
    if (path.startsWith('/open-apis/im/v1/messages?') && method === 'POST') return { message_id: `om_sent${next++}` } as T;
    throw new Error(`Unexpected ${method} ${path}`);
  } };
  return { api, calls, announcements, creates: () => calls.filter(call => call.method === 'POST' && call.path.startsWith('/open-apis/im/v1/chats?')) };
}
async function stateDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nootify-threads-')); t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a session gets one group: created once, reused afterwards, routed by its announcement token', async t => {
  const dir = await stateDir(t);
  const state = await State.open(dir);
  const feishu = fakeFeishu();
  const reports: Record<string, unknown>[] = [];
  const threads = new LarkThreads(state, feishu.api, record => reports.push(record));
  await assert.rejects(threads.open('codex', 'thread-1', 'Fix login'), /recipient/);
  await assert.rejects(threads.setRecipient('not-an-open-id'), /open_id/);
  await threads.setRecipient('ou_owner');
  const [first, second] = await Promise.all([threads.open('codex', 'thread-1', 'Fix login'), threads.open('codex', 'thread-1', 'Fix login')]);
  assert.deepEqual(first, second);
  assert.equal(first.created, true);
  assert.equal(feishu.creates().length, 1, 'concurrent calls share one creation');
  assert.equal(feishu.creates()[0].body?.name, 'Fix login · Codex · thread-1');
  assert.deepEqual(feishu.creates()[0].body?.user_id_list, ['ou_owner']);
  assert.ok(feishu.announcements.get(first.chat_id)?.includes(`agent-session:v1:${hostname()}:codex:thread-1`));
  const again = await threads.open('codex', 'thread-1', 'Renamed later');
  assert.deepEqual([again.created, again.chat_id, again.session_name], [false, first.chat_id, 'Fix login']);
  assert.equal(feishu.creates().length, 1);
  const reopened = await State.open(dir);
  assert.equal(reopened.bindings.get(first.chat_id)?.sender_open_id, 'ou_owner');
  assert.equal(reopened.settings.lark_recipient_open_id, 'ou_owner');

  const sent = await threads.send('thread-1', 'Tests pass', 'codex');
  const message = feishu.calls.at(-1)!;
  assert.equal(message.body?.receive_id, first.chat_id);
  assert.equal(JSON.parse(message.body?.content).text, '[Fix login] Tests pass');
  assert.match(sent.message_id, /^om_/);
  await assert.rejects(threads.send('unknown-session', 'hello'), /thread-open/);
  await assert.rejects(threads.send('thread-1', '   '), /empty/);
  assert.deepEqual(reports.map(record => record.status), ['thread_created', 'thread_reused', 'thread_message']);
});

test('groups created before Nootify managed them are adopted from their announcement, not duplicated', async t => {
  const id = 'local_dd316d46-36e3-4dd8-b702-46945713e9a4';
  const state = await State.open(await stateDir(t));
  // One trusted sender among existing bindings doubles as the recipient.
  state.bindings.set('oc_older', { chat_id: 'oc_older', session_id: 'local_old', sender_open_id: 'ou_owner' });
  const feishu = fakeFeishu([
    { chat_id: 'oc_other', name: '别的任务 · Claude · dd316d46', announcement: 'Claude 会话 local_dd316d46-0000-0000-0000-000000000000' },
    { chat_id: 'oc_mine', name: '上游页面 · Claude · dd316d46', announcement: `Claude 会话 ${id}` },
  ]);
  const info = await new LarkThreads(state, feishu.api).open('claude-desktop', id, '上游页面');
  assert.deepEqual([info.chat_id, info.created], ['oc_mine', false]);
  assert.equal(feishu.creates().length, 0);
  assert.ok(feishu.announcements.get('oc_mine')?.includes(`agent-session:v1:${hostname()}:claude-desktop:${id}`), 'the structured token is added');
  assert.equal(state.bindings.get('oc_mine')?.sender_open_id, 'ou_owner');
});

test('progress is never sent to a group whose announcement has changed to another route', async t => {
  const state = await State.open(await stateDir(t));
  state.bindings.set('oc_current', { chat_id: 'oc_current', session_id: 'thread-1', adapter: 'codex', session_name: 'Original', sender_open_id: 'ou_owner' });
  const feishu = fakeFeishu();
  const threads = new LarkThreads(state, feishu.api);
  for (const token of [
    `agent-session:v1:${hostname()}:codex:thread-2`,
    `agent-session:v1:${hostname()}:claude-code:thread-1`,
    `agent-session:v1:${hostname()}-other:codex:thread-1`,
    '',
  ]) {
    feishu.announcements.set('oc_current', token);
    await assert.rejects(threads.send('thread-1', 'Progress', 'codex'));
  }
  assert.ok(!feishu.calls.some(call => call.path.startsWith('/open-apis/im/v1/messages?')));
  feishu.announcements.set('oc_current', `agent-session:v1:${hostname()}:codex:thread-1`);
  assert.match((await threads.send('thread-1', 'Progress', 'codex')).message_id, /^om_/);
});

test('an announcement read failure stops adoption without creating a duplicate group', async t => {
  const state = await State.open(await stateDir(t));
  state.settings.lark_recipient_open_id = 'ou_owner';
  const feishu = fakeFeishu([{ chat_id: 'oc_existing', name: 'Task · Codex · thread-1', announcement: `agent-session:v1:${hostname()}:codex:thread-1` }]);
  let failRead = true;
  const api: LarkApi = { appId: feishu.api.appId, async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    if (failRead && path.endsWith('/announcement')) { failRead = false; throw new Error('announcement timeout'); }
    return feishu.api.request<T>(method, path, body);
  } };
  const threads = new LarkThreads(state, api);
  await assert.rejects(threads.open('codex', 'thread-1', 'Task'), /announcement timeout/);
  assert.equal(feishu.creates().length, 0);
  assert.equal(state.bindings.size, 0);
  const retried = await threads.open('codex', 'thread-1', 'Task');
  assert.deepEqual([retried.chat_id, retried.created], ['oc_existing', false]);
  assert.equal(feishu.creates().length, 0);
});

test('switching apps retains old groups without reusing their bindings or trusted senders', async t => {
  const state = await State.open(await stateDir(t));
  state.bindings.set('oc_oldApp', { app_id: 'cli_other', chat_id: 'oc_oldApp', session_id: 'thread-1', adapter: 'codex', sender_open_id: 'ou_oldAppUser' });
  const feishu = fakeFeishu(); const threads = new LarkThreads(state, feishu.api);
  assert.equal(threads.binding('thread-1', 'codex'), undefined);
  assert.equal(threads.recipient(), undefined, 'another app cannot supply the recipient');
  await threads.setRecipient('ou_newAppUser');
  const group = await threads.open('codex', 'thread-1', 'Same session, different app');
  assert.equal(group.created, true); assert.notEqual(group.chat_id, 'oc_oldApp');
  assert.equal(state.bindings.get(group.chat_id)?.app_id, feishu.api.appId);
  assert.equal(state.bindings.get('oc_oldApp')?.sender_open_id, 'ou_oldAppUser');
  assert.deepEqual(feishu.creates()[0]?.body?.user_id_list, ['ou_newAppUser']);
});

test('group names keep the session convention within Feishu\'s length', () => {
  const name = threadName('一个很长的任务名称'.repeat(10), 'claude-desktop', 'local_dd316d46-36e3-4dd8-b702-46945713e9a4');
  assert.ok(name.endsWith(' · Claude · dd316d46'));
  assert.equal([...name].length, 60);
});
