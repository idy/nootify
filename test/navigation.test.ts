import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { UiTransport } from '../src/ui-transport.js';
import { authorizeUiFixture, settleUiFixture } from './ui-transport-fixture.js';

test('retired PR routes fall back to Logs without fetching GitHub data', async t => {
  const { window, document } = parseHTML(await readFile(new URL('../../public/index.html', import.meta.url), 'utf8'));
  const location = new URL('http://127.0.0.1:9417/#/pulls/internal');
  const globals: Record<string, unknown> = {
    window, document, Element: window.Element, HTMLElement: window.HTMLElement, location,
    navigator: { languages: ['en-US'], language: 'en-US' },
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 0, matchMedia: () => ({ matches: false }),
    CSS: { escape: (value: string) => value },
  };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(async () => {
    await settleUiFixture();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  const timers: (() => void)[] = [];
  t.mock.method(globalThis, 'setInterval', ((run: () => void) => { timers.push(run); return 0; }) as unknown as typeof setInterval);
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input), location).pathname;
    requests.push(path);
    if (path === '/ui/api/snapshot') return Response.json({ time: new Date().toISOString(), modules: [{ name: 'sessions', status: 'ready' }], sessions: [], logs: [] });
    if (path === '/ui/api/agents') return Response.json({ agents: [], editable: true });
    assert.fail(`Unexpected request from retired route: ${path}`);
  });
  authorizeUiFixture(t);
  await import('../src/ui-app.js');
  await settleUiFixture();
  assert.equal(document.querySelector('#pulls-view, #repos-view, [data-view="settings-github"], #github-signin'), null);
  assert.deepEqual([...document.querySelectorAll('.nav [data-view]')].map(item => item.getAttribute('data-view')), ['logs', 'sessions', 'providers', 'agents']);
  for (const hash of ['#/pulls/internal', '#/pulls/upstream', '#/repos', '#/settings/github']) {
    location.hash = hash;
    window.dispatchEvent(new window.Event('hashchange'));
    for (const run of timers) run();
    await settleUiFixture();
    assert.equal(document.getElementById('logs-view')!.hidden, false, hash);
    assert.equal(document.title, 'Logs · Nootify', hash);
  }
  assert.deepEqual([...new Set(requests)].sort(), ['/ui/api/agents', '/ui/api/snapshot']);
});

test('direct LAN UI requests no longer have repository mutation exceptions', async () => {
  const requests: string[] = [];
  const transport = new UiTransport('http://192.168.1.20:9417', undefined, async input => {
    requests.push(String(input));
    return Response.json({});
  });
  await transport.fetch('/ui/api/snapshot');
  for (const path of ['/ui/api/repos', '/ui/api/pulls/refresh', '/ui/api/settings']) {
    await assert.rejects(transport.fetch(path, { method: 'POST' }), /Local access is required/);
  }
  assert.deepEqual(requests, ['http://192.168.1.20:9417/ui/api/snapshot']);
});
