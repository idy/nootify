import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { EventLog } from '../src/events.js';
import { createServiceHost } from '../src/server.js';
import { State } from '../src/state.js';
import { listenTailnetProxy, type TailnetListener } from '../src/tailnet-proxy.js';
import { TailnetAccess } from '../src/tailnet.js';
import { TailscaleService, tailscaleLoginUrl, type TailscalePage } from '../src/tailscale.js';
import type { EmbeddedTailscaleClient } from '../src/tsnet-client.js';
import type { SettingsSource } from '../src/ui.js';
import { failSettingsWriteBehindOlderSaves } from './state-failures.js';

const address = '100.64.0.7'; const owner = 'owner@example.com'; const ownerPeer = '100.64.0.9';
const loginUrl = 'https://login.tailscale.com/a/Abc123';
const running = { BackendState: 'Running', NootifyListening: true, User: { 42: { LoginName: owner } },
  Self: { HostName: 'nootify', DNSName: 'nootify.example.ts.net.', TailscaleIPs: ['fd7a:115c:a1e0::7', address], UserID: 42 } };
class FakeNode implements EmbeddedTailscaleClient {
  reply: unknown = { BackendState: 'NeedsLogin', AuthURL: loginUrl, NootifyListening: true };
  starts: { target: string; exited: () => void }[] = [];
  online = false; statuses = 0; logins = 0; logouts = 0; stops = 0;
  failure?: Error;
  async start(target: string, exited: () => void) { this.starts.push({ target, exited }); if (this.failure) throw this.failure; this.online = true; }
  async status() { this.statuses++; if (!this.online) throw new Error('embedded_client_stopped'); if (this.reply instanceof Error) throw this.reply; return this.reply; }
  async whois() { return { UserProfile: { LoginName: owner } }; }
  async login() { this.logins++; this.reply = { BackendState: 'NeedsLogin', AuthURL: loginUrl }; }
  async logout() { this.logouts++; this.reply = { BackendState: 'NeedsLogin' }; }
  async stop() { this.stops++; this.online = false; }
  crash() { this.online = false; this.starts.at(-1)!.exited(); }
}
async function harness(t: TestContext, directory?: string) {
  const dir = directory ?? await mkdtemp(join(tmpdir(), 'nootify-tsnet-'));
  const state = await State.open(dir); const client = new FakeNode();
  const access = new TailnetAccess(80, { probe: client }); const peers = new WeakMap<Socket, string>();
  const http = createServiceHost([], 'test-token', undefined, { tailnet: access, via: 'tailnet', peerAddress: socket => peers.get(socket) });
  const listeners: TailnetListener[] = []; const reports: Record<string, unknown>[] = [];
  const service = new TailscaleService({ state, access, client, report: record => reports.push(record), listen: async () => {
    const listener = await listenTailnetProxy(http, peers); listeners.push(listener); return listener;
  } });
  t.after(async () => { await service.stop(); http.closeAllConnections(); if (!directory) await rm(dir, { recursive: true, force: true }); });
  return { dir, state, client, service, access, listeners, reports };
}
function connection(target: string): Socket {
  const url = new URL(target); assert.equal(url.hostname, '127.0.0.1');
  return createConnection({ host: url.hostname, port: Number(url.port) });
}
async function connected(target: string) { const socket = connection(target); await once(socket, 'connect'); return socket; }
async function assertClosed(target: string) { await assert.rejects(connected(target), { code: 'ECONNREFUSED' }); }

test('disabled installations start no client, inspect no host account, and preserve their setting across restart', async t => {
  const first = await harness(t); await first.service.start();
  assert.equal((await first.service.page()).status, 'disabled'); assert.equal(first.client.starts.length, 0); assert.equal(first.client.statuses, 0);
  await first.service.setEnabled(true);
  assert.equal((await State.open(first.dir)).settings.tailscale_enabled, true);
  assert.equal(first.client.starts.length, 1);
  assert.deepEqual((await first.service.page()).login, { status: 'waiting', url: loginUrl });
  assert.equal(first.access.url(), undefined, 'an authorization link is not a connected node');
  first.client.reply = running; await first.service.refresh();
  const page = await first.service.page();
  assert.deepEqual([page.sharing, page.url, page.account, page.deviceName, page.dnsName], ['ready', `http://${address}/`, owner, 'nootify', 'nootify.example.ts.net']);
  await first.service.stop(); await assertClosed(first.client.starts[0].target);
  assert.equal((await State.open(first.dir)).settings.tailscale_enabled, true);
  const second = await harness(t, first.dir); second.client.reply = running; await second.service.start();
  assert.equal(second.client.starts.length, 1); assert.equal(second.access.url(), `http://${address}/`);
  await second.service.setEnabled(false); assert.equal((await State.open(first.dir)).settings.tailscale_enabled, false);
});

