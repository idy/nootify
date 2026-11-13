import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { authorizeUiFixture, settleUiFixture } from './ui-transport-fixture.js';

test('narrow navigation reuses the sidebar in a modal drawer and restores desktop navigation', async t => {
  const { window, document } = parseHTML(await readFile(new URL('../../public/index.html', import.meta.url), 'utf8'));
  const location = new URL('http://127.0.0.1:9417/#/logs');
  let narrow = true;
  let focused: HTMLElement | null = null;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  t.mock.method(window.HTMLElement.prototype, 'focus', function (this: HTMLElement) { focused = this; });
  const globals: Record<string, unknown> = {
    window, document, Element: window.Element, HTMLElement: window.HTMLElement, location,
    navigator: { languages: ['en-US'], language: 'en-US' },
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 0, matchMedia: () => ({ matches: narrow }),
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
    const path = new URL(String(input), location).pathname;
    if (path === '/ui/api/snapshot') return Response.json({ time: new Date().toISOString(), modules: [], sessions: [], logs: [] });
    if (path === '/ui/api/agents') return Response.json({ agents: [], editable: true });
    assert.fail(`Unexpected drawer request: ${path}`);
  });
  const drawer = document.getElementById('navigation-drawer')! as unknown as HTMLDialogElement;
  Object.defineProperty(drawer, 'open', { get: () => drawer.hasAttribute('open') });
  drawer.showModal = () => drawer.setAttribute('open', '');
  drawer.close = () => { drawer.removeAttribute('open'); drawer.dispatchEvent(new window.Event('close')); };
  drawer.getBoundingClientRect = () => ({ left: 0, right: 280, top: 0, bottom: 812 }) as DOMRect;
  const sidebar = document.getElementById('primary-sidebar')! as unknown as HTMLElement;
  const toggle = document.getElementById('navigation-toggle')! as unknown as HTMLButtonElement;
  const close = document.getElementById('navigation-close')! as unknown as HTMLButtonElement;
  const settings = document.getElementById('settings-subnav')!;
  const current = sidebar.querySelector<HTMLElement>('[data-view="logs"]')!;
  authorizeUiFixture(t);
  await import('../src/ui-app.js');
  await settleUiFixture();

  assert.equal(sidebar.parentElement, drawer);
  assert.equal(drawer.open, false);
  assert.equal(settings.hidden, false, 'All settings pages are available directly in the drawer');
  toggle.click();
  assert.equal(drawer.open, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(focused, current, 'Opening focuses the active page');
  const slash = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(slash, 'key', { value: '/' });
  current.dispatchEvent(slash);
  assert.equal(slash.defaultPrevented, false, 'Background shortcuts do not run while navigation is modal');
  assert.equal(focused, current);

  const escape = new window.Event('cancel', { cancelable: true });
  drawer.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(drawer.open, false);
  assert.equal(focused, toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.click(); close.click();
  assert.equal(drawer.open, false); assert.equal(focused, toggle);

  toggle.click();
  const backdrop = new window.Event('click', { bubbles: true });
  Object.defineProperties(backdrop, { clientX: { value: 330 }, clientY: { value: 200 } });
  drawer.dispatchEvent(backdrop);
  assert.equal(drawer.open, false); assert.equal(focused, toggle);

  toggle.click(); current.click();
  assert.equal(drawer.open, false, 'Selecting the current route also closes the drawer');
  assert.equal(document.activeElement?.id, 'crumb-page');
  toggle.click();
  location.hash = '#/sessions'; window.dispatchEvent(new window.Event('hashchange'));
  assert.equal(drawer.open, false);
  assert.equal(document.getElementById('sessions-view')!.hidden, false);
  assert.equal(document.activeElement?.id, 'crumb-page');

  toggle.click(); narrow = false; window.dispatchEvent(new window.Event('resize'));
  assert.equal(drawer.open, false);
  assert.equal(sidebar.parentElement?.classList.contains('app'), true);
  assert.equal(settings.hidden, true);
  assert.equal(sidebar.nextElementSibling?.classList.contains('content'), true);
  assert.equal(sidebar.querySelector('[aria-current="page"]'), focused);
  narrow = true; window.dispatchEvent(new window.Event('resize'));
  assert.equal(sidebar.parentElement, drawer);
  assert.equal(settings.hidden, false);
  assert.equal(focused, toggle, 'Collapsing a focused desktop sidebar moves focus to the visible menu control');
  document.documentElement.setAttribute('data-nootify-desktop', 'macos');
  window.dispatchEvent(new window.Event('resize')); toggle.click();
  assert.equal(drawer.open, false, 'Native narrow windows retain the fixed sidebar');
  assert.equal(sidebar.parentElement?.classList.contains('app'), true);
  assert.equal(document.querySelectorAll('#primary-sidebar').length, 1);
});
