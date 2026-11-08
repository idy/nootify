import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { State } from '../src/state.js';
import { CoreError, ProviderCore, type CoreEvent, type CoreTransport } from '../src/provider-core.js';
import { ProvidersService, decodeMessageRef, encodeMessageRef, type ProviderPage } from '../src/providers.js';
import { SessionsService } from '../src/sessions.js';
import { RetryableDeliveryError } from '../src/types.js';
import { createServiceHost } from '../src/server.js';
import { EventLog } from '../src/events.js';
import type { TailnetAccess } from '../src/tailnet.js';
import { NootifyClient } from '../src/client.js';
import type { TsnetClient } from '../src/tsnet-client.js';

const page: ProviderPage = { node_id: 'local-node', providers: [], remote: { enabled: false, listen: '127.0.0.1:9418', status: 'disabled', tls: false, token_set: false, peers: [] } };
interface FakeBinding { provider_id: string; session: { node_id: string; adapter: string; session_id: string; name?: string }; created: boolean; deleted?: boolean }
class FakeCore implements CoreTransport {
  snapshot: ProviderPage = structuredClone(page);
  bindings: FakeBinding[] = [];
  calls: { method: string; params: Record<string, unknown> }[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const binding = method === 'session.ensure' ? { provider_id: String(params.provider_id ?? 'remote-one'), session: params.session as FakeBinding['session'], created: true } : undefined;
    if (binding) this.bindings.push(binding);
    const result = method === 'status' ? this.snapshot : method === 'session.list' ? this.bindings : binding
      ?? (method === 'remote.secret' ? { token: 'private-peer-token' } : { message_id: 'reply-id' });
    return result as T;
  }
}
async function fixture(t: { after(fn: () => unknown): void }, session?: Partial<SessionsService>, tsnet?: TsnetClient) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-providers-'));
  const state = await State.open(directory);
  const core = new FakeCore();
  const sessions = session as SessionsService ?? new SessionsService(state);
  const providers = new ProvidersService(state, sessions, undefined, undefined, 9417, tsnet, core);
  await providers.start();
  t.after(async () => { await providers.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, state, core, sessions, providers };
}

test('private core bridge handles asynchronous events while a request is outstanding and closes on EOF', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-core-bridge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'fixture.cjs');
  await writeFile(script, `const readline = require('node:readline');
process.stdout.write(JSON.stringify({id:0,result:{ready:true,node_id:'node'}})+'\\n');
let waiting;
readline.createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line);
 if(r.method==='wait') { waiting=r.id; process.stdout.write(JSON.stringify({event:'delivery',data:{delivery_id:'d'}})+'\\n'); }
 else { process.stdout.write(JSON.stringify({id:r.id,result:{ok:true}})+'\\n');
 if(waiting) {process.stdout.write(JSON.stringify({id:waiting,result:{completed:true}})+'\\n');waiting=undefined;} }
});
`);
  const events: CoreEvent[] = [];
  const core = new ProviderCore(join(directory, 'state'), event => {
    events.push(event); void core.request('delivery.complete', { delivery_id: event.data.delivery_id });
  }, { file: process.execPath, args: [script] }, 2000);
  t.after(() => core.stop());
  await core.start();
  assert.deepEqual(await core.request('wait'), { completed: true });
  assert.equal(events[0].event, 'delivery');
  await core.stop();
  await assert.rejects(core.request('status'), (error: unknown) => error instanceof CoreError && error.code === 'unavailable');
});