test('disabling closes active connections but preserves enrollment for reconnect', async t => {
  const { service, client, access } = await harness(t); client.reply = running;
  await service.start(); await service.setEnabled(true);
  const target = client.starts[0].target; const socket = await connected(target); const closed = once(socket, 'close');
  await service.setEnabled(false); await closed; await assertClosed(target);
  assert.equal(access.url(), undefined); assert.equal(client.online, false); assert.equal(client.logouts, 0);
  client.starts[0].exited(); assert.equal((await service.page()).status, 'disabled');
  await service.setEnabled(true); assert.equal(access.url(), `http://${address}/`); assert.equal(client.logins, 0);
});

test('readiness needs the independent node listener, not just a signed-in status', async t => {
  const { service, client, access } = await harness(t);
  client.reply = { ...running, NootifyListening: false }; await service.setEnabled(true);
  assert.equal(access.url(), undefined); assert.equal((await service.page()).sharing, 'starting');
  client.reply = running; await service.refresh(); assert.equal(access.url(), `http://${address}/`);
});

test('invalid or unsaved choices cannot start an embedded client', async t => {
  const { service, state, client } = await harness(t);
  for (const value of [undefined, null, 'true', 1]) await assert.rejects(service.setEnabled(value), { status: 400 });
  const mock = t.mock.method(state, 'save', async () => { throw new Error('disk full'); });
  await assert.rejects(service.setEnabled(true), /disk full/); assert.equal(client.starts.length, 0); assert.equal((await service.page()).enabled, false);
  mock.mock.restore(); await service.setEnabled(true); assert.equal(client.starts.length, 1);
});

for (const enabled of [true, false]) {
  test(`failed Tailscale setting ${enabled} cannot leak into an older queued save`, async t => {
    const f = await harness(t);
    await f.service.setEnabled(!enabled);
    const starts = f.client.starts.length;
    await failSettingsWriteBehindOlderSaves(t, f.state, () => f.service.setEnabled(enabled));
    assert.equal(f.state.settings.tailscale_enabled, !enabled);
    assert.equal((await State.open(f.dir)).settings.tailscale_enabled, !enabled);
    assert.equal((await f.service.page()).enabled, !enabled);
    assert.equal(f.client.starts.length, starts, 'a rejected setting must not start or reconfigure the client');
  });
}

test('login explicitly enables only the independent node and cancel takes it offline', async t => {
  const { service, client, state } = await harness(t); await service.start();
  const login = await service.startLogin(); assert.deepEqual(login, { status: 'waiting', url: loginUrl });
  assert.equal(state.settings.tailscale_enabled, true); assert.equal(client.starts.length, 1);
  await service.startLogin(); assert.equal(client.starts.length, 1); assert.equal(client.logins, 1, 'an explicit retry asks Tailscale to reuse or renew its auth URL');
  await service.cancelLogin(); assert.equal(client.online, false); assert.equal((await service.page()).login.url, undefined);
  assert.equal(state.settings.tailscale_enabled, false);
});

test('signing out targets only this client, disables it, and does not silently re-enroll', async t => {
  const { service, client, state } = await harness(t); client.reply = running; await service.setEnabled(true);
  await service.logout(); assert.equal(client.logouts, 1); assert.equal(client.online, false);
  assert.equal(state.settings.tailscale_enabled, false); assert.equal((await service.page()).status, 'disabled');
  await service.refresh(); assert.equal(client.starts.length, 1);
  await service.setEnabled(true); assert.equal((await service.page()).status, 'needs-login');
});

