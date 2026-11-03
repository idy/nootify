import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalSessions } from '../src/local-sessions.js';
import type { LocalSession, SessionCatalog } from '../src/local-sessions.js';
import { State } from '../src/state.js';
import { SessionsService } from '../src/sessions.js';
import { LarkService } from '../src/lark.js';
import { parseAnnouncement } from '../src/lark-metadata.js';
import type { LarkApi } from '../src/lark-metadata.js';

const id = 'local_12345678-1234-1234-1234-123456789abc';
const marker = `agent-session:v1:${hostname()}:claude-desktop:${id}`;
test('announcements support structured markers, styled fragments and full Desktop IDs', () => {
  assert.equal(parseAnnouncement(marker).session_id, id);
  assert.equal(parseAnnouncement(`Claude 会话 ${id}`).session_id, id);
  assert.equal(parseAnnouncement([{ text: { elements: [{ text_run: { content: marker.slice(0, 30) } }, { text_run: { content: marker.slice(30) } }] } }]).session_id, id);
  assert.throws(() => parseAnnouncement('No session declared'), /missing_announcement/);
  assert.throws(() => parseAnnouncement(`${marker}\n${marker}-other`), /ambiguous_announcement/);
});

test('Desktop discovery reads actual archive state every time and rejects stale runtime records', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-discovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'desktop'); const profile = join(root, 'account/profile'); const registry = join(dir, 'sessions');
  await mkdir(profile, { recursive: true }); await mkdir(registry);
  const socket = join(dir, 'live.sock'); const server = createServer(connection => connection.end());
  server.listen(socket); await once(server, 'listening'); t.after(() => server.close());
  const path = join(profile, `${id}.json`);
  const metadata = { sessionId: id, cliSessionId: 'runtime-test', title: 'Real local session', isArchived: false };
  await writeFile(path, JSON.stringify(metadata));
  const runtime = { pid: process.pid, sessionId: 'runtime-test', hostSessionId: id, messagingSocketPath: socket };
  const registryPath = join(registry, `${process.pid}.json`);
  await writeFile(registryPath, JSON.stringify(runtime));
  const catalog = new LocalSessions({ desktopRoots: [root], registryDir: registry });
  assert.equal((await catalog.inspect(id, 'claude-desktop'))?.availability, 'active');
  await writeFile(path, JSON.stringify({ ...metadata, isArchived: true }));
  assert.equal((await catalog.inspect(id, 'claude-desktop'))?.availability, 'archived');
  assert.equal((await catalog.inspect(id, 'claude-desktop'))?.socket_path, undefined);
  await writeFile(path, JSON.stringify(metadata));
  await writeFile(registryPath, JSON.stringify({ ...runtime, messagingSocketPath: join(dir, 'missing.sock') }));
  assert.equal((await catalog.inspect(id, 'claude-desktop'))?.availability, 'offline');
  await writeFile(path, JSON.stringify({ sessionId: id }));
  assert.equal((await catalog.inspect(id, 'claude-desktop'))?.availability, 'unknown');
  assert.equal(await catalog.inspect('local_absent', 'claude-desktop'), undefined);
  assert.equal(await catalog.inspect('../escape', 'claude-desktop'), undefined);
});

test('announcement routing needs no manual group mapping and logs archive, local and offline decisions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-route-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socket = join(dir, 'inbox.sock'); const received: string[] = [];
  const server = createServer(connection => {
    connection.on('data', data => received.push(data.toString())); connection.on('end', () => connection.end());
  });
  server.listen(socket); await once(server, 'listening'); t.after(() => server.close());
  const state = await State.open(dir);
  // Only establishes the allowed user; incoming events use an entirely different chat.
  state.bindings.set('oc_registration', { chat_id: 'oc_registration', session_id: 'local_old', sender_open_id: 'ou_allowed' });
  let local: LocalSession | undefined = { session_id: id, host_id: hostname(), adapter: 'claude-desktop', session_name: 'Discovered', availability: 'active', socket_path: socket };
  const catalog: SessionCatalog = { async inspect(target) { return target === local?.session_id ? local : undefined; } };
  let announcement = marker;
  const api: LarkApi = { appId: 'cli_test', async request<T>(_method: string, path: string): Promise<T> {
    assert.ok(path.endsWith('/oc_new/announcement'));
    return { revision: '1', content: announcement } as T;
  } };
  const logs: Record<string, unknown>[] = [];
  const service = new LarkService(state, new SessionsService(state, catalog), undefined, record => logs.push(record), api);
  const event = (n: number) => ({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_allowed' } }, message: {
    chat_id: 'oc_new', message_id: `om_${n}`, message_type: 'text', content: JSON.stringify({ text: `message ${n}` }),
  } });
  service.enqueue(event(1)); await service.drain();
  assert.ok(received.join('').includes('message 1'));
  assert.ok(logs.some(log => log.status === 'socket_written'));
  const writes = received.length;
  local = { ...local!, availability: 'archived' }; service.enqueue(event(2)); await service.drain();
  assert.equal(logs.at(-1)?.reason, 'session_archived');
  local = { ...local, availability: 'offline' }; service.enqueue(event(3)); await service.drain();
  assert.equal(logs.at(-1)?.reason, 'session_offline');
  local = undefined; service.enqueue(event(4)); await service.drain();
  assert.equal(logs.at(-1)?.reason, 'session_not_local');
  announcement = 'No routing information'; service.enqueue(event(5)); await service.drain();
  assert.equal(logs.at(-1)?.reason, 'missing_announcement');
  assert.equal(received.length, writes);
  assert.equal(state.sessions.size, 0);
  assert.equal(state.bindings.has('oc_new'), false);
});
