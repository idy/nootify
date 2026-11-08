import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { CodexDesktop } from '../src/codex-desktop.js';
import { ExternalSessions } from '../src/external-sessions.js';
import { LarkService } from '../src/lark.js';
import type { LarkApi } from '../src/lark-metadata.js';
import { SessionsService } from '../src/sessions.js';
import { State } from '../src/state.js';
import { RetryableDeliveryError, UnconfirmedDeliveryError } from '../src/types.js';

const options = { skip: process.platform === 'win32' };
const thread = 'desktop-existing-thread';
interface Request {
  type: string; requestId: string; sourceClientId: string; method: string; version: number; targetClientId?: string; hostId?: string;
  params: { conversationId?: string; hostId?: string; turnStart?: { request: { threadId: string; input: unknown; clientUserMessageId: string }; context: unknown };
    clientUserMessageId?: string; input?: unknown; restoreMessage?: { context: unknown } };
  response?: { canHandle: boolean };
}
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
async function fixture(t: TestContext, mode: 'active' | 'idle' | 'timeout' | 'disconnect' | 'error' | 'wrong-owner' | 'no-receipt' = 'active',
  initial: 'socket' | 'missing' | 'file' = 'socket') {
  const directory = await mkdtemp(join(tmpdir(), 'ncd-'));
  const path = join(directory, 'ipc.sock');
  const sockets = new Set<Socket>(); const requests: Request[] = [];
  let resumed = true; let owned = true; let supportsInput = true; let connections = 0;
  const server = createServer(socket => {
    connections++;
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0); if (buffered.length < length + 4) return;
        const request = JSON.parse(buffered.subarray(4, length + 4).toString()) as Request;
        buffered = buffered.subarray(length + 4); requests.push(request);
        if (request.type === 'client-discovery-response') continue;
        assert.equal(request.type, 'request');
        let result: unknown = {}; let error: string | undefined;
        let owner = request.method === 'initialize' ? 'nootify-client' : 'desktop-owner';
        if (request.method === 'initialize') {
          assert.equal(request.version, 0); assert.equal(request.sourceClientId, 'initializing-client');
          result = { clientId: 'nootify-client' };
          socket.write(frame({ type: 'client-discovery-request', requestId: 'discovery', request: {} }));
          socket.write(frame({ type: 'broadcast', method: 'unrelated', params: { private: 'must never become a receipt' } }));
        } else {
          assert.equal(request.sourceClientId, 'nootify-client');
          assert.equal(request.hostId, undefined, 'an outer hostId changes follower protocol versions');
          assert.equal(request.params.conversationId, thread);
          if (request.method === 'thread-owner-discovery') {
            assert.equal(request.version, 1); assert.equal(request.params.hostId, 'local');
            if (!owned) error = 'no-client-found';
            result = { supportsUntrustedAppInput: supportsInput };
          } else {
            assert.equal(request.targetClientId, 'desktop-owner');
            if (request.method === 'thread-follower-read-model-settings') {
              assert.equal(request.version, 1); result = { settings: { resumeState: resumed ? 'resumed' : 'needs_resume' } };
            } else if (request.method === 'thread-follower-steer-turn') {
              assert.equal(request.version, 1); assert.ok(request.params.restoreMessage?.context);
              if (mode === 'timeout') continue;
              if (mode === 'disconnect') { socket.destroy(); return; }
              if (mode === 'idle') error = `Cannot steer conversation ${thread} because its active turn already ended`;
              if (mode === 'error') error = 'unexpected error after input might have been accepted';
              if (mode === 'wrong-owner') owner = 'other-owner';
              result = { result: mode === 'no-receipt' ? {} : { turnId: 'active-turn' } };
            } else if (request.method === 'thread-follower-start-turn') {
              assert.equal(request.version, 2); assert.equal(mode, 'idle');
              assert.equal(request.params.turnStart?.request.threadId, thread);
              assert.deepEqual(request.params.turnStart?.context, { inheritThreadSettings: true });
              result = { result: { turn: { id: 'started-turn' } } };
            } else assert.fail(`Unexpected request: ${request.method}`);
          }
        }
        const response = frame(error ? { type: 'response', requestId: request.requestId, resultType: 'error', error }
          : { type: 'response', requestId: request.requestId, resultType: 'success', method: request.method, handledByClientId: owner, result });
        // Split headers and coalesce following frames on a real socket.
        socket.write(response.subarray(0, 2)); socket.write(response.subarray(2));
      }
    });
  });
  const listen = async () => { server.listen(path); await once(server, 'listening'); };
  if (initial === 'socket') await listen();
  else if (initial === 'file') await writeFile(path, 'temporarily not a socket');
  const desktop = new CodexDesktop(path, 1000, mode === 'timeout' ? 30 : 1000);
  t.after(async () => {
    desktop.close(); for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, path, requests, desktop, setResumed(value: boolean) { resumed = value; }, setOwned(value: boolean) { owned = value; },
    setSupportsInput(value: boolean) { supportsInput = value; }, connections() { return connections; },
    async stopSocket() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
    async restoreSocket() { await rm(path, { force: true }); await listen(); } };
}

