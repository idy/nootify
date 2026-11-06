import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import * as sdk from '@larksuiteoapi/node-sdk';
import { boundedLarkApi, createLarkApi, readAnnouncement, type LarkApi } from '../src/lark-metadata.js';

function gate<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function within<T>(work: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Test operation did not finish')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function transport(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler); const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const seen: { timeout: number | undefined; signal: boolean; url: string }[] = [];
  const create = sdk.defaultHttpInstance.create;
  t.mock.method(sdk.defaultHttpInstance, 'create', ((config?: Parameters<typeof create>[0]) => {
    const http = create.call(sdk.defaultHttpInstance, config);
    http.interceptors.request.use(request => {
      const path = new URL(request.url!, 'https://open.feishu.cn').pathname;
      seen.push({ timeout: request.timeout, signal: Boolean(request.signal), url: path });
      request.url = origin + path; request.proxy = false;
      return request;
    }, undefined, { synchronous: true });
    return http;
  }) as typeof create);
  const blocked = () => Promise.reject(new Error('The SDK bypassed its isolated bounded transport'));
  t.mock.method(sdk.defaultHttpInstance, 'request', blocked as typeof sdk.defaultHttpInstance.request);
  t.mock.method(sdk.defaultHttpInstance, 'post', blocked as typeof sdk.defaultHttpInstance.post);
  return { seen, sockets };
}
const credentials = () => ({ appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: 'fixture-only-secret' });

test('a deadline bounds an injected API that ignores AbortSignal and handles its late rejection', async () => {
  const pending = gate<unknown>(); let signal: AbortSignal | undefined;
  const raw: LarkApi = { appId: 'cli_fixture', request<T>(_method: 'GET' | 'POST' | 'PATCH', _path: string, _body?: unknown, context?: AbortSignal): Promise<T> { signal = context; return pending.promise as Promise<T>; } };
  const api = boundedLarkApi(raw, 10);
  await assert.rejects(within(api.request('GET', '/fixture')), /timeout|aborted/i);
  assert.equal(signal?.aborted, true);
  pending.reject(new Error('late response from an already retired request'));
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('already cancelled requests never enter the underlying API', async () => {
  let calls = 0;
  const raw: LarkApi = { appId: 'cli_fixture', async request<T>(): Promise<T> { calls++; return {} as T; } };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(boundedLarkApi(raw).request('POST', '/fixture', {}, controller.signal));
  assert.equal(calls, 0);
});

test('routing announcement reads inherit a finite deadline, including raw injected delegates', async () => {
  let context: AbortSignal | undefined;
  const raw: LarkApi = { appId: 'cli_fixture', request<T>(_method: 'GET' | 'POST' | 'PATCH', _path: string, _body?: unknown, signal?: AbortSignal): Promise<T> {
    context = signal; return new Promise<T>(() => {});
  } };
  await assert.rejects(within(readAnnouncement(boundedLarkApi(raw, 10), 'oc_fixture')), /timeout|aborted/i);
  assert.equal(context?.aborted, true);
});

test('the SDK token transport itself aborts stalled auth sockets rather than accumulating abandoned requests', { timeout: 10_000 }, async t => {
  let tokenCalls = 0; const closed: Promise<unknown>[] = [];
  const f = await transport(t, (request, _response) => {
    assert.match(request.url!, /tenant_access_token/);
    tokenCalls++; request.resume();
    closed.push(new Promise<void>(resolve => request.socket.once('close', () => resolve())));
  });
  const oldTimeout = sdk.defaultHttpInstance.defaults.timeout;
  const api = createLarkApi(credentials(), 100);
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(within(api.request('GET', '/open-apis/bot/v3/info')));
  await within(Promise.all(closed));
  assert.equal(tokenCalls, 3);
  assert.equal(f.sockets.size, 0);
  assert.ok(f.seen.every(request => request.timeout === 100 && request.signal));
  assert.equal(sdk.defaultHttpInstance.defaults.timeout, oldTimeout, 'one app must not mutate SDK global defaults');
});

test('custom bounded HTTP preserves SDK body decoding and exposes provider time independently of the host clock', async t => {
  const provider = 1_700_000_000_000;
  const f = await transport(t, (request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'application/json', date: new Date(provider).toUTCString() });
    response.end(JSON.stringify(request.url!.includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'fixture-tenant-token', expire: 7_200 }
      : { code: 0, data: { marker: 'body-decoded' } }));
  });
  const api = createLarkApi(credentials(), 1_000);
  assert.equal(api.serverTime?.(), undefined);
  assert.deepEqual(await api.request('GET', '/open-apis/bot/v3/info'), { marker: 'body-decoded' });
  const clock = api.serverTime!()!;
  assert.ok(clock >= provider && clock < provider + 2_000);
  assert.equal(f.seen.length, 2);
  assert.ok(f.seen.every(request => request.timeout === 1_000 && request.signal));
});