test('node failures clear remote access, hide private output and recover after backoff', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const { service, client, access, reports } = await harness(t); client.reply = running; await service.setEnabled(true);
  client.reply = new Error(`private ${loginUrl}`); await service.refresh();
  assert.equal(access.url(), undefined); assert.equal((await service.page()).error, 'embedded_request_failed');
  assert.ok(!JSON.stringify(reports).includes(loginUrl));
  client.reply = running; await service.refresh(); assert.equal(client.starts.length, 1);
  now += 30001; await service.refresh(); assert.equal(client.starts.length, 2); assert.equal(access.url(), `http://${address}/`);
  client.starts[0].exited(); assert.equal(access.url(), `http://${address}/`, 'old callbacks cannot retire the current node');
  client.crash(); assert.equal(access.url(), undefined); assert.equal((await service.page()).error, 'embedded_client_stopped');
});

test('temporary status saturation preserves healthy node connections and has bounded recovery', async t => {
  const {service,client,access}=await harness(t); client.reply=running; await service.setEnabled(true);
  const target=client.starts[0].target; const socket=await connected(target);t.after(()=>socket.destroy());
  socket.on('error',error=>assert.equal((error as NodeJS.ErrnoException).code,'ECONNRESET','only an intentional disconnect may reset this connection'));
  for(const code of ['busy','timeout']) {
    client.reply=new Error(code);await service.refresh();
    assert.equal(client.online,true);assert.equal(socket.destroyed,false);assert.equal(access.url(),`http://${address}/`);
  }
  client.reply=running;await service.refresh();assert.equal(client.starts.length,1);
  client.reply=new Error('status_failed'); await service.refresh();await service.refresh();
  const closed=new Promise<void>(resolve=>socket.once('close',()=>resolve()));await service.refresh();await closed;
  assert.equal(access.url(),undefined);assert.equal(client.online,false);
});

test('identical retry failures are logged only on outcome changes', async t => {
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const {service,client,reports}=await harness(t);client.failure=new Error('embedded_client_missing');
  await service.setEnabled(true);for(let i=0;i<4;i++){now+=30001;await service.refresh();}
  assert.equal(reports.filter(r=>r.status==='tailnet_failed').length,1);
  client.failure=undefined;client.reply=running;now+=30001;await service.refresh();
  assert.equal(reports.at(-1)?.status,'tailnet_listening');client.crash();
  assert.equal(reports.filter(r=>r.status==='tailnet_failed').length,2,'a failure after recovery remains observable');
});

test('backend login snapshots remove consumed links and explicit login can renew them', async t => {
  const {service,client}=await harness(t);await service.setEnabled(true);
  assert.equal((await service.page()).login.url,loginUrl);
  client.reply={BackendState:'NeedsMachineAuth',AuthURL:''};await service.refresh();
  assert.deepEqual((await service.page()).login,{status:'idle'});
  client.reply={BackendState:'NeedsLogin',AuthURL:''};await service.refresh();
  await service.startLogin();assert.equal(client.logins,1);assert.equal((await service.page()).login.url,loginUrl);
  await service.startLogin();assert.equal(client.logins,2,'cached links never prevent explicit backend renewal');
});

test('missing helpers fail locally without falling back to the system client', async t => {
  const { service, client } = await harness(t); client.failure = new Error('embedded_client_missing');
  await service.setEnabled(true); assert.equal((await service.page()).error, 'embedded_client_missing');
  assert.equal(client.starts.length, 1); assert.equal(client.online, false);
});

test('approval and reconnect states never advertise an unready address', async t => {
  const { service, client, access } = await harness(t);
  for (const [backend, status] of [['NeedsLogin', 'needs-login'], ['NeedsMachineAuth', 'needs-approval'], ['Starting', 'starting'], ['Stopped', 'starting']]) {
    client.reply = { BackendState: backend }; await service.setEnabled(true); await service.refresh();
    assert.equal((await service.page()).status, status); assert.equal(access.url(), undefined);
  }
  client.reply = running; await service.refresh(); assert.equal(access.url(), `http://${address}/`);
  client.reply = { BackendState: 'Starting' }; await service.refresh(); assert.equal(access.url(), undefined);
});

