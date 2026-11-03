import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { State } from '../src/state.js';
import { SessionsService } from '../src/sessions.js';
import { ExternalSessions } from '../src/external-sessions.js';
import { createServiceHost } from '../src/server.js';
import { EventLog } from '../src/events.js';
import { parseAnnouncement } from '../src/lark-metadata.js';

async function stateFor(t: TestContext): Promise<State> {
  const dir = await mkdtemp(join(tmpdir(), 'ws-lazy-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return State.open(dir);
}
test('repeated UI snapshots and session lists perform zero client lookups', async t => {
  const state = await stateFor(t); const logs = await EventLog.open(state.directory);
  let claudeLookups = 0; let otherLookups = 0;
  const sessions = new SessionsService(state, { async inspect() { claudeLookups++; return; } }, undefined,
    { async resolve() { otherLookups++; return; }, close() {} });
  const server = createServiceHost([sessions], state.token, logs);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (let i = 0; i < 3; i++) {
    const snapshot = await (await fetch(url + '/ui/api/snapshot')).json() as { sessions: unknown[] };
    assert.deepEqual(snapshot.sessions, []);
    assert.deepEqual(await sessions.handle({ method: 'GET', path: '/v1/sessions', body: undefined }), { body: [] });
  }
  assert.equal(claudeLookups, 0); assert.equal(otherLookups, 0);
  await assert.rejects(sessions.send('missing-thread', 'hello', 'codex'), /session_not_local/);
  assert.equal(claudeLookups, 0); assert.equal(otherLookups, 1);
  const known = (await sessions.handle({ method: 'GET', path: '/v1/sessions', body: undefined }))!.body as { adapter: string; availability: string }[];
  assert.equal(known.length, 1); assert.equal(known[0].adapter, 'codex'); assert.equal(known[0].availability, 'missing');
  assert.equal(otherLookups, 1);
});

test('provider-labeled announcements select Codex or OpenCode without assuming Claude', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  assert.deepEqual(parseAnnouncement(`Codex thread ${id}`), { adapter: 'codex', session_id: id });
  assert.deepEqual(parseAnnouncement('OpenCode session ses_test123'), { adapter: 'opencode', session_id: 'ses_test123' });
});

test('OpenCode looks up only the requested ID and never posts to missing or archived sessions', async t => {
  const state = await stateFor(t); const requests: string[] = [];
  let archived = false;
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path.includes('ses_missing')) { response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"name":"NotFoundError"}'); return; }
    if (request.method === 'POST') { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'ses_test', title: 'OpenCode test', directory: '/project', time: { created: 1, updated: 2, ...(archived ? { archived: 3 } : {}) } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  state.backends.set('opencode', { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, directory: '/project' });
  const external = new ExternalSessions(state);
  const sessions = new SessionsService(state, { async inspect() { assert.fail('Must not read Claude metadata'); } }, undefined, external);
  assert.equal(requests.length, 0);
  assert.equal((await sessions.send('ses_test', 'Hello OpenCode', 'opencode')).status, 'input_accepted');
  assert.equal(requests.length, 2); assert.match(requests[0], /^GET \/session\/ses_test\?/); assert.match(requests[1], /^POST \/session\/ses_test\/prompt_async\?/);
  archived = true;
  await assert.rejects(sessions.send('ses_test', 'no delivery', 'opencode'), /session_archived/);
  await assert.rejects(sessions.send('ses_missing', 'no delivery', 'opencode'), /session_not_local/);
  assert.equal(requests.filter(request => request.startsWith('POST')).length, 1);
  assert.ok(requests.every(request => !/^GET \/session(?:\?|$)/.test(request)), 'No session listing is allowed');
});

test('Codex uses one indexed lookup and only the specified live app-server thread', async t => {
  const state = await stateFor(t);
  const db = new DatabaseSync(join(state.directory, 'state_5.sqlite'));
  t.after(() => db.close());
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, archived INTEGER NOT NULL)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('thread_test', 'Codex test', 0);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('thread_archived', 'Archived test', 1);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const calls: { method: string; params?: Record<string, unknown> }[] = []; let connections = 0; let active = false;
  server.on('connection', socket => {
    connections++;
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString()) as { id?: number; method: string; params?: Record<string, unknown> };
      calls.push(message); if (message.id === undefined) return;
      let result: unknown = {};
      if (message.method === 'thread/read') result = { thread: { id: 'thread_test', name: 'Codex test', status: { type: active ? 'active' : 'idle' } } };
      if (message.method === 'thread/turns/list') result = { data: [{ id: 'turn_current', status: 'inProgress' }] };
      if (message.method === 'turn/start') result = { turn: { id: 'turn_current', status: 'inProgress' } };
      if (message.method === 'turn/steer') result = { turnId: 'turn_current' };
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  t.after(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  state.backends.set('codex', { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` });
  const external = new ExternalSessions(state, { codexHome: state.directory }); t.after(() => external.close());
  const sessions = new SessionsService(state, { async inspect() { assert.fail('Must not inspect Claude'); } }, undefined, external);
  assert.equal(connections, 0);
  await assert.rejects(sessions.send('thread_missing', 'no delivery', 'codex'), /session_not_local/);
  await assert.rejects(sessions.send('thread_archived', 'no delivery', 'codex'), /session_archived/);
  assert.equal(connections, 0);
  assert.equal((await sessions.send('thread_test', 'new input', 'codex')).status, 'input_accepted');
  assert.ok(calls.some(call => call.method === 'turn/start'));
  active = true;
  assert.equal((await sessions.send('thread_test', 'steering input', 'codex')).status, 'input_accepted');
  assert.ok(calls.some(call => call.method === 'turn/steer' && call.params?.expectedTurnId === 'turn_current'));
  assert.equal(connections, 1);
  assert.ok(calls.every(call => !['thread/list', 'thread/start', 'thread/resume', 'thread/unarchive'].includes(call.method)));
  assert.ok(calls.filter(call => call.method.startsWith('thread/') || call.method.startsWith('turn/')).every(call => call.params?.threadId === 'thread_test'));
});