test('HTTP and stdio deadlines leave time for the core terminal response and preserve explicit send IDs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-deadline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'fixture.cjs');
  await writeFile(script, `const readline = require('node:readline');
process.stdout.write(JSON.stringify({id:0,result:{ready:true}})+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line);process.stdout.write(JSON.stringify({id:r.id,result:{done:true}})+'\\n');
});`);
  const core = new ProviderCore(join(directory, 'state'), () => {}, { file: process.execPath, args: [script] });
  t.after(() => core.stop());
  await core.start();
  const originalTimeout = globalThis.setTimeout;
  const timers: number[] = [];
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    timers.push(timeout ?? 0); return originalTimeout(fn, timeout, ...args);
  }) as typeof globalThis.setTimeout);
  assert.deepEqual(await core.request('message.send'), { done: true });
  assert.ok(timers.some(timeout => timeout > 60_000), 'stdio must outlive the core 60-second deadline');
  let clientTimeout = 0; let sent: Record<string, unknown> | undefined;
  t.mock.method(AbortSignal, 'timeout', (timeout: number) => { clientTimeout = timeout; return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ message_id: 'message-result' });
  });
  const client = new NootifyClient({ token: 'synthetic-token' });
  await client.sendThread('session-a', 'progress', 'codex', undefined, 'remote-a', 'stable-attempt');
  assert.equal(sent?.request_id, 'stable-attempt'); assert.equal(sent?.provider_id, 'remote-a');
  assert.ok(clientTimeout > Math.max(...timers), 'HTTP must outlive the stdio request');
});

test('thread-send leaves automatic retry identity with the durable core and preserves explicit IDs', async t => {
  const { providers, core } = await fixture(t, { sessionName: id => id });
  const request = { method: 'POST', path: '/v1/threads/session-a/messages', body: { adapter: 'codex', text: 'progress' } };
  await providers.handle(request); await providers.handle(request);
  const sends = core.calls.filter(call => call.method === 'message.send');
  assert.equal(sends.length, 2);
  assert.ok(sends.every(call => !Object.hasOwn(call.params, 'request_id')), 'bridge must not replace uncertain attempts with random IDs');
  await providers.handle({ ...request, body: { ...request.body, request_id: 'explicit-retry' } });
  assert.equal(core.calls.at(-1)?.params.request_id, 'explicit-retry');
});

test('provider message references keep source node and bot identity separate', () => {
  const first = { origin_node_id: 'node-a', provider_id: 'bot-a', message_id: 'same-id' };
  const second = { ...first, provider_id: 'bot-b' };
  assert.notEqual(encodeMessageRef(first), encodeMessageRef(second));
  assert.deepEqual(decodeMessageRef(encodeMessageRef(first)), first);
  assert.throws(() => decodeMessageRef(Buffer.from('{"message_id":"x"}').toString('base64url')), /origin_node_id/);
});

test('legacy session commands use full local identity and preserve explicit provider choice', async t => {
  const { providers, core } = await fixture(t, { sessionName: id => id });
  const opened = await providers.handle({ method: 'POST', path: '/v1/threads', body: {
    adapter: 'codex', session_id: 'agent-session', session_name: 'Work', provider_id: 'remote-one',
  } });
  assert.equal((opened?.body as { provider_id: string }).provider_id, 'remote-one');
  const ensure = core.calls.find(call => call.method === 'session.ensure')!;
  assert.deepEqual(ensure.params.session, { node_id: 'local-node', adapter: 'codex', session_id: 'agent-session', name: 'Work' });
  assert.equal(ensure.params.provider_id, 'remote-one');
  await providers.handle({ method: 'DELETE', path: '/v1/threads/agent-session', body: { adapter: 'codex', provider_id: 'remote-one' } });
  assert.equal(core.calls.at(-1)?.method, 'session.delete');
});