test('only official authorization links can reach the local UI', async t => {
  assert.equal(tailscaleLoginUrl(loginUrl), loginUrl);
  const { service, client } = await harness(t);
  for (const url of ['http://login.tailscale.com/a/Abc123', 'https://login.tailscale.com.attacker.test/a/x', 'https://user@login.tailscale.com/a/x', 'https://login.tailscale.com:8443/a/x', 'https://login.tailscale.com/a/x?next=evil', 'https://login.tailscale.com/a/x#extra', 'https://login.tailscale.com/a/', 'javascript:alert(1)']) {
    assert.equal(tailscaleLoginUrl(url), undefined);
    client.reply = { BackendState: 'NeedsLogin', AuthURL: url }; await service.setEnabled(true); assert.equal((await service.page()).login.url, undefined);
  }
});

// Raw loopback sockets exercise the real HTTP boundary with the embedded node's PROXY framing.
function httpRequest(path = '/health', options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): string {
  const body = options.body === undefined ? '' : JSON.stringify(options.body);
  const headers = { Host: address, Connection: 'close', ...options.headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}) };
  return [`${options.method ?? 'GET'} ${path} HTTP/1.0`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n');
}
function proxyLine(source = ownerPeer, family = 'TCP4', destination = address) { return `PROXY ${family} ${source} ${destination} 54321 80\r\n`; }
async function exchange(target: string, pieces: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connection(target); const chunks: Buffer[] = [];
    socket.setTimeout(2000, () => socket.destroy(new Error('Timed out')));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error); });
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.once('connect', () => { void (async () => { for (const piece of pieces) { if (socket.destroyed) return; socket.write(piece); if (pieces.length > 1) await new Promise(done => setTimeout(done, 5)); } })(); });
  });
}
function response(wire: string): { status: number; body: any } {
  const end = wire.indexOf('\r\n\r\n'); assert.ok(end > 0); return { status: Number(wire.split(' ', 2)[1]), body: JSON.parse(wire.slice(end + 4)) };
}
async function proxyHost(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'nootify-proxy-')); const lookups: string[] = [];
  const access = new TailnetAccess(80, { ttl: 0, probe: { status: async () => running, whois: async ip => {
    lookups.push(ip); return { UserProfile: { LoginName: [ownerPeer, 'fd7a:115c:a1e0::9'].includes(ip) ? owner : 'other@example.com' } };
  } } }); access.setListening(address);
  let mutations = 0; let requests = 0;
  const unexpected = (): never => { throw new Error('Unexpected settings method'); };
  const settings: SettingsSource = {
    page: unexpected, github: unexpected, startGitHubLogin: unexpected, cancelGitHubLogin: unexpected, signOutGitHub: unexpected,
    larkRegistration: unexpected, startLarkRegistration: unexpected, cancelLarkRegistration: unexpected, larkSetup: unexpected,
    saveLark: unexpected, clearLark: unexpected, larkSecret: unexpected, larkRecipients: unexpected, setRecipient: unexpected, saveChat: unexpected, clearChat: unexpected, chatSecret: unexpected, chatDirectory: unexpected, setNotificationChannel: unexpected,
    exportConfig: unexpected, previewImport: unexpected, importConfig: unexpected, reveal: unexpected,
    tailscale: async (): Promise<TailscalePage> => ({ enabled: true, status: 'connected', deviceName: 'nootify', sharing: 'ready', address, url: access.url(), login: { status: 'waiting', url: loginUrl } }),
    setTailscaleEnabled: async () => { mutations++; }, startTailscaleLogin: async () => { mutations++; return { status: 'starting' }; },
    cancelTailscaleLogin: async () => { mutations++; }, logoutTailscale: async () => { mutations++; },
  };
  const peers = new WeakMap<Socket, string>(); const logs = await EventLog.open(dir);
  const http = createServiceHost([], 'test-token', logs, { tailnet: access, via: 'tailnet', settings, peerAddress: socket => peers.get(socket) });
  http.on('request', () => { requests++; }); const listener = await listenTailnetProxy(http, peers);
  t.after(async () => { await listener.close(); http.closeAllConnections(); await logs.flush(); await rm(dir, { recursive: true, force: true }); });
  return { listener, lookups, settings, logs, mutations: () => mutations, requests: () => requests };
}

