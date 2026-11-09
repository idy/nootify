import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Agent, createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createServiceHost } from '../src/server.js';
import { EventLog } from '../src/events.js';
import { requestOwnerUiSession } from '../src/ui-owner-auth.js';
import { startOwnerUiGateway } from '../src/ui-gateway.js';
import { UiCodec, UiTransport, type UiEnvelope } from '../src/ui-transport.js';
import type { ProvidersService } from '../src/providers.js';
import type { SettingsSource } from '../src/ui.js';
import { UiSessions, uiSessionIdle } from '../src/ui-session-host.js';
import type { TailnetAccess } from '../src/tailnet.js';

async function stop(server: Server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
async function fixture(t: TestContext, slowDirectory = false) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-ui-owner-'));
  const token = 'synthetic-owner-secret-not-transmitted'; let reads = 0; let writes = 0;
  const logs = await EventLog.open(directory);
  const page = { node_id: 'synthetic-node', providers: [], remote: { enabled: false, listen: '127.0.0.1:9418', status: 'disabled', tls: false, token_set: true, peers: [] } };
  const providers = { async page() { return page; }, async action() { writes++; return page; }, async remoteSecret() { reads++; return { token: 'synthetic-remote-secret' }; } } as unknown as ProvidersService;
  const settings = { async larkRecipients(send?: (value: unknown) => void, signal?: AbortSignal) { send?.({ users: [{ name: 'private-directory-entry' }] }); if (slowDirectory && !signal?.aborted) await new Promise<void>(done => signal?.addEventListener('abort', () => done(), { once: true })); return { users: [{ name: 'private-directory-entry' }] }; } } as unknown as SettingsSource;
  const server = createServiceHost([], token, logs, { providers, settings }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/`;
  t.after(async () => { if (server.listening) await stop(server); await logs.flush(); await rm(directory, { recursive: true, force: true }); });
  return { token, server, base, port, reads: () => reads, writes: () => writes };
}
export function transportFor(url: string, network?: typeof fetch): UiTransport {
  const parsed = new URL(url); const parameters = new URLSearchParams(parsed.hash.slice(1));
  const [id, key] = parameters.get('nootify-ui')!.split('.');
  return new UiTransport(parsed.origin, { id: id!, key: key!, expires: Number.MAX_SAFE_INTEGER }, network);
}
async function gateway(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const gateway = await startOwnerUiGateway(f.base, f.token, '#/providers'); t.after(() => gateway.close()); return gateway;
}

test('forged UI headers, old cross-port cookies and unauthenticated browser POSTs cannot authorize settings', async t => {
  const f = await fixture(t);
  const attempts: Record<string, string>[] = [{}, { authorization: 'Bearer incorrect' }, { cookie: 'nootify_owner=stolen-from-another-port' }];
  for (const headers of attempts) {
    for (const path of ['/ui/api/providers', '/ui/api/settings/remote/secret']) {
      assert.equal((await fetch(new URL(path, f.base), { method: 'POST', headers: { 'x-nootify-ui': '1', ...headers }, body: '{}' })).status, 403);
    }
  }
  assert.equal(f.reads(), 0); assert.equal(f.writes(), 0);
  const readOnly = new UiTransport(new URL(f.base).origin);
  await assert.rejects(readOnly.fetch('/ui/api/providers', { method: 'POST', body: 'private' }), /authorization/);
  assert.equal((await (await readOnly.fetch('/ui/api/providers')).json()).editable, false);
});

test('owned gateway serves trusted code and encrypts settings, reads and directory stream frames without cookies', async t => {
  const f = await fixture(t); const g = await gateway(t, f);
  assert.notEqual(new URL(g.url).port, String(f.port));
  const asset = await fetch(new URL('/ui/app.js', g.url));
  assert.equal(asset.status, 200); assert.match(await asset.text(), /browserUiTransport/); assert.equal(asset.headers.get('set-cookie'), null);
  const wire: string[] = [];
  const client = transportFor(g.url, async (input, init) => { wire.push(JSON.stringify({ input: String(input), headers: init?.headers, body: init?.body })); return fetch(input, init); });
  assert.equal((await (await client.fetch('/ui/api/providers')).json()).editable, true);
  assert.equal((await client.fetch('/ui/api/providers', { method: 'POST', body: JSON.stringify({ action: 'save', secret: 'private-provider-credential' }) })).status, 200);
  assert.equal((await (await client.fetch('/ui/api/settings/remote/secret', { method: 'POST' })).json()).token, 'synthetic-remote-secret');
  const directory = await client.fetch('/ui/api/settings/lark/recipients/stream', { method: 'POST', body: '{}' });
  const frames = (await directory.text()).trim().split('\n').map(value => JSON.parse(value) as { type: string });
  assert.deepEqual(frames.map(value => value.type), ['progress', 'complete']);
  assert.equal(f.writes(), 1); assert.equal(f.reads(), 1);
  const traffic = wire.join('\n');
  for (const secret of [f.token, 'private-provider-credential', 'synthetic-remote-secret', 'private-directory-entry', 'nootify_owner']) assert.ok(!traffic.includes(secret), secret);
  await assert.rejects(client.fetch(new URL('/v1/services', g.url)), /Invalid UI request target/);
});

test('daemon replacement after verification cannot replace the initial document/scripts or receive submitted secrets', async t => {
  const f = await fixture(t); const g = await gateway(t, f); // service proved itself, browser has not loaded anything yet
  await stop(f.server);
  const captured: string[] = [];
  const attacker = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    captured.push(JSON.stringify({ url: request.url, headers: request.headers, body }));
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"service":"nootify","modules":[],"hostile":true}');
  });
  attacker.listen(f.port, '127.0.0.1'); await once(attacker, 'listening'); t.after(() => stop(attacker));
  const document = await fetch(new URL('/', g.url)); const html = await document.text();
  assert.match(html, /Nootify/); assert.ok(!html.includes('hostile'));
  const script = await fetch(new URL('/ui/app.js', g.url)); assert.match(await script.text(), /browserUiTransport/);
  assert.equal(captured.length, 0, 'asset loading must never consult the replaceable daemon');
  const client = transportFor(g.url);
  const result = await client.fetch('/ui/api/providers', { method: 'POST', body: JSON.stringify({ secret: 'typed-after-service-replacement' }) });
  assert.equal(result.status, 502); await result.text();
  const wire = captured.join('\n');
  assert.ok(captured.length > 0);
  assert.ok(!wire.includes('typed-after-service-replacement')); assert.ok(!wire.includes(f.token)); assert.ok(!wire.includes('cookie'));
});

test('an already established page never sends plaintext or capabilities to a replacement gateway listener', async t => {
  const f = await fixture(t); const g = await startOwnerUiGateway(f.base, f.token); const client = transportFor(g.url);
  await (await client.fetch('/ui/api/providers')).text();
  const port = Number(new URL(g.url).port); await g.close();
  const seen: string[] = [];
  const attacker = createServer(async (request, response) => { let body = ''; for await (const chunk of request) body += String(chunk); seen.push(JSON.stringify({ headers: request.headers, body })); response.end('{}'); });
  attacker.listen(port, '127.0.0.1'); await once(attacker, 'listening'); t.after(() => stop(attacker));
  await assert.rejects(client.fetch('/ui/api/providers', { method: 'POST', body: '{"secret":"private-user-input"}' }), /authenticated/);
  assert.ok(!seen.join('\n').includes('private-user-input'));
  assert.ok(!seen.join('\n').includes(new URLSearchParams(new URL(g.url).hash.slice(1)).get('nootify-ui')!.split('.')[1]!));
  const count = seen.length;
  await assert.rejects(client.fetch('/ui/api/providers', { method: 'POST', body: 'never-fallback' }), /authorize this window again/);
  assert.equal(seen.length, count);
});

test('successful encrypted completion drains natural EOF without cancelling its network source', async t => {
  const f = await fixture(t); const g = await gateway(t, f); let cancellations = 0;
  const client = transportFor(g.url, async (input, init) => {
    const response = await fetch(input, init); const reader = response.body!.getReader();
    return new Response(new ReadableStream({
      async pull(controller) { const chunk = await reader.read(); if (chunk.done) controller.close(); else controller.enqueue(chunk.value); },
      async cancel() { cancellations++; await reader.cancel(); },
    }), { status: response.status, headers: response.headers });
  });
  assert.equal((await (await client.fetch('/ui/api/providers')).json()).editable, true);
  assert.equal(cancellations, 0);
});

test('intentional stream cancellation retains a valid encrypted session for the next request', async t => {
  const f = await fixture(t, true); const g = await gateway(t, f); const client = transportFor(g.url);
  const abort = new AbortController();
  const response = await client.fetch('/ui/api/settings/lark/recipients/stream', { method: 'POST', body: '{}', signal: abort.signal });
  const reader = response.body!.getReader();
  assert.ok((await reader.read()).value!.length > 0);
  abort.abort();
  await assert.rejects(reader.read());
  assert.equal(client.authorized, true, 'caller abort must not revoke the capability');
  assert.equal((await (await client.fetch('/ui/api/providers')).json()).editable, true);
});

test('encrypted operations reject replay/tampering and expired capabilities', async t => {
  const f = await fixture(t); const g = await gateway(t, f); let last: RequestInit | undefined;
  const client = transportFor(g.url, (input, init) => { last = init; return fetch(input, init); });
  await (await client.fetch('/ui/api/providers', { method: 'POST', body: '{}' })).text();
  const endpoint = new URL('/ui/api/secure', g.url);
  assert.equal((await fetch(endpoint, last)).status, 403); assert.equal(f.writes(), 1);
  const value = JSON.parse(String(last!.body)) as { data: string }; value.data = (value.data.startsWith('a') ? 'b' : 'a') + value.data.slice(1);
  assert.equal((await fetch(endpoint, { ...last, body: JSON.stringify(value) })).status, 403);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 8 * 60 * 60_000 + 1);
  await assert.rejects(client.fetch('/ui/api/providers'), /authenticated/);
});

test('a Host-preserving active relay learns no traffic key and cannot decrypt or forge owner operations', async t => {
  const f = await fixture(t); const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const responses: string[] = []; const operations: UiEnvelope[] = [];
  const relay = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (incoming.url === '/ui/api/secure') operations.push(JSON.parse(body.toString('utf8')) as UiEnvelope);
    const forwarded = httpRequest(new URL(incoming.url!, f.base), { method: incoming.method, headers: incoming.headers, agent }, response => {
      outgoing.writeHead(response.statusCode!, response.headers); const returned: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { returned.push(chunk); outgoing.write(chunk); });
      response.once('end', () => { responses.push(Buffer.concat(returned).toString('utf8')); outgoing.end(); });
      response.once('error', () => outgoing.destroy());
    });
    forwarded.once('error', () => outgoing.destroy()); forwarded.end(body);
  });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  t.after(async () => { agent.destroy(); await stop(relay); });
  const origin = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const capability = await requestOwnerUiSession(origin, f.token);
  const issuance = JSON.parse(responses.find(value => value.includes('"session"'))!) as { session: Record<string, unknown> };
  assert.deepEqual(Object.keys(issuance.session).sort(), ['expires', 'id']);
  assert.ok(!responses.join('\n').includes(capability.key)); assert.ok(!responses.join('\n').includes(f.token));
  const client = new UiTransport(origin, capability);
  assert.equal((await (await client.fetch('/ui/api/providers', { method: 'POST', body: '{"secret":"private-through-active-relay"}' })).json()).editable, true);
  const operation = operations[0]!;
  const guessed = new UiCodec({ ...capability, key: 'A'.repeat(43) });
  await assert.rejects(guessed.open(operation, operation.request, 'request'));
  assert.ok(!JSON.stringify(operations).includes('private-through-active-relay'));
  const forged = { ...operation, request: 'Z'.repeat(32), data: 'A' + operation.data.slice(1) };
  assert.equal((await fetch(origin + '/ui/api/secure', { method: 'POST', headers: { 'x-nootify-ui': '1', 'content-type': 'application/json' }, body: JSON.stringify(forged) })).status, 403);
  assert.equal(f.writes(), 1);
});

test('closing gateways revokes daemon capabilities and permits more than 32 sequential authorizations', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 40; index++) {
    const g = await startOwnerUiGateway(f.base, f.token);
    const client = transportFor(g.url);
    assert.equal((await (await client.fetch('/ui/api/providers')).json()).editable, true);
    await g.close();
  }
  const capability = await requestOwnerUiSession(f.base, f.token);
  const client = new UiTransport(new URL(f.base).origin, capability);
  await client.close();
  const stale = new UiTransport(new URL(f.base).origin, capability);
  await assert.rejects(stale.fetch('/ui/api/providers'), /authenticated/);
});

test('abandoned UI sessions reclaim capacity after inactivity', async t => {
  const sessions = new UiSessions(); const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (let index = 0; index < 32; index++) sessions.create();
  assert.throws(() => sessions.create(), /Too many/);
  t.mock.method(Date, 'now', () => now + uiSessionIdle + 1);
  assert.doesNotThrow(() => sessions.create());
});

test('authenticated activity refreshes both UI session idle leases', async t => {
  const f = await fixture(t); const g = await gateway(t, f); const client = transportFor(g.url);
  const now = Date.now(); let elapsed = 0;
  t.mock.method(Date, 'now', () => now + elapsed);
  for (let index = 0; index < 5; index++) {
    elapsed += 2 * 60_000;
    assert.equal((await (await client.fetch('/ui/api/providers')).json()).editable, true);
  }
});

test('authenticated invalid methods and wrapped import sizes return encrypted errors without breaking either hop', async t => {
  const f = await fixture(t); const g = await gateway(t, f);
  const clients = [transportFor(g.url), new UiTransport(new URL(f.base).origin, await requestOwnerUiSession(f.base, f.token))];
  for (const client of clients) {
    const unsupported = await client.fetch('/ui/api/providers', { method: 'PATCH', body: '{}' });
    assert.equal(unsupported.status, 400); assert.match(await unsupported.text(), /Invalid owner UI operation/);
    // A file can fit the UI file limit while the document/apply wrapper exceeds
    // the inner request limit. Neither authenticated validation error may revoke.
    const document = 'x'.repeat(1024 * 1024 - 1);
    const tooLarge = await client.fetch('/ui/api/settings/import', { method: 'POST', body: JSON.stringify({ document, apply: true }) });
    assert.equal(tooLarge.status, 400); assert.match(await tooLarge.text(), /Invalid owner UI operation/);
    assert.equal(client.authorized, true);
    assert.equal((await (await client.fetch('/ui/api/providers')).json()).editable, true);
  }
  assert.equal(f.writes(), 0);
});

test('Tailnet repository actions reach their authorized listener while anonymous local settings remain protected', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-tailnet-ui-'));
  const logs = await EventLog.open(directory); let refreshed = 0; let followed = 0;
  const tailnet = { authorize: async () => undefined, url: () => 'http://100.64.0.7/' } as unknown as TailnetAccess;
  const pulls = { refresh: () => { refreshed++; }, setChoice: async () => { followed++; return {}; } } as unknown as import('../src/ui.js').PullsSource;
  const server = createServiceHost([], 'synthetic-token', logs, { via: 'tailnet', tailnet, pulls });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await stop(server); await logs.flush(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let requests = 0;
  const client = new UiTransport('http://100.64.0.7', undefined, (input, init) => {
    requests++; const url = new URL(String(input));
    return fetch(base + url.pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), host: url.host } });
  });
  assert.equal((await client.fetch('/ui/api/pulls/refresh', { method: 'POST' })).status, 202);
  assert.equal((await client.fetch('/ui/api/repos', { method: 'POST', body: JSON.stringify({ repository: 'owner/repo', follow: true }) })).status, 200);
  assert.deepEqual([refreshed, followed, requests], [1, 1, 2]);
  await assert.rejects(client.fetch('/ui/api/settings/remote', { method: 'POST', body: '{}' }), /authorization/);
  assert.equal(requests, 2);
  const local = new UiTransport(base, undefined, () => { throw new Error('Unprivileged local POST must not reach network'); });
  await assert.rejects(local.fetch('/ui/api/repos', { method: 'POST', body: '{}' }), /authorization/);
});

test('bootstrap proves ownership on the same TCP connection and never sends a root bearer to an imposter', async t => {
  let posts = 0; const captured: string[] = [];
  const imposter = createServer(async (request, response) => { if (request.method === 'POST') posts++; captured.push(JSON.stringify(request.headers)); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ challenge: 'A'.repeat(32), issued_at: Date.now(), proof: 'B'.repeat(43) })); });
  imposter.listen(0, '127.0.0.1'); await once(imposter, 'listening'); t.after(() => stop(imposter));
  await assert.rejects(requestOwnerUiSession(`http://127.0.0.1:${(imposter.address() as { port: number }).port}/`, 'private-root-secret'), /owner identity/);
  assert.equal(posts, 0); assert.ok(!captured.join('\n').includes('private-root-secret'));
  const f = await fixture(t); let grants = 0;
  f.server.prependListener('request', (request, response) => { if (request.url?.includes('/challenge')) response.setHeader('connection', 'close'); if (request.url?.endsWith('/grant')) grants++; });
  await assert.rejects(requestOwnerUiSession(f.base, f.token), /connection changed/); assert.equal(grants, 0);
});