test('thread operations infer native adapters from durable local bindings and refuse ambiguous IDs', async t => {
  const { providers, core, state } = await fixture(t, { sessionName: id => id });
  const server = createServiceHost([providers], state.token);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new NootifyClient({ baseUrl, token: state.token });
  for (const adapter of ['codex', 'opencode', 'claude-code'] as const) {
    const id = `native-${adapter}`;
    await client.openThread({ adapter, session_id: id, session_name: adapter });
    assert.equal(state.sessions.has(id), false, 'native sessions are not cooperative inbox registrations');
    await client.sendThread(id, 'progress');
    assert.equal((core.calls.at(-1)?.params.session as FakeBinding['session']).adapter, adapter);
    const metadata = await fetch(`${baseUrl}/v1/threads/${id}/metadata`, { headers: { authorization: `Bearer ${state.token}` } });
    assert.equal(metadata.status, 200);
    await metadata.json();
    assert.equal(core.calls.at(-1)?.method, 'session.metadata.get');
    assert.equal((core.calls.at(-1)?.params.session as FakeBinding['session']).adapter, adapter);
  }
  core.bindings.push({ provider_id: 'foreign', session: { node_id: 'other-node', adapter: 'trae', session_id: 'native-codex' }, created: true });
  await providers.handle({ method: 'POST', path: '/v1/threads/native-codex/messages', body: { text: 'still local' } });
  assert.equal((core.calls.at(-1)?.params.session as FakeBinding['session']).adapter, 'codex');
  core.bindings.push({ provider_id: 'other', session: { node_id: page.node_id, adapter: 'opencode', session_id: 'native-codex' }, created: true });
  await assert.rejects(providers.handle({ method: 'POST', path: '/v1/threads/native-codex/messages', body: { text: 'ambiguous' } }), /multiple adapter bindings/);
  await providers.handle({ method: 'POST', path: '/v1/threads/native-codex/messages', body: { text: 'selected', provider_id: 'other' } });
  assert.equal((core.calls.at(-1)?.params.session as FakeBinding['session']).adapter, 'opencode');
  await assert.rejects(providers.handle({ method: 'GET', path: '/v1/threads/missing/metadata', body: undefined }), /No notification session/);
});

test('changing to a non-loopback listener withdraws the old Tailnet publication and retries failed cleanup', async t => {
  const network: { method: string; port: number; target?: string }[] = [];
  let failCleanup = false;
  const tsnet = { async publish(port: number, target: string) { network.push({ method: 'publish', port, target }); return { port }; },
    async unpublish(port: number) { network.push({ method: 'unpublish', port }); if (failCleanup) throw new Error('cleanup interrupted'); },
    async closeTunnel() {} } as unknown as TsnetClient;
  const { providers, core, state } = await fixture(t, { sessionName: id => id }, tsnet);
  state.settings.tailscale_enabled = true;
  core.snapshot.remote.enabled = true;
  await providers.syncNetwork();
  assert.deepEqual(network, [{ method: 'publish', port: 9418, target: '127.0.0.1:9418' }]);
  core.snapshot.remote.listen = '192.168.1.5:9443'; core.snapshot.remote.tls = true;
  failCleanup = true;
  await assert.rejects(providers.syncNetwork(), /cleanup interrupted/);
  failCleanup = false;
  await providers.syncNetwork();
  assert.deepEqual(network.slice(1), [{ method: 'unpublish', port: 9418 }, { method: 'unpublish', port: 9418 }]);
  await providers.syncNetwork();
  assert.equal(network.length, 3, 'removed publication must not remain tracked or be recreated for a LAN-only listener');
  core.snapshot.remote.listen = '127.0.0.1:9444';
  await providers.syncNetwork();
  assert.deepEqual(network.at(-1), { method: 'publish', port: 9444, target: '127.0.0.1:9444' });
  core.snapshot.remote.listen = '[fe80::1%en0]:9443';
  await providers.syncNetwork();
  assert.deepEqual(network.at(-1), { method: 'unpublish', port: 9444 }, 'LAN IPv6 zone listeners must withdraw the old publication too');
});

