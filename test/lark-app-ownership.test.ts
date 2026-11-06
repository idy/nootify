import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LarkApi } from '../src/lark-metadata.js';
import { LarkService } from '../src/lark.js';
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
    reads.push(path);
    return { revision: '1', content: `agent-session:v1:${hostname()}:codex:current-session` } as T;
  } };
  const service = new LarkService(state, sessions, undefined, record => reports.push(record), api);
  t.after(async () => { await service.stop(); await sessions.stop(); await rm(directory, { recursive: true, force: true }); });
  const event = (chat_id: string, message_id: string, open_id = 'ou_currentUser') => ({
    sender: { sender_type: 'user', sender_id: { open_id } },
    message: { chat_id, message_id, message_type: 'text', content: JSON.stringify({ text: 'continue' }) },
  });
  // The current app trusts this sender in another group, but that cannot authorize an old app's group.
  assert.equal(service.enqueue(event('oc_oldApp', 'om_foreign')), false);
  assert.equal(service.enqueue(event('oc_oldApp', 'om_original', 'ou_oldAppUser')), false);
  await service.drain();
  assert.equal(reads.length, 0); assert.equal(send.mock.calls.length, 0);
  assert.equal(state.deliveries.size, 0);
  assert.deepEqual(reports.map(record => [record.status, record.reason]), [['ignored', 'app_mismatch'], ['ignored', 'app_mismatch']]);
  assert.equal(state.bindings.get('oc_oldApp')?.sender_open_id, 'ou_oldAppUser');
  // Keep the existing announcement-based path for groups with no stored owner.
  assert.equal(service.enqueue(event('oc_unbound', 'om_unbound')), true);
  await service.drain();
  assert.equal(reads.length, 1); assert.match(reads[0]!, /oc_unbound\/announcement$/);
  assert.equal(send.mock.calls.length, 1);
  assert.equal(state.deliveries.get('om_unbound')?.transport_status, 'input_accepted');
  assert.equal(state.bindings.has('oc_unbound'), false);
});
