import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createServiceHost } from '../src/server.js';
import { EventLog } from '../src/events.js';
import { requestOwnerUiGrant } from '../src/ui-owner-auth.js';
import type { ProvidersService } from '../src/providers.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-ui-owner-'));
  const token = 'synthetic-owner-secret-not-transmitted'; let reads = 0; let writes = 0;
  const logs = await EventLog.open(directory);
  const page = { node_id: 'synthetic-node', providers: [], remote: { enabled: false, listen: '127.0.0.1:9418', status: 'disabled', tls: false, token_set: true, peers: [] } };
  const providers = { async page() { return page; }, async action() { writes++; return page; }, async remoteSecret() { reads++; return { token: 'synthetic-remote-secret' }; } } as unknown as ProvidersService;
  const server = createServiceHost([], token, logs, { providers }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await logs.flush(); await rm(directory, { recursive: true, force: true }); });
  const post = (path: string, headers: Record<string, string> = {}) => fetch(new URL(path, base), { method: 'POST', headers: { 'x-nootify-ui': '1', 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action: 'default', id: 'test' }) });
  return { token, server, base, post, reads: () => reads, writes: () => writes };
}

test('a forgeable UI header and loopback address cannot read secrets or change providers', async t => {
  const f = await fixture(t);
  const attempts: Record<string, string>[] = [{}, { authorization: 'Bearer incorrect' }, { cookie: 'nootify_owner=forged' }];
  for (const headers of attempts) {
    assert.equal((await f.post('/ui/api/providers', headers)).status, 403);
    assert.equal((await f.post('/ui/api/settings/remote/secret', headers)).status, 403);
  }
  assert.equal(f.reads(), 0); assert.equal(f.writes(), 0);
  assert.equal((await (await fetch(new URL('/ui/api/providers', f.base))).json()).editable, false);
  assert.equal((await f.post('/ui/api/providers', { authorization: `Bearer ${f.token}` })).status, 200);
  assert.equal(f.writes(), 1);
});

test('owner proof creates a one-use clean-root login link and an HttpOnly session cookie', async t => {
  const f = await fixture(t); const requests: string[] = []; const real = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.stringify({ url: String(input), headers: init?.headers, body: init?.body }));
    return real(input, init);
  });
  const link = await requestOwnerUiGrant(f.base, f.token, '#/providers');
  assert.ok(!requests.join('\n').includes(f.token), 'bootstrap must not expose root credentials to a squatted HTTP port');
  assert.equal(new URL(link).pathname, '/');
  const response = await fetch(link, { redirect: 'manual', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' } });
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/#/providers');
  const setCookie = response.headers.get('set-cookie')!;
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const cookie = setCookie.split(';')[0];
  assert.equal((await fetch(link, { redirect: 'manual' })).status, 403, 'grant cannot be replayed');
  assert.equal((await (await fetch(new URL('/ui/api/providers', f.base), { headers: { cookie } })).json()).editable, true);
  const secret = await f.post('/ui/api/settings/remote/secret', { cookie });
  assert.equal(secret.status, 200); assert.equal((await secret.json()).token, 'synthetic-remote-secret');
  assert.equal((await fetch(new URL('/v1/services', f.base), { headers: { cookie } })).status, 401, 'UI cookie cannot authorize general control APIs');
  assert.equal((await f.post('/ui/api/providers', { cookie, origin: 'https://foreign.invalid' })).status, 403);
});

test('owner grants and cookies expire and reject tampering', async t => {
  const f = await fixture(t); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const expired = await requestOwnerUiGrant(f.base, f.token); now += 30001;
  assert.equal((await fetch(expired, { redirect: 'manual' })).status, 403);
  const link = await requestOwnerUiGrant(f.base, f.token);
  const response = await fetch(link, { redirect: 'manual' }); const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const bad = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
  assert.equal((await f.post('/ui/api/providers', { cookie: bad })).status, 403);
  now += 8 * 60 * 60_000 + 1;
  assert.equal((await f.post('/ui/api/providers', { cookie })).status, 403);
});

test('a local imposter cannot solicit an owner proof or redirect a browser grant', async t => {
  let posts = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') posts++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ challenge: 'A'.repeat(43), issued_at: Date.now(), proof: 'B'.repeat(43) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  await assert.rejects(requestOwnerUiGrant(base, 'private-owner-secret'), /owner identity/);
  assert.equal(posts, 0);
  await assert.rejects(requestOwnerUiGrant('https://remote.invalid/', 'private-owner-secret'), /local service origin/);
});

test('captured owner proof cannot be replayed to mint another grant', async t => {
  const f = await fixture(t); const real = globalThis.fetch;
  let proofBody = '';
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/ui/api/auth/grant')) proofBody = String(init?.body);
    return real(input, init);
  });
  await requestOwnerUiGrant(f.base, f.token);
  const response = await real(new URL('/ui/api/auth/grant', f.base), { method: 'POST', headers: { 'x-nootify-ui': '1', 'content-type': 'application/json' }, body: proofBody });
  assert.equal(response.status, 403);
});
