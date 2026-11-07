import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

test('background checks stay quiet, available updates are actionable, and current status disappears', async t => {
  const { window, document } = parseHTML(await readFile(new URL('../../public/index.html', import.meta.url), 'utf8'));
  const location = new URL('http://127.0.0.1:9417/#/logs');
  const globals: Record<string, unknown> = {
    window, document, Element: window.Element,
    navigator: { languages: ['en-US'], language: 'en-US' }, location,
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 0, matchMedia: () => ({ matches: false }),
  };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  const prototype = window.HTMLSelectElement.prototype;
  const selectValue = Object.getOwnPropertyDescriptor(prototype, 'value')!;
  Object.defineProperty(prototype, 'value', { ...selectValue, set(this: HTMLSelectElement, value: string) {
    for (const option of this.querySelectorAll('option')) option.selected = option.value === value;
  } });
  t.after(() => Object.defineProperty(prototype, 'value', selectValue));
  t.mock.method(globalThis, 'setInterval', (() => 0) as unknown as typeof globalThis.setInterval);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input), 'http://127.0.0.1:9417').pathname;
    if (path === '/ui/api/snapshot') return Response.json({ time: new Date().toISOString(), modules: [], sessions: [], logs: [] });
    if (path === '/ui/api/agents') return Response.json({ agents: [], editable: true });
    assert.fail(`Unexpected request: ${path}`);
  });
  await import('../src/ui-app.js');
  await nextTurn();
  const titlebar = document.getElementById('titlebar-update')!;
  const button = document.getElementById('update-action')!;
  const about = document.getElementById('about-update-action')! as unknown as HTMLButtonElement;
  assert.equal(titlebar.hidden, true, 'A plain browser has no native update controls');
  assert.equal(about.hidden, true);
  const send = (phase: string, fields: Record<string, unknown> = {}) => {
    window.dispatchEvent(new window.CustomEvent('nootify-update', { detail: {
      phase, current: '0.1.18', version: null, received: 0, total: null, error: null, checked_at: null, ...fields,
    } }));
  };
  for (const phase of ['idle', 'checking', 'current', 'failed']) {
    send(phase, phase === 'failed' ? { error: 'Offline' } : {});
    assert.equal(titlebar.hidden, true, `${phase} must not occupy the title row`);
    assert.equal(about.hidden, false, 'Manual checks remain available in About');
  }
  assert.match(document.getElementById('update-status')!.textContent!, /Offline/);
  send('current');
  about.click();
  assert.equal(location.href, 'nootify://update/check');
  send('available', { version: '0.2.0' });
  assert.equal(titlebar.hidden, false);
  assert.match(button.textContent!, /Update v0.2.0/);
  assert.equal(document.querySelector<HTMLElement>('.update-dot')!.hidden, false);
  button.click();
  assert.equal(location.href, 'nootify://update/install');
  send('downloading', { version: '0.2.0', received: 42, total: 100 });
  assert.equal(titlebar.hidden, false);
  assert.match(button.textContent!, /42%/);
  assert.equal(about.disabled, true);
  send('available', { version: '0.2.0', error: 'Download interrupted' });
  assert.equal(titlebar.hidden, false, 'A failed installation keeps its retry action');
  assert.equal(about.disabled, false);
  assert.match(button.textContent!, /Retry update/);
  about.click();
  assert.equal(location.href, 'nootify://update/install');
  send('current');
  assert.equal(titlebar.hidden, true, 'Up to date disappears after a successful check');
  assert.equal(document.querySelector<HTMLElement>('.update-dot')!.hidden, true);
  assert.equal(about.disabled, false);
  assert.equal(about.textContent, 'Check for updates');
});
