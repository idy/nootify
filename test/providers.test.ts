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
import { TailnetAccess } from '../src/tailnet.js';
import { TailscaleService } from '../src/tailscale.js';
import { NootifyClient } from '../src/client.js';
import { SettingsService } from '../src/settings.js';
import { GitHubAuth } from '../src/github-auth.js';
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
    if (method === 'provider.save') {
      const provider = { id: String(params.id), name: String(params.name), type: params.type as 'remote' | 'feishu', enabled: params.enabled !== false,
        status: 'connected', ...(typeof params.address === 'string' ? { address: params.address } : {}) };
      this.snapshot.providers = [...this.snapshot.providers.filter(item => item.id !== provider.id), provider];
    } else if (method === 'provider.delete') this.snapshot.providers = this.snapshot.providers.filter(item => item.id !== params.id);
    else if (method === 'remote.configure') this.snapshot.remote = { ...this.snapshot.remote, ...params };
    else if (method === 'config.import') this.snapshot.providers = params.providers as ProviderPage['providers'];
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

for (const transition of ['disable', 'cancel', 'logout'] as const) {
  test(`intentional Tailscale ${transition} invalidates publications and tunnels before re-enable`, async t => {
    let online = false; let generation = 0;
    const publications: number[] = []; const tunnels: number[] = [];
    const tsnet = {
      async start() { online = true; generation++; },
      async stop() { online = false; },
      async status() { return { BackendState: 'Running', NootifyListening: true, User: { 1: { LoginName: 'synthetic@example.com' } },
        Self: { UserID: 1, TailscaleIPs: ['100.64.0.7'] } }; },
      async logout() {},
      async publish(port: number) { assert.ok(online, 'publish requires a live helper'); publications.push(generation); return { port }; },
      async unpublish() { assert.ok(online, 'must not clean up an expired publication through a stopped helper'); },
      async tunnel() { assert.ok(online); tunnels.push(generation); return { id: `tunnel-${generation}`, address: `127.0.0.1:${12000 + generation}` }; },
      async closeTunnel() { assert.ok(online, 'must not close a stale tunnel through a stopped helper'); },
    } as unknown as TsnetClient;
    const { providers, core, state } = await fixture(t, { sessionName: id => id }, tsnet);
    core.snapshot.remote.enabled = true;
    core.snapshot.providers = [{ id: 'upstream', name: 'Upstream', type: 'remote', enabled: true, status: 'connected', address: '100.64.0.9:9418' }];
    const tailscale = new TailscaleService({ state, access: new TailnetAccess(80, { probe: tsnet }), client: tsnet,
      listen: async () => ({ target: 'tcp://127.0.0.1:1', close: async () => {} }),
      disconnected: () => providers.networkDisconnected() });
    t.after(() => tailscale.stop());
    const dial = async (request_id: string) => {
      (providers as unknown as { event(e: CoreEvent): void }).event({ event: 'dial', data: { request_id, address: '100.64.0.9:9418' } });
      for (let i = 0; i < 100 && !core.calls.some(call => call.method === 'dial.complete' && call.params.request_id === request_id); i++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      const result = core.calls.find(call => call.method === 'dial.complete' && call.params.request_id === request_id);
      assert.ok(result, 'dial must settle'); return result.params.address;
    };
    await tailscale.setEnabled(true); await providers.syncNetwork();
    assert.equal(await dial('first-run'), '127.0.0.1:12001');
    if (transition === 'disable') await tailscale.setEnabled(false);
    else if (transition === 'cancel') await tailscale.cancelLogin();
    else await tailscale.logout();
    assert.equal(online, false);
    await providers.syncNetwork();
    await tailscale.setEnabled(true); await providers.syncNetwork();
    assert.equal(await dial('second-run'), '127.0.0.1:12002', 'must dial through the replacement helper');
    assert.deepEqual(publications, [1, 2], 'must republish the same port in the replacement helper');
    assert.deepEqual(tunnels, [1, 2], 'must not reuse the old helper tunnel');
  });
}

test('provider imports refresh real compatibility clients without rewriting imported providers', async t => {
  const { providers, core, state } = await fixture(t);
  const settings = new SettingsService({ state, lark: providers, providers, env: {},
    github: new GitHubAuth(state, () => {}, () => {}, 'synthetic-client'),
    pulls: { async preferences() { return { follow: [] }; }, async restore() {} },
    agents: { async list() { return []; }, async set() { throw new Error('No agent edits in this fixture'); } } });
  t.after(() => settings.stop());
  const credentials = { appId: 'cli_fedcba9876543210', appSecret: 'synthetic-import-secret' };
  const imported = { version: 1, providers: [{ id: 'legacy-feishu', type: 'feishu', name: 'Preserved imported name', enabled: false,
    app_id: credentials.appId, app_secret: credentials.appSecret, recipient_open_id: 'ou_preserved' }] };
  await settings.importConfig({ format: 'nootify-config', version: 1, providers: imported,
    lark: { app_id: credentials.appId, app_secret: credentials.appSecret } });
  assert.deepEqual(providers.credentials, credentials);
  assert.equal(providers.api?.appId, credentials.appId);
  assert.deepEqual(settings.larkSecret(), { app_id: credentials.appId, app_secret: credentials.appSecret });
  assert.equal(core.calls.filter(call => call.method === 'provider.save').length, 0, 'account refresh must not rewrite the imported core configuration');
  assert.deepEqual(core.snapshot.providers, imported.providers);
  providers.refreshCompatibilityCredentials();
  assert.equal(providers.credentials, undefined); assert.equal(providers.api, undefined);
  assert.equal(core.calls.filter(call => call.method === 'provider.delete').length, 0, 'clearing compatibility clients must not remove a provider');
});

async function networkFixture(t: Parameters<typeof fixture>[0]) {
  const open = new Map<string, string>(); const closed: string[] = [];
  let sequence = 0; let unpublishes = 0; let failClose = false;
  const tsnet = {
    async publish(port: number) { return { port }; },
    async unpublish() { unpublishes++; },
    async tunnel(address: string) {
      assert.ok(open.size < 32, 'retired providers must not consume the helper tunnel limit');
      const id = `tunnel-${++sequence}`; open.set(id, address); return { id, address: `127.0.0.1:${12000 + sequence}` };
    },
    async closeTunnel(id: string) { if (failClose) throw new Error('tunnel cleanup interrupted'); closed.push(id); open.delete(id); },
  };
  const f = await fixture(t, { sessionName: id => id }, tsnet as unknown as TsnetClient);
  f.state.settings.tailscale_enabled = true; f.core.snapshot.remote.enabled = true;
  const save = (address: string, id = 'upstream', enabled = true) => f.providers.action({ action: 'save', provider: { id, name: id, type: 'remote', address, enabled } });
  const beginDial = (request_id: string, address: string) => {
    (f.providers as unknown as { event(e: CoreEvent): void }).event({ event: 'dial', data: { request_id, address } });
  };
  const result = async (request_id: string) => {
    for (let i = 0; i < 100; i++) {
      const completed = f.core.calls.find(call => call.method === 'dial.complete' && call.params.request_id === request_id);
      if (completed) return completed.params;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('Tunnel dial did not settle');
  };
  const dial = async (request_id: string, address: string) => { beginDial(request_id, address); return result(request_id); };
  return { ...f, tsnet, open, closed, save, dial, beginDial, result,
    unpublishes: () => unpublishes, failClose: (value: boolean) => { failClose = value; } };
}

test('disabling downstream access preserves outgoing provider tunnels and subscriptions', async t => {
  const f = await networkFixture(t); const address = '100.64.0.9:9418';
  await f.save(address); await f.providers.syncNetwork();
  const first = await f.dial('before-disable', address);
  await f.providers.configureRemote({ enabled: false });
  assert.equal(f.unpublishes(), 1);
  assert.equal(f.open.size, 1, 'only the incoming publication should be closed');
  assert.equal(f.closed.length, 0);
  const second = await f.dial('after-disable', address);
  assert.equal(second.address, first.address, 'the live outgoing tunnel must be reused');
});

test('remote provider replacement, shared addresses, deletion and import reclaim unused tunnels', async t => {
  const f = await networkFixture(t);
  for (let i = 0; i < 40; i++) {
    const address = `100.64.0.${i + 1}:9418`;
    await f.save(address);
    assert.ok((await f.dial(`replacement-${i}`, address)).address);
    assert.equal(f.open.size, 1, `replacement ${i} retained old helper listeners`);
  }
  const address = '100.64.0.40:9418';
  await f.save(address, 'shared');
  await f.providers.action({ action: 'delete', id: 'upstream' });
  assert.equal(f.open.size, 1, 'a shared provider address is still in use');
  await f.save(address, 'shared', false);
  assert.equal(f.open.size, 0, 'disabled providers no longer own a tunnel');
  await f.save(address, 'shared'); await f.dial('before-import', address);
  await f.providers.importConfig({ version: 1, providers: [] });
  assert.equal(f.open.size, 0, 'configuration import must retire removed addresses too');
});

test('pending dials share one allocation and cannot reinstall a removed provider tunnel', async t => {
  const f = await networkFixture(t); const address = '100.64.0.9:9418';
  await f.save(address); await f.providers.syncNetwork();
  let release!: (value: { id: string; address: string }) => void; let requests = 0;
  t.mock.method(f.tsnet, 'tunnel', async () => { requests++; return new Promise(resolve => { release = resolve; }); });
  f.beginDial('pending-one', address); f.beginDial('pending-two', address);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1, 'concurrent provider dials must not leak extra allocations');
  await f.providers.action({ action: 'delete', id: 'upstream' });
  f.open.set('late-allocation', address); release({ id: 'late-allocation', address: '127.0.0.1:12345' });
  for (const id of ['pending-one', 'pending-two']) assert.ok((await f.result(id)).error, 'removed provider must not receive a stale endpoint');
  assert.equal(f.open.size, 0);
  assert.deepEqual(f.closed, ['late-allocation']);
});

test('failed retired-tunnel cleanup keeps the handle for a subsequent retry', async t => {
  const f = await networkFixture(t);
  await f.save('100.64.0.9:9418'); await f.providers.syncNetwork(); await f.dial('original', '100.64.0.9:9418');
  f.failClose(true);
  await assert.rejects(f.save('100.64.0.10:9418'), /tunnel cleanup interrupted/);
  assert.equal(f.open.size, 1);
  f.failClose(false); await f.providers.syncNetwork();
  assert.equal(f.open.size, 0);
  assert.ok((await f.dial('replacement', '100.64.0.10:9418')).address);
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
