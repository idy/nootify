import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { State } from '../src/state.js';
import { CoreError, ProviderCore, type CoreEvent, type CoreTransport } from '../src/provider-core.js';
import { ProvidersService, decodeMessageRef, encodeMessageRef, type ProviderPage } from '../src/providers.js';
import { SessionsService } from '../src/sessions.js';
import { registerPolledSession, sessionInbox } from '../src/polled-sessions.js';
import { RetryableDeliveryError } from '../src/types.js';
import { createServiceHost } from '../src/server.js';
import { EventLog } from '../src/events.js';
import { TailnetAccess } from '../src/tailnet.js';
import { TailscaleService } from '../src/tailscale.js';
import { NootifyClient } from '../src/client.js';
import { SettingsService } from '../src/settings.js';
import { GitHubAuth } from '../src/github-auth.js';
import { LarkDirectoryCache } from '../src/lark-directory-cache.js';
import type { TsnetClient } from '../src/tsnet-client.js';

const page: ProviderPage = { node_id: 'local-node', providers: [], remote: { enabled: false, listen: '127.0.0.1:9418', status: 'disabled', tls: false, token_set: false, peers: [] } };
interface FakeBinding { provider_id: string; session: { node_id: string; adapter: string; session_id: string; name?: string }; created: boolean; deleted?: boolean }
class FakeCore implements CoreTransport {
  snapshot: ProviderPage = structuredClone(page);
  bindings: FakeBinding[] = [];
  configs = new Map<string, Record<string, unknown>>();
  calls: { method: string; params: Record<string, unknown> }[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'provider.save') {
      const old = this.configs.get(String(params.id));
      if (old?.type === 'feishu' && old.app_id !== params.app_id) throw new CoreError('conflict', 'Feishu app_id cannot be changed; create a new provider instead');
      const config = { ...params, app_secret: params.app_secret || old?.app_secret, token: params.token || old?.token };
      this.configs.set(String(params.id), config);
      const provider = { id: String(params.id), name: String(params.name), type: params.type as 'remote' | 'feishu', enabled: params.enabled !== false,
        status: 'connected', ...(typeof params.address === 'string' ? { address: params.address } : {}),
        ...(typeof params.app_id === 'string' ? { app_id: params.app_id, secret_set: Boolean(config.app_secret) } : {}),
        ...(typeof params.recipient_open_id === 'string' ? { recipient_open_id: params.recipient_open_id } : {}) };
      this.snapshot.providers = [...this.snapshot.providers.filter(item => item.id !== provider.id), provider];
    } else if (method === 'provider.delete') {
      this.configs.delete(String(params.id)); this.snapshot.providers = this.snapshot.providers.filter(item => item.id !== params.id);
    } else if (method === 'remote.configure') this.snapshot.remote = { ...this.snapshot.remote, ...params };
    else if (method === 'config.import') {
      this.snapshot.providers = params.providers as ProviderPage['providers'];
      this.configs = new Map((params.providers as Record<string, unknown>[]).map(provider => [String(provider.id), provider]));
    } else if (method === 'config.export') return { version: 1, providers: [...this.configs.values()] } as T;
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

test('peer migration routes map public identity and binding requests to private core methods', async t => {
  const { providers, core } = await fixture(t);
  const request = core.request.bind(core);
  const identity = { node_id: page.node_id, public_key: 'synthetic-node-public-key' };
  const bound = { node_id: 'peer-node', public_key: 'synthetic-peer-public-key', pending: 0 };
  t.mock.method(core, 'request', async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const result = await request<T>(method, params);
    return (method === 'remote.identity' ? identity : method === 'remote.peer.bind' ? bound : result) as T;
  });
  assert.deepEqual(await providers.handle({ method: 'GET', path: '/v1/remote/identity', body: undefined }), { body: identity });
  assert.deepEqual(core.calls.at(-1), { method: 'remote.identity', params: {} });
  assert.deepEqual(await providers.handle({ method: 'PUT', path: '/v1/remote/peers/peer-node', body: { public_key: bound.public_key } }), { body: bound });
  assert.deepEqual(core.calls.at(-1), { method: 'remote.peer.bind', params: { node_id: 'peer-node', public_key: bound.public_key } });
  const calls = core.calls.length;
  await assert.rejects(providers.handle({ method: 'PUT', path: '/v1/remote/peers/invalid%20node', body: { public_key: bound.public_key } }), /Invalid node_id/);
  await assert.rejects(providers.handle({ method: 'PUT', path: '/v1/remote/peers/peer-node', body: { public_key: '' } }), /Invalid public_key/);
  assert.equal(await providers.handle({ method: 'POST', path: '/v1/remote/identity', body: {} }), undefined);
  assert.equal(await providers.handle({ method: 'GET', path: '/v1/remote/peers/peer-node', body: undefined }), undefined);
  assert.equal(core.calls.length, calls, 'invalid parameters and unsupported methods must not reach the core');
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

test('unsupported thread channels fail before core requests or cooperative session registration', async t => {
  const { providers, core, state } = await fixture(t);
  const calls = core.calls.length;
  for (const channel of ['slack', '', null, 42, {}]) {
    for (const path of ['/v1/threads', '/v1/threads/session-channel/messages']) {
      await assert.rejects(providers.handle({ method: 'POST', path, body: {
        channel, adapter: 'trae', session_id: 'session-channel', session_name: 'Rejected channel', text: 'must not send',
      } }), /Only Feishu notifications are supported/);
    }
  }
  assert.equal(core.calls.length, calls, 'channel validation must precede status, ensure and send requests');
  assert.equal(state.sessions.size, 0);
  assert.equal((await State.open(state.directory)).sessions.size, 0);
  await providers.handle({ method: 'POST', path: '/v1/threads', body: {
    channel: 'feishu', adapter: 'trae', session_id: 'session-channel', session_name: 'Accepted channel',
  } });
  assert.equal(state.sessions.get('session-channel')?.adapter, 'trae');
});

test('manual binding rejects unsupported pin and legacy metadata modes before side effects', async t => {
  const { providers, core, state } = await fixture(t);
  const body = { adapter: 'trae', session_id: 'manual-session', session_name: 'Manual session', sender_open_id: 'ou_owner' };
  const calls = core.calls.length;
  for (const options of [{ pin: true }, { pin: 'yes' }, { metadata: 'message' }, { metadata: 'announcement' }, { metadata: 1 }, { metadata: [] }]) {
    await assert.rejects(providers.handle({ method: 'PUT', path: '/v1/lark/bindings/oc_existing', body: { ...body, ...options } }), /pin|metadata/i);
  }
  assert.equal(core.calls.length, calls);
  assert.equal(state.sessions.size, 0);
  const metadata = { project: 'Synthetic project', nested: { retained: true } };
  await providers.handle({ method: 'PUT', path: '/v1/lark/bindings/oc_existing', body: { ...body, pin: false, metadata } });
  const bind = core.calls.find(call => call.method === 'session.bind')!;
  assert.deepEqual(bind.params.session, { node_id: page.node_id, adapter: 'trae', session_id: body.session_id, name: body.session_name, metadata });
  assert.equal(bind.params.chat_id, 'oc_existing'); assert.equal(bind.params.sender_open_id, body.sender_open_id);
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

test('legacy provider CRUD synchronizes retained secrets, compatibility exports and directory caches without rewriting providers', async t => {
  const { providers, core, state, directory } = await fixture(t);
  const settings = new SettingsService({ state, lark: providers, providers, env: {},
    github: new GitHubAuth(state, () => {}, () => {}, 'synthetic-client'),
    pulls: { async preferences() { return { follow: [] }; }, async restore() {} },
    agents: { async list() { return []; }, async set() { throw new Error('No agent edits in this fixture'); } } });
  t.after(() => settings.stop());
  const app_id = 'cli_0123456789abcdef';
  const initial = { id: 'legacy-feishu', name: 'Custom migrated provider', type: 'feishu', enabled: false,
    app_id, app_secret: 'synthetic-original-secret', recipient_open_id: 'ou_original' };
  const save = (provider: Record<string, unknown>) => providers.action({ action: 'save', provider });
  await save(initial);
  assert.deepEqual(providers.credentials, { appId: app_id, appSecret: initial.app_secret });
  assert.equal((await settings.page()).lark.source, 'settings');
  const originalApi = providers.api!;
  t.mock.method(originalApi, 'request', async <T>(_method: string, path: string): Promise<T> =>
    (path.includes('/scopes') ? { user_ids: ['ou_cached'] } : { items: [{ open_id: 'ou_cached', name: 'Cached synthetic user' }] }) as T);
  await settings.larkRecipients();
  assert.ok(await new LarkDirectoryCache(directory).read(providers.credentials!));
  const oldCredentials = providers.credentials!;
  const rotated = { ...initial, app_secret: 'synthetic-rotated-secret', recipient_open_id: 'ou_rotated' };
  await save(rotated);
  assert.deepEqual(providers.credentials, { appId: app_id, appSecret: rotated.app_secret });
  assert.notStrictEqual(providers.api, originalApi, 'secret rotation replaces the SDK token client');
  assert.equal(await new LarkDirectoryCache(directory).read(oldCredentials), undefined);
  assert.equal((await State.open(directory)).settings.lark_app_secret, rotated.app_secret);
  assert.deepEqual(settings.larkSecret(), { app_id, app_secret: rotated.app_secret });
  let reads = 0;
  t.mock.method(providers.api!, 'request', async <T>(_method: string, path: string): Promise<T> => {
    reads++; return (path.includes('/scopes') ? { user_ids: ['ou_rotated'] } : { items: [{ open_id: 'ou_rotated', name: 'Rotated synthetic user' }] }) as T;
  });
  assert.deepEqual((await settings.larkRecipients()).users.map(user => user.open_id), ['ou_rotated']);
  assert.ok(reads > 0, 'SettingsService must not reuse its old in-memory directory');
  const { app_secret: _masked, ...retained } = { ...rotated, name: 'Retained custom name' };
  const api = providers.api;
  await save(retained);
  assert.equal(providers.credentials?.appSecret, rotated.app_secret, 'a masked provider save uses the core retained secret');
  assert.strictEqual(providers.api, api, 'unchanged credentials preserve in-flight directory requests');
  const exported = JSON.parse(await readFile((await settings.exportConfig()).path, 'utf8'));
  assert.deepEqual(exported.lark, { app_id, app_secret: rotated.app_secret, recipient_open_id: 'ou_rotated', connection_type: 'bot' });
  assert.equal(exported.providers.providers[0].name, retained.name);
  assert.equal(exported.providers.providers[0].enabled, false);
  assert.equal(core.calls.filter(call => call.method === 'provider.save').length, 3, 'compatibility synchronization must not issue extra provider saves');
  assert.ok(!JSON.stringify(await providers.page()).includes(rotated.app_secret));
  state.bindings.set('oc_previous', { chat_id: 'oc_previous', session_id: 'previous-app-session', sender_open_id: 'ou_rotated' });
  const switched = { ...rotated, app_id: 'cli_fedcba9876543210', app_secret: 'synthetic-other-app-secret', recipient_open_id: 'ou_otherapp' };
  await assert.rejects(save(switched), /app_id cannot be changed/);
  assert.equal(providers.credentials?.appSecret, rotated.app_secret);
  await providers.action({ action: 'delete', id: initial.id });
  await save(switched);
  assert.equal(providers.api?.appId, switched.app_id);
  assert.deepEqual(providers.credentials, { appId: switched.app_id, appSecret: switched.app_secret });
  const switchedState = await State.open(directory);
  assert.equal(switchedState.settings.lark_app_id, switched.app_id);
  assert.equal(switchedState.settings.lark_recipient_open_id, switched.recipient_open_id);
  assert.equal(switchedState.bindings.get('oc_previous')?.app_id, app_id, 'legacy ownership remains scoped to the previous application');
  const switchedExport = JSON.parse(await readFile((await settings.exportConfig()).path, 'utf8'));
  assert.equal(switchedExport.lark.app_id, switched.app_id); assert.equal(switchedExport.lark.app_secret, switched.app_secret);
  await providers.action({ action: 'delete', id: initial.id });
  assert.equal(providers.credentials, undefined); assert.equal(providers.api, undefined);
  assert.deepEqual(settings.larkSecret(), {});
  const removed = await State.open(directory);
  assert.equal(removed.settings.lark_app_id, undefined); assert.equal(removed.settings.lark_app_secret, undefined);
  assert.equal(removed.settings.lark_recipient_open_id, undefined);
  const deletedExport = JSON.parse(await readFile((await settings.exportConfig()).path, 'utf8'));
  assert.deepEqual(deletedExport.lark, {}); assert.deepEqual(deletedExport.providers.providers, []);
});

for (const operation of ['save', 'registration', 'clear', 'import'] as const) {
  test(`an immutable core app ID rejection rolls back ${operation} credentials, recipient and legacy binding ownership`, async t => {
    const { providers, core, state, directory } = await fixture(t);
    const candidate = { appId: 'cli_fedcba9876543210', appSecret: 'synthetic-rejected-secret' };
    const mcpConfig = join(directory, 'synthetic-mcp.json');
    await writeFile(mcpConfig, JSON.stringify({ mcpServers: { lark: { env: { LARK_APP_ID: candidate.appId, LARK_APP_SECRET: candidate.appSecret } } } }));
    const settings = new SettingsService({ state, lark: providers, providers, env: {}, mcpConfig, verify: async () => {},
      registration: { fetch: async (_url, init) => Response.json(new URLSearchParams(String(init?.body)).get('action') === 'begin'
        ? { device_code: 'synthetic-device', user_code: 'ABCD-1234', expire_in: 60 }
        : { client_id: candidate.appId, client_secret: candidate.appSecret, user_info: { open_id: 'ou_rejected' } }) },
      github: new GitHubAuth(state, () => {}, () => {}, 'synthetic-client'),
      pulls: { async preferences() { return { follow: [] }; }, async restore() {} },
      agents: { async list() { return []; }, async set() { throw new Error('No agent edits in this fixture'); } } });
    t.mock.method(settings, 'larkSetup', async () => ({ app_id: candidate.appId, status: 'ready' as const, missing: [], mention_only: false }));
    t.after(() => settings.stop());
    const initial = { id: 'legacy-feishu', name: 'Migrated provider', type: 'feishu', enabled: false,
      app_id: 'cli_0123456789abcdef', app_secret: 'synthetic-retained-secret', recipient_open_id: 'ou_original' };
    await providers.action({ action: 'save', provider: initial });
    state.settings.lark_connection_type = 'personal-app';
    const binding = { chat_id: 'oc_original', session_id: 'original-session', sender_open_id: 'ou_original' };
    state.bindings.set(binding.chat_id, binding); await state.save();
    const before = { ...state.settings }; const credentials = providers.credentials!; const api = providers.api;
    await new LarkDirectoryCache(directory).write(credentials, { app_id: credentials.appId,
      users: [{ open_id: 'ou_original', name: 'Synthetic original user' }], truncated: false, permission_limited: false });
    if (operation === 'registration') {
      settings.startLarkRegistration();
      for (let attempt = 0; attempt < 500 && !['failed', 'complete'].includes(settings.larkRegistration().status); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual(settings.larkRegistration(), { status: 'failed', error: 'save_failed' });
    } else {
      const change = operation === 'save' ? settings.saveLark(candidate.appId, candidate.appSecret, 'bot')
        : operation === 'clear' ? settings.clearLark()
        : settings.importConfig({ format: 'nootify-config', version: 1,
          lark: { app_id: candidate.appId, app_secret: candidate.appSecret, recipient_open_id: 'ou_rejected', connection_type: 'bot' } });
      await assert.rejects(change, /app_id cannot be changed/);
    }
    assert.deepEqual(state.settings, before);
    assert.deepEqual((await State.open(directory)).settings, before);
    assert.equal(state.bindings.get(binding.chat_id)?.app_id, undefined);
    assert.equal((await State.open(directory)).bindings.get(binding.chat_id)?.app_id, undefined);
    assert.strictEqual(providers.credentials, credentials); assert.strictEqual(providers.api, api);
    assert.equal(core.configs.get(initial.id)?.app_id, initial.app_id);
    assert.equal(core.configs.get(initial.id)?.app_secret, initial.app_secret);
    assert.ok(await new LarkDirectoryCache(directory).read(credentials), 'a rejected credential edit preserves its directory cache');
    const exported = JSON.parse(await readFile((await settings.exportConfig()).path, 'utf8'));
    assert.equal(exported.lark.app_id, initial.app_id); assert.equal(exported.lark.app_secret, initial.app_secret);
    assert.equal(exported.lark.recipient_open_id, initial.recipient_open_id);
    await state.save(); assert.deepEqual((await State.open(directory)).settings, before);
    await settings.saveLark(initial.app_id, 'synthetic-retried-secret');
    assert.equal((await State.open(directory)).settings.lark_app_secret, 'synthetic-retried-secret');
    assert.equal(core.configs.get(initial.id)?.app_secret, 'synthetic-retried-secret');
    assert.equal(await new LarkDirectoryCache(directory).read(credentials), undefined);
  });
}

test('legacy provider CRUD serializes with Settings credential edits before mutating the core', async t => {
  const { providers, core, state, directory } = await fixture(t);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let verifying!: () => void; const entered = new Promise<void>(resolve => { verifying = resolve; });
  t.after(() => release());
  const settings = new SettingsService({ state, lark: providers, providers, env: {},
    verify: async () => { verifying(); await gate; },
    github: new GitHubAuth(state, () => {}, () => {}, 'synthetic-client'),
    pulls: { async preferences() { return { follow: [] }; }, async restore() {} },
    agents: { async list() { return []; }, async set() { throw new Error('No agent edits in this fixture'); } } });
  t.after(() => settings.stop());
  const app_id = 'cli_0123456789abcdef';
  const savingSettings = settings.saveLark(app_id, 'synthetic-settings-secret');
  await entered;
  const savingProvider = providers.action({ action: 'save', provider: { id: 'legacy-feishu', name: 'Concurrent provider', type: 'feishu', enabled: false,
    app_id, app_secret: 'synthetic-crud-secret', recipient_open_id: 'ou_latest' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!core.calls.some(call => call.method === 'provider.save'), 'CRUD must wait before changing the core, not only before updating its legacy mirror');
  release(); await Promise.all([savingSettings, savingProvider]);
  assert.equal(providers.credentials?.appSecret, 'synthetic-crud-secret');
  assert.equal(core.configs.get('legacy-feishu')?.app_secret, 'synthetic-crud-secret');
  assert.equal((await State.open(directory)).settings.lark_app_secret, 'synthetic-crud-secret');
});

test('rejected legacy provider mutations preserve compatibility credentials and persisted settings', async t => {
  const { providers, core, state, directory } = await fixture(t);
  const settings = new SettingsService({ state, lark: providers, providers, env: {},
    github: new GitHubAuth(state, () => {}, () => {}, 'synthetic-client'),
    pulls: { async preferences() { return { follow: [] }; }, async restore() {} },
    agents: { async list() { return []; }, async set() { throw new Error('No agent edits in this fixture'); } } });
  t.after(() => settings.stop());
  const credentials = { appId: 'cli_0123456789abcdef', appSecret: 'synthetic-retained-secret' };
  providers.refreshCompatibilityCredentials(credentials);
  Object.assign(state.settings, { lark_app_id: credentials.appId, lark_app_secret: credentials.appSecret, lark_recipient_open_id: 'ou_original' });
  await state.save();
  const api = providers.api;
  const request = core.request.bind(core);
  t.mock.method(core, 'request', async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === 'provider.save' || method === 'provider.delete') throw new CoreError('unavailable', 'synthetic provider rejection');
    return request<T>(method, params);
  });
  for (const action of [{ action: 'save', provider: { id: 'legacy-feishu', type: 'feishu', app_id: credentials.appId, app_secret: 'must-not-save' } },
    { action: 'delete', id: 'legacy-feishu' }]) await assert.rejects(providers.action(action), /synthetic provider rejection/);
  assert.strictEqual(providers.credentials, credentials); assert.strictEqual(providers.api, api);
  assert.deepEqual((await State.open(directory)).settings, state.settings);
  assert.equal(state.settings.lark_app_secret, credentials.appSecret);
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

for (const adapter of ['trae', 'workbuddy'] as const) {
  test(`${adapter}: queued provider callbacks use the current runtime after state relocation`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'nootify-provider-relocation-'));
    const oldDirectory = join(root, 'Old State'), directory = join(root, 'New State');
    const providersToStop: ProvidersService[] = []; const sessionsToStop: SessionsService[] = [];
    let server: ReturnType<typeof createServiceHost> | undefined;
    t.after(async () => {
      if (server?.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
      for (const provider of providersToStop) await provider.stop();
      for (const sessions of sessionsToStop) await sessions.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const state = await State.open(oldDirectory); const core = new FakeCore();
    const originalSessions = new SessionsService(state); sessionsToStop.push(originalSessions);
    const original = new ProvidersService(state, originalSessions, undefined, undefined, 9876, undefined, core);
    providersToStop.push(original); await original.start();
    const id = `${adapter}-retained`; await registerPolledSession(state, adapter, id, 'Retained provider conversation');
    const message = { origin_node_id: 'source-node', provider_id: 'source-bot', message_id: `om_${adapter}`, thread_id: 'omt_original', opaque: { route: 'preserved' } };
    const originalText = `Retained ${adapter} input\n第二行原文`;
    (original as unknown as { event(e: CoreEvent): void }).event({ event: 'delivery', data: {
      delivery_id: 'queued-input', session: { node_id: 'local-node', adapter, session_id: id }, message, content: { text: originalText }, text: originalText,
    } });
    for (let i = 0; i < 500 && !core.calls.some(call => call.method === 'delivery.complete'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const complete = core.calls.find(call => call.method === 'delivery.complete');
    assert.equal(complete?.params.status, 'delivered');
    assert.equal(complete.params.transport_status, 'inbox_queued');
    const queued = [...state.inboxMessages.values()][0];
    assert.equal(queued.text, originalText, 'durable provider inboxes store original input, not rendered commands');
    assert.deepEqual(queued.source, { channel: 'provider', delivery: { adapter, session_id: id, message } });
    await original.stop(); await originalSessions.stop(); await rename(oldDirectory, directory);
    const restored = await State.open(directory); const resumedCore = new FakeCore();
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const runtime = { port: 0, command: [process.execPath, cli] };
    const sessions = new SessionsService(restored, undefined, undefined, undefined, runtime); sessionsToStop.push(sessions);
    const modules = [sessions] as Parameters<typeof createServiceHost>[0];
    server = createServiceHost(modules, restored.token); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    runtime.port = (server.address() as { port: number }).port;
    const resumed = new ProvidersService(restored, sessions, undefined, undefined, runtime.port, undefined, resumedCore);
    providersToStop.push(resumed); await resumed.start(); modules.push(resumed);
    const execute = promisify(execFile);
    const run = async (command: string, ...args: string[]) => JSON.parse((await execute(process.execPath,
      [cli, command, '--state-dir', directory, '--port', String(runtime.port), ...args], { timeout: 15000, windowsHide: true })).stdout);
    const inbox = await run('thread-receive', '--agent', adapter, '--session-id', id);
    assert.equal(inbox.messages.length, 1);
    const forwarded = inbox.messages[0].text as string;
    assert.ok(forwarded.includes(originalText)); assert.ok(forwarded.includes(directory)); assert.ok(!forwarded.includes(oldDirectory));
    assert.ok(forwarded.includes(`--port ${runtime.port} `)); assert.ok(!forwarded.includes('--port 9876 '));
    const ref = encodeMessageRef(message); assert.ok(forwarded.includes(`--message-ref '${ref}'`) || forwarded.includes(`--message-ref ${ref}`));
    const movedInstall = sessionInbox(restored, adapter, id, { port: runtime.port, command: ['/Relocated Install/node', '/Relocated Install/cli.js'] });
    assert.ok(movedInstall.messages[0].text.includes('/Relocated Install/cli.js'));
    await run('message-ack', '--message-ref', ref);
    await run('message-reply', '--message-ref', ref, '--text', 'Reply after relocation');
    const callbacks = resumedCore.calls.filter(call => call.method === 'message.ack' || call.method === 'message.reply');
    assert.equal(callbacks.length, 2); assert.ok(callbacks.every(call => JSON.stringify(call.params.message) === JSON.stringify(message)));
    assert.equal((callbacks[1].params.content as { text: string }).text, 'Reply after relocation');
    const persisted = (await State.open(directory)).inboxMessages.get(queued.id)!;
    assert.equal(persisted.text, originalText); assert.deepEqual(persisted.source, queued.source);
    await run('thread-ack', '--agent', adapter, '--session-id', id, '--message-id', queued.id);
    assert.equal(restored.inboxMessages.size, 0);
  });
}

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
    const response = await fetch(base + path, { method: 'POST', headers: { 'x-nootify-ui': '1', authorization: `Bearer ${state.token}` }, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.ok(!core.calls.some(call => ['provider.save', 'remote.configure', 'remote.secret'].includes(call.method)));
});

test('provider UI mutations and remote token reveal require owner authentication, local origin and the UI header', async t => {
  const { providers, state, directory } = await fixture(t, { sessionName: id => id });
  const logs = await EventLog.open(directory);
  const server = createServiceHost([], state.token, logs, { providers });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = { authorization: `Bearer ${state.token}` };
  const read = await fetch(`${base}/ui/api/providers`, { headers: owner }); assert.equal(read.status, 200); assert.equal((await read.json() as { editable: boolean }).editable, true);
  assert.equal((await (await fetch(`${base}/ui/api/providers`)).json() as { editable: boolean }).editable, false);
  const denied = await fetch(`${base}/ui/api/providers`, { method: 'POST', headers: owner, body: JSON.stringify({ action: 'delete', id: 'bot-a' }) });
  assert.equal(denied.status, 403);
  const unauthenticated = await fetch(`${base}/ui/api/settings/remote/secret`, { method: 'POST', headers: { 'x-nootify-ui': '1' } });
  assert.equal(unauthenticated.status, 403);
  const secretGet = await fetch(`${base}/ui/api/settings/remote/secret`); assert.equal(secretGet.status, 405);
  const secret = await fetch(`${base}/ui/api/settings/remote/secret`, { method: 'POST', headers: { 'x-nootify-ui': '1', authorization: `Bearer ${state.token}` } });
  assert.deepEqual(await secret.json(), { token: 'private-peer-token' });
  assert.equal(JSON.stringify(await (await fetch(`${base}/ui/api/settings/remote`)).json()).includes('private-peer-token'), false);
});