test('agent delivery returns true transport outcome and retains source reference in reply instructions', async t => {
  let received = '';
  const { providers, core } = await fixture(t, { send: async (_id, text) => { received = text; return { status: 'input_accepted' }; } });
  const delivery = { delivery_id: 'delivery-1', session: { node_id: 'local-node', adapter: 'codex', session_id: 'session-a' },
    message: { origin_node_id: 'upstream', provider_id: 'feishu-a', message_id: 'message-a' }, content: { text: 'hello' }, text: 'hello' };
  (providers as unknown as { event(e: CoreEvent): void }).event({ event: 'delivery', data: delivery });
  for (let attempt = 0; attempt < 20 && !core.calls.some(call => call.method === 'delivery.complete'); attempt++) await new Promise(resolve => setImmediate(resolve));
  const complete = core.calls.find(call => call.method === 'delivery.complete')!;
  assert.equal(complete.params.status, 'delivered');
  assert.equal(complete.params.transport_status, 'input_accepted');
  assert.match(received, /message-reply/);
  assert.match(received, new RegExp(encodeMessageRef(delivery.message)));
});

test('safe pre-submission failures and uncertain submissions have different completion states', async t => {
  let uncertain = false;
  const { providers, core } = await fixture(t, { send: async () => { throw uncertain ? new Error('input outcome lost') : new RetryableDeliveryError('not connected'); } });
  const event = { event: 'delivery', data: { delivery_id: 'safe', session: { adapter: 'codex', session_id: 'session-a' },
    message: { origin_node_id: 'a', provider_id: 'b', message_id: 'm' }, text: 'hello', content: { text: 'hello' } } };
  (providers as unknown as { event(e: CoreEvent): void }).event(event);
  for (let attempt = 0; attempt < 20 && !core.calls.some(call => call.method === 'delivery.complete'); attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(core.calls.find(call => call.method === 'delivery.complete')?.params.status, 'retryable');
  uncertain = true;
  (providers as unknown as { event(e: CoreEvent): void }).event({ ...event, data: { ...event.data, delivery_id: 'uncertain' } });
  for (let attempt = 0; attempt < 20 && core.calls.filter(call => call.method === 'delivery.complete').length < 2; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(core.calls.filter(call => call.method === 'delivery.complete')[1].params.status, 'unconfirmed');
});

test('tailnet browser clients cannot mutate providers or retrieve the remote access token', async t => {
  const { providers, state, directory, core } = await fixture(t, { sessionName: id => id });
  const logs = await EventLog.open(directory);
  const tailnet = { async authorize() { return undefined; }, url() { return 'http://100.64.0.1'; } } as unknown as TailnetAccess;
  const server = createServiceHost([], state.token, logs, { providers, via: 'tailnet', tailnet });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const read = await fetch(`${base}/ui/api/providers`);
  assert.equal((await read.json() as { editable: boolean }).editable, false);
  for (const path of ['/ui/api/providers', '/ui/api/settings/remote', '/ui/api/settings/remote/secret']) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'x-nootify-ui': '1' }, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.ok(!core.calls.some(call => ['provider.save', 'remote.configure', 'remote.secret'].includes(call.method)));
});

test('provider UI mutations and remote token reveal require local origin and the UI header', async t => {
  const { providers, state, directory } = await fixture(t, { sessionName: id => id });
  const logs = await EventLog.open(directory);
  const server = createServiceHost([], state.token, logs, { providers });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const read = await fetch(`${base}/ui/api/providers`); assert.equal(read.status, 200); assert.equal((await read.json() as { editable: boolean }).editable, true);
  const denied = await fetch(`${base}/ui/api/providers`, { method: 'POST', body: JSON.stringify({ action: 'delete', id: 'bot-a' }) });
  assert.equal(denied.status, 403);
  const secretGet = await fetch(`${base}/ui/api/settings/remote/secret`); assert.equal(secretGet.status, 405);
  const secret = await fetch(`${base}/ui/api/settings/remote/secret`, { method: 'POST', headers: { 'x-nootify-ui': '1' } });
  assert.deepEqual(await secret.json(), { token: 'private-peer-token' });
  assert.equal(JSON.stringify(await (await fetch(`${base}/ui/api/settings/remote`)).json()).includes('private-peer-token'), false);
});