for (const mode of ['active', 'idle'] as const) test(`Desktop ${mode} thread accepts input in its existing owner`, options, async t => {
  const f = await fixture(t, mode);
  assert.deepEqual(await f.desktop.send(thread, 'Hello Codex'), { status: 'input_accepted' });
  const inputs = f.requests.filter(request => request.type === 'request' && request.method.startsWith('thread-follower-') && request.method !== 'thread-follower-read-model-settings');
  assert.deepEqual(inputs.map(request => request.method), mode === 'active' ? ['thread-follower-steer-turn']
    : ['thread-follower-steer-turn', 'thread-follower-start-turn']);
  if (mode === 'idle') assert.equal(inputs[0].params.clientUserMessageId, inputs[1].params.turnStart?.request.clientUserMessageId);
  assert.ok(f.requests.some(request => request.type === 'client-discovery-response' && request.response?.canHandle === false));
  assert.ok(f.requests.every(request => !['thread/list', 'thread/start', 'thread/resume', 'thread/unarchive'].includes(request.method)));
});

for (const mode of ['timeout', 'disconnect', 'error', 'wrong-owner', 'no-receipt'] as const) {
  test(`Desktop ${mode} after input never falls back to another turn`, options, async t => {
    const f = await fixture(t, mode);
    await assert.rejects(f.desktop.send(thread, 'deliver once'), UnconfirmedDeliveryError);
    assert.equal(f.requests.filter(request => request.method === 'thread-follower-steer-turn').length, 1);
    assert.equal(f.requests.filter(request => request.method === 'thread-follower-start-turn').length, 0);
  });
}

test('Desktop rejects missing owners, unloaded threads and unsupported owner versions before input', options, async t => {
  const f = await fixture(t);
  f.setOwned(false); await assert.rejects(f.desktop.send(thread, 'no input'), /session_offline/);
  f.setOwned(true); f.setResumed(false); await assert.rejects(f.desktop.send(thread, 'no resume'), /session_offline/);
  f.setResumed(true); f.setSupportsInput(false); await assert.rejects(f.desktop.send(thread, 'no legacy fallback'), /unsupported_adapter/);
  assert.equal(f.requests.filter(request => request.method === 'thread-follower-steer-turn' || request.method === 'thread-follower-start-turn').length, 0);
});

for (const initial of ['missing', 'file'] as const) test(`Desktop reconnects after ${initial} socket validation fails`, options, async t => {
  const f = await fixture(t, 'active', initial);
  await assert.rejects(f.desktop.ready(thread), RetryableDeliveryError);
  assert.equal(f.requests.length, 0, 'validation failure must not submit any input');
  await f.restoreSocket();
  assert.deepEqual(await f.desktop.send(thread, 'input after recovery'), { status: 'input_accepted' });
  assert.equal(f.requests.filter(request => request.method === 'initialize').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'thread-follower-steer-turn').length, 1);
});

