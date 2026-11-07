import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LarkApi } from '../src/lark-metadata.js';
import { LarkService } from '../src/lark.js';
import { LarkPoller } from '../src/lark-polling.js';
import { SessionsService } from '../src/sessions.js';
import { State } from '../src/state.js';

test('a known foreign-app group is rejected before allowed-sender fallback, while a genuinely unbound group still routes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-lark-ownership-'));
  const state = await State.open(directory);
  state.bindings.set('oc_oldApp', { app_id: 'cli_old', chat_id: 'oc_oldApp', session_id: 'old-session', adapter: 'codex', sender_open_id: 'ou_oldAppUser' });
  state.bindings.set('oc_current', { app_id: 'cli_current', chat_id: 'oc_current', session_id: 'current-session', adapter: 'codex', sender_open_id: 'ou_currentUser' });
  const sessions = new SessionsService(state);
  const send = t.mock.method(sessions, 'send', async () => ({ status: 'input_accepted' as const }));
  const reads: string[] = []; const reports: Record<string, unknown>[] = [];
  const api: LarkApi = { appId: 'cli_current', async request<T>(_method: string, path: string): Promise<T> {
    if (path.endsWith('/reactions')) return { reaction_id: 'reaction-received' } as T;
    reads.push(path);
    return { revision: '1', content: `agent-session:v1:${hostname()}:codex:current-session` } as T;
  } };
  const service = new LarkService(state, sessions, undefined, record => reports.push(record), api);
  t.after(async () => { await service.stop(); await sessions.stop(); await rm(directory, { recursive: true, force: true }); });
  const event = (chat_id: string, message_id: string, open_id = 'ou_currentUser') => ({
    sender: { sender_type: 'user', sender_id: { open_id } },
    message: { chat_id, message_id, message_type: 'text', content: JSON.stringify({ text: 'continue' }) },
  });
  // True means terminally handled, including a foreign-app rejection that must not be retried.
  assert.equal(await service.enqueue(event('oc_oldApp', 'om_foreign')), true);
  assert.equal(await service.enqueue(event('oc_oldApp', 'om_original', 'ou_oldAppUser')), true);
  await service.drain();
  assert.equal(reads.length, 0); assert.equal(send.mock.calls.length, 0);
  assert.equal(state.deliveries.size, 0);
  assert.deepEqual(reports.map(record => [record.status, record.reason]), [['ignored', 'app_mismatch'], ['ignored', 'app_mismatch']]);
  assert.equal(state.bindings.get('oc_oldApp')?.sender_open_id, 'ou_oldAppUser');
  // Keep the existing announcement-based path for groups with no stored owner.
  assert.equal(await service.enqueue(event('oc_unbound', 'om_unbound')), true);
  await service.drain();
  assert.equal(reads.length, 1); assert.match(reads[0]!, /oc_unbound\/announcement$/);
  assert.equal(send.mock.calls.length, 1);
  assert.equal(state.deliveries.get('om_unbound')?.transport_status, 'input_accepted');
  assert.equal(state.bindings.has('oc_unbound'), false);
});

test('polling skips foreign-app groups without creating cursors or requesting their histories', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-poll-ownership-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await State.open(directory);
  for (const [chat_id, app_id] of [['oc_old', 'cli_old'], ['oc_current', 'cli_current'], ['oc_legacy', undefined]] as const) {
    state.bindings.set(chat_id, { chat_id, app_id, session_id: 'local-session', adapter: 'codex', sender_open_id: 'ou_owner' });
  }
  const reads: string[] = [];
  const api: LarkApi = { appId: 'cli_current', async request<T>(_method: string, path: string): Promise<T> {
    reads.push(path);
    const url = new URL(path, 'https://open.feishu.cn');
    if (url.pathname === '/open-apis/bot/v3/info') return {} as T;
    if (url.pathname === '/open-apis/im/v1/chats') return { items: [...state.bindings.keys()].map(chat_id => ({ chat_id })), has_more: false } as T;
    assert.equal(url.pathname, '/open-apis/im/v1/messages');
    assert.notEqual(url.searchParams.get('container_id'), 'oc_old', 'the current app cannot read an old app group');
    return { items: [], has_more: false } as T;
  } };
  const poller = new LarkPoller({ state, api, now: () => 1_700_000_000_000, monotonic: () => 0, wait: async () => {},
    receive: async () => { throw new Error('Empty histories cannot deliver input'); }, status: () => {}, report: () => {} });
  assert.equal(await poller.pollOnce(), true);
  assert.equal(state.larkPollCursors.has('cli_current:chat:oc_old'), false);
  assert.equal(state.larkPollCursors.has('cli_current:chat:oc_current'), true);
  assert.equal(state.larkPollCursors.has('cli_current:chat:oc_legacy'), true);
  assert.ok(reads.some(path => new URL(path, 'https://open.feishu.cn').searchParams.get('container_id') === 'oc_current'));
});
