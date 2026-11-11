import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { EventLog } from '../src/events.js';
import { createServiceHost } from '../src/server.js';
import { assertMode } from './platform-fixtures.js';

// Follow the served stylesheet graph, including relative fonts and SVG masks.
// A missing allowlist entry otherwise ships an unstyled or partially styled UI.
test('the pinned design system and all CSS dependencies load through the trusted same-origin asset routes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-design-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServiceHost([], 'synthetic-assets-token', await EventLog.open(directory));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const visited = new Set<string>();
  async function visit(url: URL): Promise<void> {
    assert.equal(url.origin, origin, 'UI assets must remain local and usable offline');
    if (visited.has(url.pathname)) return;
    visited.add(url.pathname);
    const response = await fetch(url);
    assert.equal(response.status, 200, url.pathname);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const body = await response.arrayBuffer(); assert.ok(body.byteLength > 0, url.pathname);
    if (url.pathname.endsWith('.css')) {
      assert.match(response.headers.get('content-type')!, /^text\/css/);
      for (const match of new TextDecoder().decode(body).matchAll(/url\(["']?([^\s"')]+)["']?\)/g)) await visit(new URL(match[1]!, url));
    } else if (url.pathname.endsWith('.woff2')) assert.equal(response.headers.get('content-type'), 'font/woff2');
    else if (url.pathname.endsWith('.svg')) assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  }
  await visit(new URL('/ui/styles.css', origin));
  assert.ok(visited.has('/ui/vendor/magpie/css/components.css'));
  assert.ok(visited.has('/ui/vendor/magpie/fonts/monda-latin.woff2'));
  assert.ok(visited.has('/ui/vendor/magpie/icons/check.svg'));
  assert.notEqual((await fetch(origin + '/ui/vendor/magpie/README.md')).status, 200, 'Do not expose arbitrary vendor files');
});

test('logs persist bounded public fields and discard unknown credential fields', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-logs-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await EventLog.open(dir);
  log.report({ status: 'ignored', reason: 'session_archived', preview: 'x'.repeat(500), socket_token: 'secret-not-for-ui',
    error: 'Authorization: Bearer fake-secret' });
  await log.flush();
  const reopened = await EventLog.open(dir);
  const entries = reopened.recent();
  assert.equal(entries[0].preview?.length, 240);
  assert.ok(!JSON.stringify(entries).includes('secret-not-for-ui'));
  assert.ok(!JSON.stringify(entries).includes('fake-secret'));
  assert.equal(entries[0].reason, 'session_archived');
  await assertMode(join(dir, 'events.ndjson'), 0o600);
});

test('read-only UI serves real logs while cross-site and unauthenticated control requests fail', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-ui-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const logs = await EventLog.open(dir); logs.report({ status: 'ignored', reason: 'session_not_local', message_id: 'om_fixture' }); await logs.flush();
  const server = createServiceHost([], 'test-token', logs);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await fetch(origin); assert.equal(page.status, 200); assert.match(await page.text(), /运行日志/);
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const snapshot = await (await fetch(origin + '/ui/api/snapshot')).json() as { logs: { message_id?: string }[] };
  assert.equal(snapshot.logs[0].message_id, 'om_fixture');
  assert.equal((await fetch(origin + '/ui/api/snapshot', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const rebindingStatus = await new Promise<number | undefined>((resolveStatus, reject) => {
    const req = request(origin + '/ui/api/snapshot', { headers: { host: 'attacker.test' } }, response => {
      response.resume(); response.once('end', () => resolveStatus(response.statusCode));
    });
    req.once('error', reject); req.end();
  });
  assert.equal(rebindingStatus, 403);
  assert.equal((await fetch(origin + '/v1/sessions', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(origin + '/ui/app.js', { headers: { origin } })).status, 200);
  assert.equal((await fetch(origin + '/ui/lark-profile.js', { headers: { origin } })).status, 200);
  assert.equal((await fetch(origin + '/ui/dropdown.js', { headers: { origin } })).status, 200);
  const translations = await fetch(origin + '/ui/ui-i18n.js', { headers: { origin } });
  assert.equal(translations.status, 200);
  assert.match(translations.headers.get('content-type')!, /javascript/);
  assert.match(await translations.text(), /Follow system/);
  assert.equal((await fetch(origin, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' } })).status, 200);
});