for (const replace of [false, true]) test(replace ? 'closing an opening Desktop client leaves a replacement usable'
  : 'closing an opening Desktop client cancels socket validation', options, async t => {
  const f = await fixture(t);
  const opening = f.desktop.open();
  // Close synchronously, before asynchronous socket validation can finish.
  f.desktop.close();
  const replacement = replace ? f.desktop.ready(thread) : undefined;
  await assert.rejects(opening, RetryableDeliveryError);
  if (replacement) await replacement;
  assert.deepEqual(await f.desktop.send(thread, 'input after cancelled open'), { status: 'input_accepted' });
  assert.equal(f.connections(), 1, 'the cancelled open must not create an orphaned connection');
  assert.equal(f.requests.filter(request => request.method === 'initialize').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'thread-follower-steer-turn').length, 1);
});

test('a regular file cannot stand in for the Desktop socket', options, async t => {
  const f = await fixture(t); const path = join(f.directory, 'not-a-socket'); await writeFile(path, 'private data');
  const desktop = new CodexDesktop(path);
  await assert.rejects(desktop.ready(thread), RetryableDeliveryError); desktop.close();
});

for (const reconnect of [false, true]) test(reconnect ? 'Feishu safely retries a Desktop reconnect failure before input'
  : 'Feishu receives its reaction only after automatic Desktop routing is accepted', options, async t => {
  const f = await fixture(t, 'idle');
  const db = new DatabaseSync(join(f.directory, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, archived INTEGER NOT NULL)');
  db.prepare('INSERT INTO threads VALUES (?, ?, 0)').run(thread, 'Existing Desktop conversation'); db.close();
  const state = await State.open(join(f.directory, 'nootify'));
  state.bindings.set('oc_desktop', { chat_id: 'oc_desktop', session_id: thread, sender_open_id: 'ou_owner', adapter: 'codex' });
  const external = new ExternalSessions(state, { codexHome: f.directory, codexDesktopSocket: f.path });
  if (reconnect) {
    const ready = CodexDesktop.prototype.ready;
    let disconnect = true;
    t.mock.method(CodexDesktop.prototype, 'ready', async function(this: CodexDesktop, id: string) {
      const owner = await ready.call(this, id);
      if (disconnect) {
        disconnect = false;
        this.close();
        await f.stopSocket();
      }
      return owner;
    });
  }
  const sessions = new SessionsService(state, { async inspect() { assert.fail('Must not route to Claude'); } }, undefined, external);
  const reactions: string[] = [];
  const api: LarkApi = { appId: 'cli_desktop', async request<T>(_method: string, path: string): Promise<T> {
    if (path.endsWith('/reactions')) {
      assert.equal(state.larkDelivery('om_desktop')?.transport_status, 'input_accepted'); reactions.push(path);
      return { reaction_id: 'receipt' } as T;
    }
    return { revision: '1', content: `agent-session:v1:${hostname()}:codex:${thread}` } as T;
  } };
  const lark = new LarkService(state, sessions, undefined, undefined, api);
  try {
    assert.equal(state.backends.size, 0, 'no guessed WebSocket endpoint is needed');
    const payload = { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: {
      chat_id: 'oc_desktop', message_id: 'om_desktop', message_type: 'text', content: JSON.stringify({ text: 'hello' }) } };
    if (reconnect) {
      assert.equal(await lark.enqueue(payload), false, 'a disconnect before input must retain the reply for retry');
      assert.equal(state.larkDelivery('om_desktop')?.transport_status, 'delivery_failed');
      assert.equal(state.larkDelivery('om_desktop')?.retryable, true);
      assert.equal(reactions.length, 0);
      assert.equal(f.requests.filter(request => request.method === 'thread-follower-steer-turn' || request.method === 'thread-follower-start-turn').length, 0);
      await f.restoreSocket();
    }
    assert.equal(await lark.enqueue(payload), true); assert.equal(await lark.enqueue(payload), true);
    assert.equal(state.larkDelivery('om_desktop')?.transport_status, 'input_accepted');
    assert.equal(state.larkDelivery('om_desktop')?.retryable, undefined);
    assert.equal(reactions.length, 1);
    assert.equal(f.requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
  } finally { await lark.stop(); await sessions.stop(); }
});
