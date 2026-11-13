import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { authorizeUiFixture, settleUiFixture } from './ui-transport-fixture.js';

test('workspace log search retains its query and keyboard shortcut across navigation', async t => {
  const { window, document } = parseHTML(await readFile(new URL('../../public/index.html', import.meta.url), 'utf8'));
  let focused: HTMLElement | null = null;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  t.mock.method(window.HTMLElement.prototype, 'focus', function (this: HTMLElement) { focused = this; });
  const location = new URL('http://127.0.0.1:9417/#/logs');
  const globals: Record<string, unknown> = {
    window, document, Element: window.Element,
    navigator: { languages: ['en-US'], language: 'en-US' }, location,
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 0,
    matchMedia: () => ({ matches: false }),
  };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(async () => {
    await settleUiFixture();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  t.mock.method(globalThis, 'setInterval', (() => 0) as unknown as typeof globalThis.setInterval);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input), 'http://127.0.0.1:9417').pathname;
    if (path === '/ui/api/snapshot') return Response.json({ time: new Date().toISOString(), modules: [], sessions: [], logs: [] });
    if (path === '/ui/api/agents') return Response.json({ agents: [], editable: true });
    assert.fail(`Unexpected request: ${path}`);
  });
  authorizeUiFixture(t);
  await import('../src/ui-app.js');
  await nextTurn();

  const input = document.getElementById('search')! as unknown as HTMLInputElement;
  const logs = document.getElementById('logs-view')!;
  assert.equal(input.closest('.view'), logs);
  assert.equal(input.closest('.titlebar'), null);
  assert.equal(document.querySelector('.search-toggle'), null);
  assert.equal(input.closest('.logs-search')?.nextElementSibling?.id, 'outcome-tabs');
  const slash = (target: HTMLElement) => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value: '/' });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };

  assert.equal(slash(document.body as unknown as HTMLElement), true);
  assert.equal(focused, input);
  input.value = 'synthetic retained query';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(slash(input), false, 'Typing a slash inside search must remain ordinary input');
  const refresh = document.getElementById('refresh')! as unknown as HTMLElement;
  refresh.focus(); refresh.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(input.value, 'synthetic retained query');
  assert.equal(input.closest('.logs-search')?.hasAttribute('hidden'), false);

  location.hash = '#/sessions'; window.dispatchEvent(new window.Event('hashchange'));
  assert.equal(logs.hidden, true);
  assert.equal(input.value, 'synthetic retained query');
  assert.equal(slash(document.body as unknown as HTMLElement), true);
  assert.equal(location.hash, '#/logs');
  window.dispatchEvent(new window.Event('hashchange'));
  assert.equal(logs.hidden, false);
  assert.equal(focused, input, 'The shortcut returns to Logs and focuses its content search');
  assert.equal(input.value, 'synthetic retained query');
});