test('embedded peer addresses survive fragmented IPv4/IPv6 forwarding and control APIs still need a token', async t => {
  const { listener, lookups } = await proxyHost(t);
  assert.equal(response(await exchange(listener.target, [proxyLine() + httpRequest()])).status, 200);
  assert.deepEqual(lookups, [ownerPeer]);
  const page = response(await exchange(listener.target, ['PRO', proxyLine().slice(3, -1), '\n' + httpRequest('/ui/api/snapshot')]));
  assert.equal(page.status, 200); assert.equal(page.body.access.tailnet_url, `http://${address}/`);
  assert.equal(response(await exchange(listener.target, [proxyLine('fd7a:115c:a1e0::9', 'TCP6', 'fd7a:115c:a1e0::7') + httpRequest()])).status, 200);
  assert.equal(response(await exchange(listener.target, [proxyLine() + httpRequest('/v1/services')])).status, 401);
});

test('HTTP identity headers cannot impersonate an owner or bypass the node Host check', async t => {
  const { listener } = await proxyHost(t);
  assert.equal(response(await exchange(listener.target, [proxyLine('100.64.0.10') + httpRequest('/health', { headers: { 'X-Forwarded-For': ownerPeer, 'Tailscale-User-Login': owner } })])).status, 403);
  assert.equal(response(await exchange(listener.target, [proxyLine() + httpRequest('/health', { headers: { Host: '127.0.0.1' } })])).status, 403);
});

test('remote owners cannot change node settings or receive its authorization URL', async t => {
  const { listener, mutations, settings, logs } = await proxyHost(t);
  const local = createServiceHost([], 'test-token', logs, { settings }); local.listen(0, '127.0.0.1'); await once(local, 'listening');
  t.after(() => { local.closeAllConnections(); local.close(); }); const port = (local.address() as AddressInfo).port;
  const here = response(await exchange(`tcp://127.0.0.1:${port}`, [httpRequest('/ui/api/settings/tailscale', { headers: { Host: `127.0.0.1:${port}` } })]));
  assert.equal(here.body.editable, true); assert.equal(here.body.login.url, loginUrl);
  const remote = response(await exchange(listener.target, [proxyLine() + httpRequest('/ui/api/settings/tailscale')]));
  assert.equal(remote.body.editable, false); assert.deepEqual(remote.body.login, { status: 'waiting' });
  for (const body of [{ action: 'enable', enabled: false }, { action: 'login' }, { action: 'cancel' }, { action: 'logout' }]) {
    assert.equal(response(await exchange(listener.target, [proxyLine() + httpRequest('/ui/api/settings/tailscale', { method: 'POST', body, headers: { 'X-Nootify-Ui': '1', Origin: `http://${address}` } })])).status, 403);
  }
  assert.equal(mutations(), 0);
});

test('forwarded connections keep normal HTTP header and request deadlines', async t => {
  const peers=new WeakMap<Socket,string>();
  const http=createHttpServer({headersTimeout:100,requestTimeout:200,connectionsCheckingInterval:20},(request,response)=>{
    request.resume();request.on('end',()=>response.end('ok'));
  });
  const listener=await listenTailnetProxy(http,peers);t.after(()=>listener.close());
  const results=await Promise.all([
    exchange(listener.target,[proxyLine()+'GET / HTTP/1.1\r\nHost: '+address+'\r\n']),
    exchange(listener.target,[proxyLine()+'POST / HTTP/1.1\r\nHost: '+address+'\r\nContent-Length: 100\r\n\r\nx']),
  ]);
  for(const wire of results) assert.match(wire,/HTTP\/1\.1 408/);
  await listener.close();assert.equal(http.listening,false);
});

test('malformed PROXY frames are rejected before HTTP or identity lookup', async t => {
  const { listener, lookups, requests } = await proxyHost(t);
  for (const prefix of ['', 'PROXY UNKNOWN\r\n', `PROXY TCP4 invalid ${address} 54321 80\r\n`, `PROXY TCP6 ${ownerPeer} ${address} 54321 80\r\n`, `PROXY TCP4 ${ownerPeer} ${address} 0 80\r\n`, `PROXY TCP4 ${ownerPeer} ${address} 54321 65536\r\n`, `PROXY TCP4 ${ownerPeer} ${address} 54321 80 extra\r\n`]) {
    assert.equal(await exchange(listener.target, [prefix + httpRequest()]), '');
  }
  assert.equal(await exchange(listener.target, ['P'.repeat(200)]), ''); assert.equal(requests(), 0); assert.deepEqual(lookups, []);
});
